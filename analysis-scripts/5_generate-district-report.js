#!/usr/bin/env node

/**
 * 5_generate-district-report.js
 * 
 * Generates district-wise analysis reports with AI-powered insights.
 * Creates detailed Markdown reports for each district and question.
 * 
 * Output:
 * - reports/analysis_report.md (main consolidated report)
 * - debug/<District>/<Question>_batch_<n>.md (detailed analyses)
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const Papa = require("papaparse");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("./config");

// Import utilities
const logger = require("./utils/logger");
const { readCSV, writeCSV } = require("./utils/csv-handler");
const ProgressTracker = require("./utils/progress-tracker");
const APIManager = require("./utils/api-manager");

// ==================== CONFIGURATION ====================
const REPORT_CONFIG = {
  inputCsv: config.files.input,
  outputFile: "./reports/analysis_report.md",
  debugDir: "./debug",
  progressFile: "./report_progress.json",
  questionsConfigFile: "./analysis-scripts/questions-config.json",

  maxResponsesPerBatch: 1000,
  skipFailedBatches: true,

  // Question mappings loaded from config file
  questionMappings: {},
  districtColumn: "District",
};

/**
 * Load question mappings from questions-config.json
 * Maps to the format needed for district report generation
 */
function loadQuestionMappings() {
  const configPath = REPORT_CONFIG.questionsConfigFile;
  const fsSync = require('fs');

  if (!fsSync.existsSync(configPath)) {
    throw new Error(`Questions config file not found: ${configPath}`);
  }

  try {
    const configData = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
    const mappings = {};

    configData.questions.forEach((q) => {
      mappings[q.id.toUpperCase()] = {
        column: q.csv_column,
        analysisType: q.analysis_type || `Analysis of ${q.question_text}`,
        shortName: q.section || `Question ${q.id.toUpperCase()}`,
      };
    });

    return mappings;
  } catch (err) {
    throw new Error(`Failed to load questions config: ${err.message}`);
  }
}

// ==================== STATE & PROGRESS ====================
class ReportState {
  constructor() {
    this.processed = new Map();
    this.failed = new Set();
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
  }

  async load() {
    try {
      const raw = await fs.readFile(REPORT_CONFIG.progressFile, "utf8");
      const saved = JSON.parse(raw);
      this.processed = new Map(Object.entries(saved.processed || {}));
      this.failed = new Set(saved.failed || []);
      this.stats = { ...this.stats, ...saved.stats };
      await logger.info("Report progress loaded", {
        processed: this.processed.size,
        failed: this.failed.size,
      });
    } catch {
      await logger.info("No previous report progress found");
    }
  }

  async save() {
    await fs.writeFile(
      REPORT_CONFIG.progressFile,
      JSON.stringify(
        {
          processed: Object.fromEntries(this.processed),
          failed: [...this.failed],
          stats: this.stats,
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

  recordTokens(promptTokens, responseTokens) {
    const total = promptTokens + responseTokens;
    this.stats.totalTokensUsed += total;
    this.stats.totalPromptTokens += promptTokens;
    this.stats.totalResponseTokens += responseTokens;
  }
}

const state = new ReportState();
const apiManager = new APIManager();

// ==================== UTILITY FUNCTIONS ====================
function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function chunkArray(arr, size) {
  if (arr.length <= size) return [arr];
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function groupByDistrict(rows) {
  const out = {};
  for (const r of rows) {
    const d = (r[REPORT_CONFIG.districtColumn] || "").trim();
    if (!d) continue;
    (out[d] ||= []).push(r);
  }
  return out;
}

function getSanitizedShortName(shortName) {
  return shortName.replace(/[^a-z0-9]/gi, "_").slice(0, 50);
}

// ==================== PROMPT BUILDER ====================
function buildPromptJSON({ district, questionConfig, responses, batchIndex, totalBatches }) {
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

  const instruction = `You are a data analyst. Analyze the JSON payload containing ${responses.length} responses.

CRITICAL: You MUST process ALL ${responses.length} responses in this batch. No exceptions.

PRE-ANALYTICAL VERIFICATION:
1. Load the JSON payload
2. Count responses in the array
3. Verify count matches ${responses.length}
4. If mismatch, STOP and report the error

Task: Extract unique items for "${questionConfig.analysisType}", merge semantic duplicates, count mentions, include exactly 3 verbatim example responses per item (or fewer if less than 3 exist), exclude vague/meaningless comments, include singletons only if uniquely insightful, then add 3–5 key insights.

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

// ==================== GEMINI API CALL ====================
async function callGemini(prompt, meta) {
  const maxRetries = config.api.maxRetries;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await apiManager.checkRateLimit();
      await apiManager.ensureDelay();

      const genAI = new GoogleGenerativeAI(apiManager.getCurrentKey());
      const model = genAI.getGenerativeModel({ model: config.api.model });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Record token usage
      const usage = response.usageMetadata;
      if (usage) {
        const promptTokens = usage.promptTokenCount || 0;
        const responseTokens = usage.candidatesTokenCount || 0;
        apiManager.recordTokenUsage(promptTokens + responseTokens);
        state.recordTokens(promptTokens, responseTokens);
      }

      state.stats.totalApiCalls++;
      await logger.info(`✓ Gemini call successful (attempt ${attempt})`, {
        district: meta.district,
        question: meta.question,
        batch: meta.batch,
      });

      return text;
    } catch (e) {
      lastErr = e;
      state.stats.failedCalls++;

      if (e.message?.includes("429") || e.message?.includes("RESOURCE_EXHAUSTED")) {
        await logger.warn(`Rate limit hit, rotating key (attempt ${attempt}/${maxRetries})`);
        apiManager.rotateKey();
        await apiManager.sleep(5000 * attempt); // Exponential backoff
      } else {
        await logger.error(`Gemini call failed (attempt ${attempt}/${maxRetries})`, {
          error: e.message,
          meta,
        });
        await apiManager.sleep(config.api.retryDelay * attempt);
      }

      if (attempt < maxRetries) {
        state.stats.retriedCalls++;
      }
    }
  }

  const errMsg = `Gemini failed after ${maxRetries} attempts: ${lastErr?.message || "Unknown error"}`;
  await logger.error(errMsg, { meta });
  throw new Error(errMsg);
}

// ==================== REPORT GENERATION ====================
function startReportHeader(globalMeta) {
  const lines = [];
  lines.push("# School Improvement Analysis Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Total Districts:** ${globalMeta.totalDistricts}`);
  lines.push(`**Total Responses:** ${globalMeta.totalResponses}`);
  lines.push(`**Model:** ${config.api.model}`);
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
    lines.push(`**Responses Analyzed:** ${q.totalAnalyzed} ✓`);

    if (q.totalBatches > 1) {
      lines.push(`**Batches:** ${q.totalBatches}`);
    }

    if (q.skippedBatches > 0) {
      lines.push(`⚠️ **Skipped Batches:** ${q.skippedBatches}`);
    }

    lines.push("");

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
  lines.push(`- **Total Tokens Used:** ${stats.totalTokensUsed.toLocaleString()}`);
  lines.push(`  - Prompt Tokens: ${stats.totalPromptTokens.toLocaleString()}`);
  lines.push(`  - Response Tokens: ${stats.totalResponseTokens.toLocaleString()}`);
  lines.push(`- **API Keys Used:** ${apiManager.getKeyCount()}`);
  lines.push(`- **Processing Time:** ${minutes}m ${seconds}s`);
  lines.push(`- **Failed Calls (with retries):** ${stats.retriedCalls}`);
  lines.push(`- **Skipped Batches:** ${stats.skippedBatches}`);
  lines.push(`- **Districts Processed:** ${stats.districts}`);
  lines.push(`- **Questions Processed:** ${stats.questions}`);
  lines.push(`- **Batches Processed:** ${stats.batches}`);
  lines.push("");

  lines.push("### Token Usage by API Key");
  const tokenStats = apiManager.getTokenStats();
  Object.entries(tokenStats).forEach(([k, v]) => {
    lines.push(`- Key ${parseInt(k) + 1}: ${v.toLocaleString()} tokens`);
  });
  lines.push("");
}

// ==================== MAIN PROCESSING ====================
async function main() {
  console.log("🚀 Starting District-wise Report Generation...\n");

  await logger.init();
  await state.load();

  // Ensure output directories
  await fs.mkdir(path.dirname(REPORT_CONFIG.outputFile), { recursive: true });
  await fs.mkdir(REPORT_CONFIG.debugDir, { recursive: true });

  // Load question mappings from config
  console.log("⚙️  Loading questions configuration...");
  REPORT_CONFIG.questionMappings = loadQuestionMappings();
  console.log(`✓ Loaded ${Object.keys(REPORT_CONFIG.questionMappings).length} questions\n`);

  await logger.info("=== Report Generation Started ===", {
    inputCsv: REPORT_CONFIG.inputCsv,
    outputFile: REPORT_CONFIG.outputFile,
    model: config.api.model,
    apiKeys: apiManager.getKeyCount(),
    maxBatchSize: REPORT_CONFIG.maxResponsesPerBatch,
    questionsLoaded: Object.keys(REPORT_CONFIG.questionMappings).length,
  });

  // Read and parse CSV
  const rows = await readCSV(REPORT_CONFIG.inputCsv);
  const districts = groupByDistrict(rows);
  state.stats.districts = Object.keys(districts).length;

  const globalMeta = {
    totalDistricts: Object.keys(districts).length,
    totalResponses: rows.length,
  };

  const report = startReportHeader(globalMeta);

  // Process each district
  for (const [district, drows] of Object.entries(districts)) {
    await logger.info(`📍 Processing district: ${district} (${drows.length} responses)`);

    const districtSummary = {
      totalResponses: drows.length,
      questions: [],
    };

    // Process each question for this district
    for (const [questionKey, questionConfig] of Object.entries(REPORT_CONFIG.questionMappings)) {
      const columnName = questionConfig.column;
      
      // Check if column exists
      if (!drows[0] || !(columnName in drows[0])) {
        await logger.warn(`Column not found: ${columnName}`, { district, question: questionKey });
        districtSummary.questions.push({
          shortName: questionConfig.shortName,
          column: columnName,
          analysisType: questionConfig.analysisType,
          totalAnalyzed: 0,
          totalBatches: 0,
          skippedBatches: 0,
          analysis: ["*Column not found in CSV*"],
        });
        continue;
      }

      // Extract responses
      const responses = drows
        .map((r) => (r[columnName] || "").trim())
        .filter(Boolean);

      if (responses.length === 0) {
        districtSummary.questions.push({
          shortName: questionConfig.shortName,
          column: columnName,
          analysisType: questionConfig.analysisType,
          totalAnalyzed: 0,
          totalBatches: 0,
          skippedBatches: 0,
          analysis: ["*No responses to analyze*"],
        });
        continue;
      }

      // Chunk responses into batches
      const batches = chunkArray(responses, REPORT_CONFIG.maxResponsesPerBatch);
      const analyses = [];
      let totalAnalyzed = 0;
      let skippedBatches = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        
        // Check if already processed
        if (state.isProcessed(district, questionConfig.shortName, batchIndex)) {
          await logger.info(`⏭️  Skipping already processed batch`, {
            district,
            question: questionConfig.shortName,
            batch: batchIndex + 1,
          });
          
          // Try to load from debug file
          const debugFile = path.join(
            REPORT_CONFIG.debugDir,
            district,
            `${getSanitizedShortName(questionConfig.shortName)}_batch_${batchIndex + 1}.md`
          );
          try {
            const text = await fs.readFile(debugFile, "utf8");
            analyses.push(text);
            totalAnalyzed += batch.length;
          } catch {
            await logger.warn(`Debug file not found: ${debugFile}`);
          }
          continue;
        }

        // Check if previously failed
        if (state.isFailed(district, questionConfig.shortName, batchIndex)) {
          await logger.warn(`⏭️  Skipping previously failed batch`, {
            district,
            question: questionConfig.shortName,
            batch: batchIndex + 1,
          });
          skippedBatches++;
          continue;
        }

        try {
          await logger.info(`🔄 Processing batch ${batchIndex + 1}/${batches.length}`, {
            district,
            question: questionConfig.shortName,
            responses: batch.length,
          });

          const prompt = buildPromptJSON({
            district,
            questionConfig,
            responses: batch,
            batchIndex,
            totalBatches: batches.length,
          });

          const text = await callGemini(prompt, {
            district,
            question: questionConfig.shortName,
            batch: batchIndex + 1,
          });

          analyses.push(text);
          totalAnalyzed += batch.length;

          // Save debug file
          const debugDir = path.join(REPORT_CONFIG.debugDir, district);
          await fs.mkdir(debugDir, { recursive: true });
          const debugFile = path.join(
            debugDir,
            `${getSanitizedShortName(questionConfig.shortName)}_batch_${batchIndex + 1}.md`
          );
          await fs.writeFile(debugFile, text);

          // Mark as processed
          state.markProcessed(district, questionConfig.shortName, batchIndex, 0);
          state.stats.batches++;
          await state.save();

        } catch (error) {
          await logger.error(`Failed to process batch`, {
            district,
            question: questionConfig.shortName,
            batch: batchIndex + 1,
            error: error.message,
          });

          if (REPORT_CONFIG.skipFailedBatches) {
            state.markFailed(district, questionConfig.shortName, batchIndex);
            skippedBatches++;
            analyses.push(`*Batch ${batchIndex + 1} failed after retries*`);
          } else {
            throw error;
          }
        }
      }

      districtSummary.questions.push({
        shortName: questionConfig.shortName,
        column: columnName,
        analysisType: questionConfig.analysisType,
        totalAnalyzed,
        totalBatches: batches.length,
        skippedBatches,
        analysis: analyses,
      });

      state.stats.questions++;
    }

    appendDistrictSection(report, district, districtSummary);
  }

  // Add metrics
  appendMetrics(report, state.stats, apiManager.getTokenStats());

  // Write final report
  await fs.writeFile(REPORT_CONFIG.outputFile, report.join("\n"));
  await logger.info(`📝 Report written: ${REPORT_CONFIG.outputFile}`);

  // Clean up progress on full success
  if (state.stats.skippedBatches === 0) {
    try {
      await fs.unlink(REPORT_CONFIG.progressFile);
      await logger.info("✓ Progress file cleaned");
    } catch {}
  } else {
    await logger.warn(`⚠️  ${state.stats.skippedBatches} batches were skipped. Progress file retained.`);
  }

  console.log("\n✅ District-wise Report Generation Complete!");
  console.log(`📊 Report saved to: ${REPORT_CONFIG.outputFile}`);
  console.log(`📁 Debug files saved to: ${REPORT_CONFIG.debugDir}/`);
  
  await logger.info("=== Report Generation Complete ===", state.stats);
}

// ==================== ENTRY POINT ====================
if (require.main === module) {
  main().catch(async (e) => {
    await logger.error("💥 Fatal error", {
      message: e.message,
      stack: e.stack,
    });
    console.error("\n❌ Error:", e.message);
    process.exit(1);
  });
}

module.exports = { main, REPORT_CONFIG };
