// 1. IMPORT CHANGED: 'GoogleGenAI' from '@google/genai'
const { GoogleGenAI } = require("@google/genai");
const fs = require("fs").promises;
const Papa = require("papaparse");
const path = require("path");
require('dotenv').config();

// ===== CONFIGURATION =====
// Load API keys from environment variable as comma-separated string
const apiKeys = process.env.API_KEYS 
  ? process.env.API_KEYS.split(',').map(key => key.trim()).filter(key => key.length > 0)
  : [];

if (apiKeys.length === 0) {
  throw new Error("No API keys provided. Set the API_KEYS environment variable.");
}

// Load question columns from external JSON file for easy customization
const QUESTION_COLUMNS_PATH = path.join(__dirname, "questionColumns.json");
let questionColumns = {};
try {
  questionColumns = JSON.parse(require("fs").readFileSync(QUESTION_COLUMNS_PATH, "utf8"));
} catch (e) {
  throw new Error(`Failed to load question columns from ${QUESTION_COLUMNS_PATH}: ${e.message}`);
}

// Generate simplified question list for prompt (remove Q1. prefix)
function generateQuestionList() {
  const questions = [];
  for (const [qNum, fullQuestion] of Object.entries(questionColumns)) {
    // Remove the "Q1. " or "Q1: " prefix to get just the question text
    const questionText = fullQuestion.replace(/^Q\d+[.:]\s*/, '');
    questions.push(`${qNum}: ${questionText}`);
  }
  return questions.join('\n');
}

const CONFIG = {
  // API Keys - add multiple for automatic failover
  apiKeys,

  // File paths
  inputFile: "input.csv",
  outputFile: "output.csv",
  backupFile: "input_backup.csv", // Automatic backup
  progressFile: "progress.json",
  logFile: "processing.log",

  // Processing options
  startRow: 0, // Start from this row (0-indexed, useful for resuming)
  maxRows: null, // Process max N rows (null = all rows)

  // Columns to process (Q1-Q8)
  questionColumns,

  // Retry configuration
  maxRetries: 5,
  retryDelayMs: 1000, // Base delay between retries
  rateLimitDelayMs: 1000, // Wait 1 sec on rate limit since wer

  // API settings
  model: "gemini-flash-latest", // Fast and cost-effective
  temperature: 0.3, // Low temperature for consistent edits

  // Batch settings
  saveProgressEvery: 10, // Save progress every N rows
  logEvery: 5, // Log progress every N rows
  delayBetweenRows: 0, // Delay between processing rows (ms)
};

// ===== PROMPT TEMPLATE =====
const FULL_ROW_PROMPT_TEMPLATE = `You are a translation and editing assistant. A teacher has provided feedback responses originally given in Hindi and translated to English. Your task is to improve the clarity, grammar, and readability of ALL responses while maintaining the teacher's authentic voice and preserving all information.

**Context**: The same teacher answered these {{QUESTION_COUNT}} questions about changes in their school:
{{QUESTION_LIST}}

**Teacher's Original Responses**:
{{RESPONSES}}

** Acronyms & Full Forms (for consistent correction and expansion when needed):**
• **TLM** – Teaching Learning Material  
• **PTM** – Parent Teacher Meeting  
• **PBL** – Project-Based Learning  
• **B.Ed** – Bachelor of Education  
• **DIET** – District Institute of Education and Training  
• **HM** – Headmaster  
• **ICT** – Information and Communication Technology  

**Editing Rules:**
1. Preserve all original ideas and details exactly — do not add or remove information.  
2. Fix grammar, clarity, and mistranslations while keeping the intended meaning.  
3. Correct typos **and** known acronym errors where context clearly indicates a mistake.  
4. When expanding acronyms, **keep both the acronym and full form** (e.g., “TLM (Teaching Learning Material)”).  
5. For **PBL (Project-Based Learning)**:  
   - Normalize dynamically if the response contains a likely variant or misspelling (e.g., “PVL”, “BPL”, “TVL”, or any other similar form).  
   - Replace it with “PBL (Project-Based Learning)” while preserving the original mention if present.  
   - If the meaning is ambiguous, keep the original text unchanged.  
6. Break long or run-on sentences into short, clear sentences.  
7. Maintain the teacher’s authentic tone and phrasing across all responses.  
8. Ensure terminology consistency across all answers (e.g., if they use “Bal” or “TLM” in one answer, use the same spelling elsewhere).  
9. Keep educational and institutional terms uniform (Project-Based Learning, NCERT, parent meetings, activity-based learning).  
10. Retain all details about challenges, needs, and support mentioned.  
11. Use simple, natural English — not overly formal.  
12. If multiple distinct ideas appear in one response, format them as bullet points.  
13. Keep unclear acronyms or local terms as-is if meaning cannot be confidently inferred, but ensure readability.  
14. Correct obvious factual or numeric errors (e.g., “306 months” → “3–6 months”).  
15. Maintain logical continuity between related questions (e.g., “this change” in Q4 refers to the change described in Q2).  
16. If a response is empty, under 10 characters, or just whitespace, return it unchanged or as an empty string.  

Return ONLY the improved responses in the exact JSON format specified, with no meta-commentary or additional text.`;

// Generate the full prompt with dynamic question list
const FULL_ROW_PROMPT = FULL_ROW_PROMPT_TEMPLATE
  .replace('{{QUESTION_COUNT}}', Object.keys(questionColumns).length)
  .replace('{{QUESTION_LIST}}', generateQuestionList());

// ===== JSON SCHEMA FOR GEMINI =====
// 2. SCHEMA CHANGED: 'SchemaType.OBJECT' is now just the string "OBJECT", etc.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    Q1: {
      type: "string",
      nullable: true,
    },
    Q2: {
      type: "string",
      nullable: true,
    },
    Q3: {
      type: "string",
      nullable: true,
    },
    Q4: {
      type: "string",
      nullable: true,
    },
    Q5: {
      type: "string",
      nullable: true,
    },
    Q6: {
      type: "string",
      nullable: true,
    },
    Q7: {
      type: "string",
      nullable: true,
    },
    Q8: {
      type: "string",
      nullable: true,
    },
  },
  required: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"],
};

// ===== UTILITY FUNCTIONS =====
class Logger {
  static async log(message, level = "INFO") {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    await fs.appendFile(CONFIG.logFile, logMessage).catch(() => {});
  }

  static async error(message, error) {
    await this.log(`${message}: ${error.message}`, "ERROR");
    if (error.stack) {
      await this.log(error.stack, "ERROR");
    }
  }
}

class ProgressManager {
  constructor() {
    this.progress = {
      currentRow: CONFIG.startRow,
      processedRows: 0,
      skippedRows: 0,
      errorRows: [],
      currentApiKeyIndex: 0,
      totalTokensUsed: 0,
      startTime: new Date().toISOString(),
    };
  }

  async load() {
    try {
      const data = await fs.readFile(CONFIG.progressFile, "utf8");
      this.progress = JSON.parse(data);
      await Logger.log(
        `Loaded progress: Row ${this.progress.currentRow}, Processed: ${this.progress.processedRows}`
      );
    } catch (error) {
      await Logger.log("No previous progress found, starting fresh");
    }
  }

  async save() {
    await fs.writeFile(
      CONFIG.progressFile,
      JSON.stringify(this.progress, null, 2)
    );
  }

  update(updates) {
    Object.assign(this.progress, updates);
  }
}

// ===== GEMINI API HANDLER =====
class GeminiProcessor {
  constructor(apiKeys) {
    this.apiKeys = apiKeys;
    this.currentKeyIndex = 0;
    this.genAI = null;
    // 3. 'this.model' removed from constructor
    this.initializeAPI();
  }

  initializeAPI() {
    // 4. INITIALIZATION CHANGED: API key is now in an object
    this.genAI = new GoogleGenAI({
      apiKey: this.apiKeys[this.currentKeyIndex],
    });

    // 4. 'this.model' initialization removed.
    //    The API is now stateless; config is sent with each call.
    Logger.log(
      `Using API key ${this.currentKeyIndex + 1}/${this.apiKeys.length}`
    );
  }

  switchToNextKey() {
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    this.initializeAPI();
    Logger.log(
      `Switched to API key ${this.currentKeyIndex + 1}/${this.apiKeys.length}`
    );
  }

  buildResponsesText(row) {
    const responses = [];
    for (const [qNum, colName] of Object.entries(CONFIG.questionColumns)) {
      const answer = row[colName] || "";
      responses.push(`${qNum}: ${answer.trim() || "(empty)"}`);
    }
    return responses.join("\n\n");
  }

  async processRow(row, retryCount = 0) {
    const responsesText = this.buildResponsesText(row);

    // Skip if all responses are empty
    const hasContent = Object.values(CONFIG.questionColumns).some(
      (col) => row[col] && row[col].trim().length > 10
    );

    if (!hasContent) {
      await Logger.log("⊘ Skipping row - all responses empty or too short");
      return null;
    }

    const prompt = FULL_ROW_PROMPT.replace("{{RESPONSES}}", responsesText);

    try {
      // 5. API CALL CHANGED: Using 'this.genAI.models.generateContent'
      //    All config (model, contents, generationConfig) is passed in one object.
      const response = await this.genAI.models.generateContent({
        model: CONFIG.model,
        contents: prompt,
        config: {
          temperature: CONFIG.temperature,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      // 6. RESPONSE HANDLING CHANGED: Simplified to 'response.text'
      const jsonText = response.text.trim();
      // Parse JSON response
      const improvedResponses = JSON.parse(jsonText);

      // Validate we got all questions back
      const expectedKeys = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"];
      const missingKeys = expectedKeys.filter(
        (key) => !(key in improvedResponses)
      );

      if (missingKeys.length > 0) {
        throw new Error(`Missing keys in response: ${missingKeys.join(", ")}`);
      }

      // Basic validation - check if responses are reasonable length
      for (const [qNum, colName] of Object.entries(CONFIG.questionColumns)) {
        const original = row[colName] || "";
        const improved = improvedResponses[qNum] || "";

        // If original had content but improved is empty, that's suspicious
        if (original.trim().length > 20 && improved.trim().length < 10) {
          await Logger.log(
            `  ⚠️ Warning: ${qNum} response significantly shortened`,
            "WARN"
          );
        }
      }

      return improvedResponses;
    } catch (error) {
      // Handle rate limiting
      if (
        error.message.includes("429") ||
        error.message.includes("rate limit")
      ) {
        await Logger.log(
          `Rate limit hit, waiting ${CONFIG.rateLimitDelayMs / 1000}s...`,
          "WARN"
        );
        await this.sleep(CONFIG.rateLimitDelayMs);

        // Try switching API key
        if (this.apiKeys.length > 1) {
          this.switchToNextKey();
        }

        if (retryCount < CONFIG.maxRetries) {
          return this.processRow(row, retryCount + 1);
        }
      }

      // Handle quota exceeded
      if (
        error.message.includes("quota") ||
        error.message.includes("exhausted")
      ) {
        await Logger.log("API quota exhausted", "ERROR");

        if (
          this.apiKeys.length > 1 &&
          this.currentKeyIndex < this.apiKeys.length - 1
        ) {
          this.switchToNextKey();
          return this.processRow(row, retryCount);
        } else {
          throw new Error("All API keys exhausted");
        }
      }

      // Handle JSON parsing errors
      if (error instanceof SyntaxError) {
        await Logger.log(`JSON parse error: ${error.message}`, "ERROR");
        if (retryCount < CONFIG.maxRetries) {
          await this.sleep(CONFIG.retryDelayMs);
          return this.processRow(row, retryCount + 1);
        }
      }

      // General retry logic
      if (retryCount < CONFIG.maxRetries) {
        const delay = CONFIG.retryDelayMs * Math.pow(2, retryCount);
        await Logger.log(
          `Retry ${retryCount + 1}/${CONFIG.maxRetries} after ${delay}ms`,
          "WARN"
        );
        await this.sleep(delay);
        return this.processRow(row, retryCount + 1);
      }

      throw error;
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ===== MAIN PROCESSOR =====
async function processCSV() {
  await Logger.log(
    "=== Starting CSV Grammar Improvement (Full Row Processing) ==="
  );
  await Logger.log(
    `Config: Model=${CONFIG.model}, StartRow=${CONFIG.startRow}, MaxRows=${
      CONFIG.maxRows || "ALL"
    }`
  );

  // Initialize
  const progressManager = new ProgressManager();
  await progressManager.load();

  const processor = new GeminiProcessor(CONFIG.apiKeys);

  // Read CSV
  await Logger.log(`Reading CSV from ${CONFIG.inputFile}...`);
  const csvContent = await fs.readFile(CONFIG.inputFile, "utf8");
  const { data: rows } = Papa.parse(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  await Logger.log(`Total rows in CSV: ${rows.length}`);

  // Create backup
  if (CONFIG.startRow === 0) {
    await fs.copyFile(CONFIG.inputFile, CONFIG.backupFile);
    await Logger.log(`✓ Backup created: ${CONFIG.backupFile}`);
  }

  // Determine rows to process
  const startIdx = progressManager.progress.currentRow;
  const endIdx = CONFIG.maxRows
    ? Math.min(startIdx + CONFIG.maxRows, rows.length)
    : rows.length;

  await Logger.log(`Processing rows ${startIdx} to ${endIdx - 1}`);

  // Process rows
  for (let i = startIdx; i < endIdx; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    try {
      await Logger.log(
        `\n--- Processing Row ${rowNum}/${rows.length} (ID: ${
          row.id || "N/A"
        }, District: ${row.District || "N/A"}) ---`
      );

      const improvedResponses = await processor.processRow(row);

      if (improvedResponses === null) {
        progressManager.update({
          skippedRows: progressManager.progress.skippedRows + 1,
        });
      } else {
        // Update row with improved responses
        for (const [qNum, colName] of Object.entries(CONFIG.questionColumns)) {
          if (improvedResponses[qNum]) {
            row[colName] = improvedResponses[qNum];
          }
        }

        await Logger.log(`  ✓ Row ${rowNum} processed successfully`);

        progressManager.update({
          processedRows: progressManager.progress.processedRows + 1,
        });
      }

      progressManager.update({
        currentRow: i + 1,
      });

      // Save progress periodically
      if ((i - startIdx + 1) % CONFIG.saveProgressEvery === 0) {
        await saveOutput(rows);
        await progressManager.save();
        await Logger.log(
          `  💾 Progress saved (${i - startIdx + 1} rows completed)`
        );
      }

      // Log stats periodically
      if ((i - startIdx + 1) % CONFIG.logEvery === 0) {
        const percentComplete = (
          ((i - startIdx + 1) / (endIdx - startIdx)) *
          100
        ).toFixed(1);
        const avgTimePerRow =
          (Date.now() - new Date(progressManager.progress.startTime)) /
          (i - startIdx + 1);
        const estimatedRemaining =
          (avgTimePerRow * (endIdx - i - 1)) / 1000 / 60;

        await Logger.log(
          `  📊 Progress: ${percentComplete}% | Processed: ${
            progressManager.progress.processedRows
          } | Skipped: ${
            progressManager.progress.skippedRows
          } | ETA: ${estimatedRemaining.toFixed(1)}min`
        );
      }

      // Delay between rows to avoid rate limiting
      await processor.sleep(CONFIG.delayBetweenRows);
    } catch (error) {
      await Logger.error(`Error processing row ${rowNum}`, error);
      progressManager.progress.errorRows.push({
        row: rowNum,
        id: row.id,
        district: row.District,
        error: error.message,
      });

      if (error.message.includes("All API keys exhausted")) {
        await Logger.log(
          "All API keys exhausted, stopping processing",
          "ERROR"
        );
        break;
      }
    }
  }

  // Final save
  await saveOutput(rows);
  await progressManager.save();

  // Summary
  await Logger.log("\n=== Processing Complete ===");
  await Logger.log(
    `Total processed: ${progressManager.progress.processedRows}`
  );
  await Logger.log(`Total skipped: ${progressManager.progress.skippedRows}`);
  await Logger.log(`Errors: ${progressManager.progress.errorRows.length}`);
  await Logger.log(`Output saved to: ${CONFIG.outputFile}`);
  await Logger.log(`Original backup: ${CONFIG.backupFile}`);

  if (progressManager.progress.errorRows.length > 0) {
    await Logger.log("\n⚠️  Rows with errors:");
    for (const err of progressManager.progress.errorRows) {
      await Logger.log(
        `  - Row ${err.row} (ID: ${err.id}, District: ${err.district}): ${err.error}`
      );
    }
  }

  // Calculate statistics
  const totalTime =
    (Date.now() - new Date(progressManager.progress.startTime)) / 1000 / 60;
  await Logger.log(`\n⏱️  Total time: ${totalTime.toFixed(2)} minutes`);
  if (progressManager.progress.processedRows > 0) {
    await Logger.log(
      `📈 Average: ${(
        totalTime / progressManager.progress.processedRows
      ).toFixed(2)} min/row`
    );
  }
}

async function saveOutput(rows) {
  const csv = Papa.unparse(rows);
  await fs.writeFile(CONFIG.outputFile, csv);
}

// ===== RUN =====
processCSV().catch(async (error) => {
  await Logger.error("Fatal error", error);
  process.exit(1);
});
