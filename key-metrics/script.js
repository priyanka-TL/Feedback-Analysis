// process.js
// Node 18+. Outputs a single Markdown report at ./reports/analysis_report.md

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const Papa = require("papaparse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const CONFIG = {
  inputCsv: "./input.csv",
  outputFile: "./reports/analysis_report.md",
  logDir: "./logs",
  debugDir: "./debug",
  progressFile: "./progress.json",

  geminiApiKeys: [

  ],

  model: "gemini-2.5-flash",
  maxRetries: 5,
  retryDelayMs: 2000,
  requestDelayMs: 1000,
  maxResponsesPerBatch: 1000,

  tokensPerMinute: 2500000, // Gemini Flash 1.5 limit
  tokenBuffer: 0.85, // Use 85% of limit to be safe

  // Skip batches that fail after all retries instead of crashing
  skipFailedBatches: true,

  questionMappings: {
    "Q1. In the last 6 to 12 months, what do you think are some important changes in your school? These can be in students, teachers, parents or the school in general.":
      {
        column:
          "Q1. In the last 6 to 12 months, what do you think are some important changes in your school? These can be in students, teachers, parents or the school in general.",
        analysisType: "List of improvements",
        shortName: "Changes in Last 6-12 Months",
      },
    "Q3. How did you get the idea to make this change?": {
      column: "Q3. How did you get the idea to make this change?",
      analysisType: "List of reasons/motivations behind improvements",
      shortName: "Ideas and Motivations",
    },
    "Q5: What helped you make this change in your school?": {
      column: "Q5: What helped you make this change in your school?",
      analysisType: "List of things that helped",
      shortName: "Enabling Factors",
    },
    "Q6: What are some challenges you face while making  changes in schools?": {
      column:
        "Q6: What are some challenges you face while making  changes in schools?",
      analysisType: "List of challenges",
      shortName: "Challenges Faced",
    },
    "Q7: What are some other changes you are planning in your school in next 3-6 months?":
      {
        column:
          "Q7: What are some other changes you are planning in your school in next 3-6 months?",
        analysisType: "List of planned improvements",
        shortName: "Future Plans (3-6 months)",
      },
    "Q8: What support do you need to make changes in school?": {
      column: "Q8: What support do you need to make changes in school?",
      analysisType: "List of support required",
      shortName: "Support Needed",
    },
  },
  districtColumn: "District",
};

// ==================== STATE & LOGGING ====================
class Logger {
  constructor() {
    this.logFile = null;
  }
  async init() {
    await fs.mkdir(CONFIG.logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(CONFIG.logDir, `run_${ts}.log`);
  }
  async log(level, msg, data) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(data ? `${line}\n${JSON.stringify(data, null, 2)}` : line);
    if (this.logFile) {
      await fs.appendFile(
        this.logFile,
        data ? `${line}\n${JSON.stringify(data, null, 2)}\n` : `${line}\n`
      );
    }
  }
  info(m, d) {
    return this.log("INFO", m, d);
  }
  warn(m, d) {
    return this.log("WARN", m, d);
  }
  error(m, d) {
    return this.log("ERROR", m, d);
  }
  debug(m, d) {
    return this.log("DEBUG", m, d);
  }
}
const logger = new Logger();

class ProcessState {
  constructor() {
    this.currentKeyIndex = 0;
    this.tokenUsagePerKey = {};
    this.processed = new Map(); // key -> { tokens, timestamp }
    this.failed = new Set(); // batches that failed after all retries
    this.stats = {
      totalApiCalls: 0,
      totalTokensUsed: 0,
      totalPromptTokens: 0,
      totalResponseTokens: 0,
      failedCalls: 0,
      retriedCalls: 0,
      skippedBatches: 0,
      startTime: Date.now(),
      districts: 0,
      questions: 0,
      batches: 0,
    };
    this.lastRequestTime = 0;
    this.keyResetTimes = {}; // Track when each key's rate limit window resets
  }

  async load() {
    try {
      const raw = await fs.readFile(CONFIG.progressFile, "utf8");
      const saved = JSON.parse(raw);
      this.currentKeyIndex = saved.currentKeyIndex || 0;
      this.tokenUsagePerKey = saved.tokenUsagePerKey || {};
      this.processed = new Map(Object.entries(saved.processed || {}));
      this.failed = new Set(saved.failed || []);
      this.stats = { ...this.stats, ...saved.stats };
      this.keyResetTimes = saved.keyResetTimes || {};
      await logger.info("Progress loaded", {
        processed: this.processed.size,
        failed: this.failed.size,
      });
    } catch {
      await logger.info("No previous progress");
    }
  }

  async save() {
    await fs.writeFile(
      CONFIG.progressFile,
      JSON.stringify(
        {
          currentKeyIndex: this.currentKeyIndex,
          tokenUsagePerKey: this.tokenUsagePerKey,
          processed: Object.fromEntries(this.processed),
          failed: [...this.failed],
          stats: this.stats,
          keyResetTimes: this.keyResetTimes,
        },
        null,
        2
      )
    );
  }

  getProcessKey(d, q, b) {
    return `${d}::${q}::${b}`;
  }

  markProcessed(d, q, b, tokens) {
    const key = this.getProcessKey(d, q, b);
    this.processed.set(key, { tokens, timestamp: Date.now() });
  }

  isProcessed(d, q, b) {
    return this.processed.has(this.getProcessKey(d, q, b));
  }

  markFailed(d, q, b) {
    this.failed.add(this.getProcessKey(d, q, b));
    this.stats.skippedBatches++;
  }

  isFailed(d, q, b) {
    return this.failed.has(this.getProcessKey(d, q, b));
  }

  getKey() {
    return CONFIG.geminiApiKeys[this.currentKeyIndex];
  }

  async checkRateLimit() {
    const now = Date.now();
    const keyId = this.currentKeyIndex;
    const resetTime = this.keyResetTimes[keyId] || 0;

    // Reset counter if a minute has passed
    if (now - resetTime >= 60000) {
      this.tokenUsagePerKey[keyId] = 0;
      this.keyResetTimes[keyId] = now;
      return true;
    }

    const used = this.tokenUsagePerKey[keyId] || 0;
    const limit = CONFIG.tokensPerMinute * CONFIG.tokenBuffer;

    if (used >= limit) {
      const waitMs = 60000 - (now - resetTime);
      await logger.warn(
        `Rate limit approaching for key ${keyId + 1}, waiting ${Math.ceil(
          waitMs / 1000
        )}s`
      );
      await sleep(waitMs + 1000); // Wait plus buffer
      this.tokenUsagePerKey[keyId] = 0;
      this.keyResetTimes[keyId] = Date.now();
    }

    return true;
  }

  rotateKey() {
    this.currentKeyIndex =
      (this.currentKeyIndex + 1) % CONFIG.geminiApiKeys.length;
    return this.currentKeyIndex;
  }

  recordTokens(promptTokens, responseTokens) {
    const k = this.currentKeyIndex;
    const total = promptTokens + responseTokens;

    this.tokenUsagePerKey[k] = (this.tokenUsagePerKey[k] || 0) + total;
    this.stats.totalTokensUsed += total;
    this.stats.totalPromptTokens += promptTokens;
    this.stats.totalResponseTokens += responseTokens;
  }
}
const state = new ProcessState();

// ==================== UTILS ====================
function countTokens(text) {
  // More accurate token counting for Gemini
  // Gemini uses ~4 chars per token on average, but we'll be more conservative
  const chars = text.length;
  const words = text.split(/\s+/).length;
  const lines = text.split("\n").length;

  // Weighted estimate: average of character-based and word-based counting
  const charBased = Math.ceil(chars / 3.5);
  const wordBased = Math.ceil(words * 1.3);

  return Math.ceil((charBased + wordBased) / 2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDirs() {
  await fs.mkdir(path.dirname(CONFIG.outputFile), { recursive: true });
  await fs.mkdir(CONFIG.logDir, { recursive: true });
  await fs.mkdir(CONFIG.debugDir, { recursive: true });
}

async function readCsv(fp) {
  const raw = await fs.readFile(fp, "utf8");
  return new Promise((resolve, reject) => {
    Papa.parse(raw, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      transformHeader: (h) => h.trim(),
      complete: (res) => resolve(res.data),
      error: reject,
    });
  });
}

function validateCsvStructure(rows) {
  if (!rows.length) {
    throw new Error("CSV is empty");
  }

  const headers = Object.keys(rows[0]);
  const missing = [];

  // Check district column
  if (!headers.includes(CONFIG.districtColumn)) {
    missing.push(CONFIG.districtColumn);
  }

  // Check question columns
  for (const [, config] of Object.entries(CONFIG.questionMappings)) {
    if (!headers.includes(config.column)) {
      missing.push(config.column);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(", ")}`);
  }

  return true;
}

function groupByDistrict(rows) {
  const out = {};
  for (const r of rows) {
    const d = (r[CONFIG.districtColumn] || "").trim();
    if (!d) continue;
    (out[d] ||= []).push(r);
  }
  return out;
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function chunkArray(arr, size) {
  if (arr.length <= size) return [arr];
  const chunks = [];
  for (let i = 0; i < arr.length; i += size)
    chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ==================== PROMPT BUILDER ====================
function buildPromptJSON({
  district,
  questionConfig,
  responses,
  batchIndex,
  totalBatches,
}) {
  const payload = {
    district,
    question: questionConfig.shortName,
    analysisType: questionConfig.analysisType,
    column: questionConfig.column,
    batchIndex,
    totalBatches,
    responseCount: responses.length,
    responses,
    dataset_hash: sha256(JSON.stringify(responses)),
  };

  const instruction = `You are a data analyst. Analyze the JSON payload containing ${
    responses.length
  } responses.

CRITICAL: You MUST process ALL ${
    responses.length
  } responses in this batch. No exceptions.

PRE-ANALYTICAL VERIFICATION:
1. Load the JSON payload
2. Count responses in the array
3. Verify count matches ${responses.length}
4. If mismatch, STOP and report the error

Task: Extract unique items for "${
    questionConfig.analysisType
  }", merge semantic duplicates, count mentions, include exactly 3 verbatim example responses per item (or fewer if less than 3 exist), exclude vague/meaningless comments, include singletons only if uniquely insightful, then add 3–5 key insights.

Output format:

**VERIFICATION: Loaded ${responses.length} responses for analysis**

- **Item:** <summary>
  **Count:** <number>
  **Example Responses:**
  1. "..."
  2. "..."
  3. "..."

(Repeat for all items)

### KEY INSIGHTS
- <Insight 1>
- <Insight 2>
- <Insight 3>
- <Insight 4>
- <Insight 5>

**COMPLETION CONFIRMATION:**
Processed: ${responses.length} | Batch ${batchIndex + 1}/${totalBatches}
✓ Analysis complete: ${responses.length} responses processed.

JSON PAYLOAD:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
`;

  return instruction;
}

function validateResponse(text, expectedCount, batchInfo) {
  const warnings = [];
  let valid = true;

  // Check completion markers
  if (!/Analysis complete/i.test(text)) {
    warnings.push("Missing 'Analysis complete' marker");
    valid = false;
  }

  if (!/responses processed/i.test(text)) {
    warnings.push("Missing 'responses processed' marker");
    valid = false;
  }

  // Extract processed count
  const processedMatch = text.match(/Processed:\s*(\d+)/i);
  const completedMatch = text.match(/(\d+)\s+responses processed/i);

  const processedCount = processedMatch ? parseInt(processedMatch[1]) : 0;
  const completedCount = completedMatch ? parseInt(completedMatch[1]) : 0;

  if (processedCount !== expectedCount) {
    warnings.push(
      `Processed count mismatch: expected ${expectedCount}, got ${processedCount}`
    );
    valid = false;
  }

  if (completedCount !== expectedCount) {
    warnings.push(
      `Completed count mismatch: expected ${expectedCount}, got ${completedCount}`
    );
    valid = false;
  }

  // Check structure
  if (!/KEY INSIGHTS/i.test(text)) {
    warnings.push("Missing KEY INSIGHTS section");
  }

  const items = (text.match(/\*\*Item:\*\*/g) || []).length;
  const examples = (text.match(/Example Responses:/gi) || []).length;

  if (items < 2 && expectedCount >= 20) {
    warnings.push(
      `Very few items found (${items}) for ${expectedCount} responses`
    );
  }

  if (examples < items) {
    warnings.push(
      `Missing examples: ${items} items but only ${examples} example sections`
    );
  }

  return {
    valid,
    warnings,
    items,
    examples,
    processedCount,
    completedCount,
  };
}

// ==================== GEMINI CALL ====================
async function callGemini(prompt, meta) {
  let lastErr = null;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      // Rate limit check
      await state.checkRateLimit();

      // Request pacing
      const since = Date.now() - state.lastRequestTime;
      if (since < CONFIG.requestDelayMs) {
        await sleep(CONFIG.requestDelayMs - since);
      }

      const promptTokens = countTokens(prompt);

      const genAI = new GoogleGenerativeAI(state.getKey());
      const model = genAI.getGenerativeModel({
        model: CONFIG.model,
        generationConfig: {
          temperature: 0.3, // Lower temperature for more consistent analysis
          //maxOutputTokens: 8000,
        },
      });

      await logger.debug("Calling Gemini", {
        attempt,
        promptTokens,
        keyIndex: state.currentKeyIndex + 1,
      });

      const res = await model.generateContent(prompt);
      console.log("Gemini response received", res.response);
      const candidate = res.response.candidates?.[0];

      if (!candidate) {
        throw new Error("No candidate in response");
      }

      // Get text with error handling
      let text;
      try {
        text = res.response.text();
      } catch (textError) {
        // Fallback: try to extract text from candidate directly
        text = candidate.content?.parts?.[0]?.text;
        if (!text) {
          throw new Error(
            `Failed to extract text from response: ${textError.message}`
          );
        }
        await logger.warn("Used fallback text extraction", {
          reason: textError.message,
        });
      }

      if (!text || text.trim().length === 0) {
        throw new Error("Empty response text received from Gemini");
      }

      const responseTokens = countTokens(text);

      state.lastRequestTime = Date.now();
      state.stats.totalApiCalls++;
      state.recordTokens(promptTokens, responseTokens);

      await logger.debug("Gemini success", {
        promptTokens,
        responseTokens,
        totalTokens: promptTokens + responseTokens,
        responseLength: text.length,
      });

      return { text, promptTokens, responseTokens };
    } catch (e) {
      lastErr = e;
      state.stats.failedCalls++;
      const msg = e?.message || String(e);
      const code = e?.code || e?.status;

      await logger.warn(
        `Gemini error attempt ${attempt}/${CONFIG.maxRetries}`,
        {
          error: msg,
          code,
          district: meta.district,
          question: meta.question,
          batch: meta.batchIndex,
        }
      );

      // Handle rate limits
      if (
        /quota|rate limit|429|RESOURCE_EXHAUSTED/i.test(msg) ||
        code === 429
      ) {
        const oldKey = state.currentKeyIndex;
        state.rotateKey();
        await logger.warn(
          `Rotated from key ${oldKey + 1} to ${state.currentKeyIndex + 1}`
        );
      }

      // Retry with exponential backoff
      if (attempt < CONFIG.maxRetries) {
        const delay = CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
        state.stats.retriedCalls++;
        await logger.info(
          `Retrying in ${delay}ms (attempt ${attempt + 1}/${CONFIG.maxRetries})`
        );
        await sleep(delay);
      }
    }
  }

  const errMsg = `Gemini failed after ${CONFIG.maxRetries} attempts: ${
    lastErr?.message || "Unknown error"
  }`;
  await logger.error(errMsg, { meta });
  throw new Error(errMsg);
}

// ==================== REPORT AGGREGATION ====================
function startReportHeader(globalMeta) {
  const lines = [];
  lines.push("# School Improvement Analysis Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Total Districts:** ${globalMeta.totalDistricts}`);
  lines.push(`**Total Responses:** ${globalMeta.totalResponses}`);
  lines.push(`**Model:** ${CONFIG.model}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines;
}

function appendDistrictSection(lines, district, districtSummary) {
  lines.push(`## District: ${district}`);
  lines.push(`**Total Responses:** ${districtSummary.totalResponses}`);
  lines.push("");

  for (const q of districtSummary.questions) {
    lines.push(`### ${q.shortName}`);
    lines.push(`**Column:** ${q.column}`);
    lines.push(`**Analysis Type:** ${q.analysisType}`);
    lines.push(`**Responses Analyzed:** ${q.totalAnalyzed}`);

    if (q.totalBatches > 1) {
      lines.push(`**Batches:** ${q.totalBatches}`);
    }

    if (q.skippedBatches > 0) {
      lines.push(
        `⚠️ **Skipped Batches:** ${q.skippedBatches} (failed after retries)`
      );
    }

    lines.push("");

    // Merge all batch analyses
    if (q.analysis.length > 0) {
      lines.push(q.analysis.join("\n\n"));
    } else {
      lines.push("*No analysis available*");
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }
}

function appendMetrics(lines, stats, tokenUsagePerKey) {
  const durMs = Date.now() - stats.startTime;
  const minutes = Math.floor(durMs / 60000);
  const seconds = Math.floor((durMs % 60000) / 1000);

  lines.push("## Processing Metrics");
  lines.push("");
  lines.push(`- **Total API Calls:** ${stats.totalApiCalls}`);
  lines.push(
    `- **Total Tokens Used:** ${stats.totalTokensUsed.toLocaleString()}`
  );
  lines.push(`  - Prompt Tokens: ${stats.totalPromptTokens.toLocaleString()}`);
  lines.push(
    `  - Response Tokens: ${stats.totalResponseTokens.toLocaleString()}`
  );
  lines.push(`- **API Keys Used:** ${Object.keys(tokenUsagePerKey).length}`);
  lines.push(`- **Processing Time:** ${minutes}m ${seconds}s`);
  lines.push(`- **Failed Calls (with retries):** ${stats.retriedCalls}`);
  lines.push(`- **Skipped Batches:** ${stats.skippedBatches}`);
  lines.push(`- **Districts Processed:** ${stats.districts}`);
  lines.push(`- **Questions Processed:** ${stats.questions}`);
  lines.push(`- **Batches Processed:** ${stats.batches}`);
  lines.push("");

  lines.push("### Token Usage by API Key");
  Object.entries(tokenUsagePerKey).forEach(([k, v]) => {
    lines.push(`- Key ${parseInt(k) + 1}: ${v.toLocaleString()} tokens`);
  });
  lines.push("");
}

// ==================== MAIN ====================
async function main() {
  if (!CONFIG.geminiApiKeys.length) {
    console.error("❌ No Gemini API keys configured.");
    process.exit(1);
  }

  await logger.init();
  await ensureDirs();
  await state.load();

  await logger.info("=== Processing Started ===", {
    inputCsv: CONFIG.inputCsv,
    outputFile: CONFIG.outputFile,
    model: CONFIG.model,
    apiKeys: CONFIG.geminiApiKeys.length,
    maxBatchSize: CONFIG.maxResponsesPerBatch,
  });

  const rows = await readCsv(CONFIG.inputCsv);
  validateCsvStructure(rows);

  const districts = groupByDistrict(rows);
  state.stats.districts = Object.keys(districts).length;

  const globalMeta = {
    totalDistricts: Object.keys(districts).length,
    totalResponses: rows.length,
  };

  const report = startReportHeader(globalMeta);

  for (const [district, drows] of Object.entries(districts)) {
    await logger.info(
      `📍 Processing district: ${district} (${drows.length} responses)`
    );

    const districtSummary = {
      totalResponses: drows.length,
      questions: [],
    };

    for (const [questionText, questionConfig] of Object.entries(
      CONFIG.questionMappings
    )) {
      const allResponses = drows
        .map((r) => (r[questionConfig.column] || "").trim())
        .filter(Boolean);

      if (!allResponses.length) {
        await logger.warn(
          `No responses for "${questionConfig.shortName}" in ${district}`
        );
        continue;
      }

      state.stats.questions++;

      const chunks = chunkArray(allResponses, CONFIG.maxResponsesPerBatch);
      const analyses = [];
      let totalAnalyzed = 0;
      let skippedBatches = 0;

      for (let i = 0; i < chunks.length; i++) {
        const batchKey = state.getProcessKey(
          district,
          questionConfig.shortName,
          i
        );

        // Skip if already processed successfully
        if (state.isProcessed(district, questionConfig.shortName, i)) {
          await logger.info(
            `✓ Skipping completed batch ${i + 1}/${chunks.length}`
          );

          try {
            const dbgDir = path.join(CONFIG.debugDir, district);
            const fname = `${questionConfig.shortName
              .replace(/[^a-z0-9]/gi, "_")
              .slice(0, 50)}_batch_${i + 1}.md`;
            const filePath = path.join(dbgDir, fname);
            const text = await fs.readFile(filePath, "utf8");

            analyses.push(text);

            const m = text.match(/Processed:\s*(\d+)/i);
            totalAnalyzed += m ? parseInt(m[1], 10) : chunks[i].length;
          } catch (err) {
            await logger.warn("Could not load cached batch file", {
              district,
              question: questionConfig.shortName,
              batch: i + 1,
              error: err.message,
            });
          }

          continue;
        }

        // Skip if previously failed
        if (state.isFailed(district, questionConfig.shortName, i)) {
          await logger.warn(
            `⚠️ Skipping previously failed batch ${i + 1}/${chunks.length}`
          );
          skippedBatches++;
          continue;
        }

        state.stats.batches++;
        const responses = chunks[i];

        // Clean and normalize responses
        const cleaned = responses.map((x) =>
          x.replace(/\s+/g, " ").trim().slice(0, 2000)
        );

        const prompt = buildPromptJSON({
          district,
          questionConfig,
          responses: cleaned,
          batchIndex: i,
          totalBatches: chunks.length,
        });

        try {
          const { text, promptTokens, responseTokens } = await callGemini(
            prompt,
            {
              district,
              question: questionConfig.shortName,
              batchIndex: i,
            }
          );

          // ALWAYS save debug file first, even if validation fails
          const dbgDir = path.join(CONFIG.debugDir, district);
          await fs.mkdir(dbgDir, { recursive: true });
          const fname = `${questionConfig.shortName
            .replace(/[^a-z0-9]/gi, "_")
            .slice(0, 50)}_batch_${i + 1}.md`;
          const debugPath = path.join(dbgDir, fname);
          await fs.writeFile(debugPath, text, "utf8");

          await logger.debug(`Debug file saved: ${debugPath}`, {
            size: text.length,
            lines: text.split("\n").length,
          });

          // Validate response (but continue regardless)
          const validation = validateResponse(text, cleaned.length, {
            district,
            question: questionConfig.shortName,
            batch: i + 1,
          });

          if (!validation.valid) {
            await logger.warn("⚠️ Response validation failed (but saved)", {
              district,
              question: questionConfig.shortName,
              batch: i + 1,
              expected: cleaned.length,
              validation,
              debugFile: debugPath,
            });
          }

          // Add to analyses regardless of validation
          analyses.push(text);
          totalAnalyzed += cleaned.length;

          state.markProcessed(
            district,
            questionConfig.shortName,
            i,
            promptTokens + responseTokens
          );
          await state.save();

          await logger.info(`✓ Completed batch ${i + 1}/${chunks.length}`, {
            responses: cleaned.length,
            tokens: promptTokens + responseTokens,
            validationPassed: validation.valid,
          });
        } catch (error) {
          await logger.error(
            `Failed batch ${i + 1}/${chunks.length} after all retries`,
            {
              district,
              question: questionConfig.shortName,
              error: error.message,
            }
          );

          if (CONFIG.skipFailedBatches) {
            state.markFailed(district, questionConfig.shortName, i);
            skippedBatches++;
            await state.save();
            await logger.warn(`⚠️ Marked batch as failed, continuing...`);
          } else {
            throw error;
          }
        }
      }

      districtSummary.questions.push({
        shortName: questionConfig.shortName,
        column: questionConfig.column,
        analysisType: questionConfig.analysisType,
        totalAnalyzed,
        totalBatches: chunks.length,
        skippedBatches,
        analysis: analyses,
      });

      await logger.info(`✓ Completed question: ${questionConfig.shortName}`, {
        batches: chunks.length,
        responses: allResponses.length,
        analyzed: totalAnalyzed,
        skipped: skippedBatches,
      });
    }

    appendDistrictSection(report, district, districtSummary);
  }

  appendMetrics(report, state.stats, state.tokenUsagePerKey);

  await fs.writeFile(CONFIG.outputFile, report.join("\n"));
  await logger.info(`📝 Report written: ${CONFIG.outputFile}`);

  // Clean progress on full success
  if (state.stats.skippedBatches === 0) {
    try {
      await fs.unlink(CONFIG.progressFile);
      await logger.info("✓ Progress file cleared (full success)");
    } catch {}
  } else {
    await logger.warn(
      `⚠️ ${state.stats.skippedBatches} batches were skipped. Progress file retained.`
    );
  }

  await logger.info("=== Processing Complete ===", state.stats);
}

if (require.main === module) {
  main().catch(async (e) => {
    await logger.error("💥 Fatal error", {
      message: e.message,
      stack: e.stack,
    });
    process.exit(1);
  });
}

module.exports = { main, CONFIG };
