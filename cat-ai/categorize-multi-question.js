const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const csv = require("csv-parser");
const { createObjectCsvWriter } = require("csv-writer");
const path = require("path");

// ==================== CONFIGURATION ====================
const CONFIG = {
  // API Keys - Add multiple keys for rotation
  GEMINI_API_KEYS: [],

  // File paths
  INPUT_CSV: "./input.csv",
  OUTPUT_CSV: "./output.csv",
  PROGRESS_FILE: "./progress.json",
  LOG_FILE: "./categorization.log",
  QUESTIONS_CONFIG: "./questions-config.json",

  // Processing configuration
  START_ROW: 0, // Start from row N (0-indexed)
  MAX_ROWS: null, // Process N rows (null = all)
  BATCH_SIZE: 10, // Save progress every N rows

  // API configuration
  MODEL_NAME: "gemini-flash-latest",
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY: 2000, // ms
  REQUEST_DELAY: 100, // Delay between requests (ms)

  // Column names
  ID_COLUMN: "id",
};

// ==================== QUESTIONS CONFIG ====================
let QUESTIONS_CONFIG = null;

function loadQuestionsConfig() {
  try {
    const configData = fs.readFileSync(CONFIG.QUESTIONS_CONFIG, "utf8");
    QUESTIONS_CONFIG = JSON.parse(configData);
    log(`Loaded ${QUESTIONS_CONFIG.questions.length} questions from config`);
    return QUESTIONS_CONFIG;
  } catch (error) {
    log(`Error loading questions config: ${error.message}`, "ERROR");
    throw error;
  }
}

// ==================== DYNAMIC SCHEMA BUILDER ====================
function buildCombinedResponseSchema() {
  const properties = {};
  const required = [];

  QUESTIONS_CONFIG.questions.forEach((question) => {
    const questionProperties = {};
    const questionRequired = [];

    question.response_fields.forEach((field) => {
      if (field.name === "reasoning") {
        // Skip reasoning here, we'll add it separately
        return;
      }

      if (field.type === "string") {
        questionProperties[field.name] = {
          type: "string",
          description: field.description,
        };
      } else if (field.type === "enum") {
        questionProperties[field.name] = {
          type: "string",
          description: field.description,
          enum: field.enum,
        };
      } else if (field.type === "array") {
        questionProperties[field.name] = {
          type: "array",
          items: { type: "string" },
          description: field.description,
        };
      } else if (field.type === "object") {
        questionProperties[field.name] = {
          type: "object",
          properties: field.properties || {},
          nullable: field.nullable || false,
        };
      }

      // Check if this field allows new categories
      if (field.allow_new_categories) {
        questionProperties[`${field.name}_new_category_suggestion`] = {
          type: "object",
          properties: {
            name: { type: "string" },
            justification: { type: "string" },
            similar_to_existing: { type: "string" },
          },
          nullable: true,
        };
      }

      questionRequired.push(field.name);
    });

    // Add reasoning field
    questionProperties.reasoning = {
      type: "string",
      description: "Brief reasoning for the categorization",
    };
    questionRequired.push("reasoning");

    properties[question.id] = {
      type: "object",
      properties: questionProperties,
      required: questionRequired,
    };

    required.push(question.id);
  });

  return {
    type: "object",
    properties,
    required,
  };
}

// ==================== STATE MANAGEMENT ====================
class ProcessingState {
  constructor() {
    this.currentApiKeyIndex = 0;
    this.processedRows = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.questionStats = {}; // Track stats per question
    this.discoveredCategories = {}; // Track per question per field
    this.apiKeySwitchCount = 0;
    this.startTime = Date.now();

    // Initialize per-question tracking
    if (QUESTIONS_CONFIG) {
      QUESTIONS_CONFIG.questions.forEach((q) => {
        this.questionStats[q.id] = {
          successCount: 0,
          errorCount: 0,
        };

        // Initialize per-field category tracking
        this.discoveredCategories[q.id] = {};
        q.response_fields.forEach((field) => {
          if (field.allow_new_categories) {
            this.discoveredCategories[q.id][field.name] = new Set();
          }
        });
      });
    }
  }

  switchToNextApiKey() {
    this.currentApiKeyIndex =
      (this.currentApiKeyIndex + 1) % CONFIG.GEMINI_API_KEYS.length;
    this.apiKeySwitchCount++;
    log(`Switched to API key #${this.currentApiKeyIndex + 1}`);
  }

  getCurrentApiKey() {
    return CONFIG.GEMINI_API_KEYS[this.currentApiKeyIndex];
  }

  addDiscoveredCategory(questionId, fieldName, category) {
    if (
      category &&
      this.discoveredCategories[questionId] &&
      this.discoveredCategories[questionId][fieldName] &&
      !this.discoveredCategories[questionId][fieldName].has(category)
    ) {
      this.discoveredCategories[questionId][fieldName].add(category);
      log(`[${questionId}.${fieldName}] New category discovered: ${category}`);
    }
  }

  getStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const questionStatsFormatted = {};

    Object.keys(this.questionStats).forEach((qId) => {
      const fieldCategories = {};
      Object.keys(this.discoveredCategories[qId] || {}).forEach((fieldName) => {
        fieldCategories[fieldName] = Array.from(
          this.discoveredCategories[qId][fieldName]
        );
      });

      questionStatsFormatted[qId] = {
        ...this.questionStats[qId],
        discoveredCategories: fieldCategories,
      };
    });

    return {
      processedRows: this.processedRows,
      totalSuccessCount: this.successCount,
      totalErrorCount: this.errorCount,
      apiKeySwitchCount: this.apiKeySwitchCount,
      elapsedTime: `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`,
      rowsPerMinute: ((this.processedRows / elapsed) * 60).toFixed(2),
      apiCallsPerRow: 1,
      questionStats: questionStatsFormatted,
    };
  }

  saveProgress(lastProcessedIndex) {
    const progress = {
      lastProcessedIndex,
      ...this.getStats(),
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(CONFIG.PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }

  static loadProgress() {
    try {
      if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG.PROGRESS_FILE, "utf8"));
      }
    } catch (err) {
      log(`Warning: Could not load progress file: ${err.message}`);
    }
    return null;
  }
}

// ==================== TEXT PREPROCESSING ====================
function preprocessResponse(text) {
  if (!text || text.trim() === "") return "";

  return (
    text
      // Remove HTML tags and entities
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      // Remove leading/trailing punctuation artifacts
      .replace(/^[,.\s]+|[,.\s]+$/g, "")
      .trim()
  );
}

// ==================== LOGGING ====================
function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(CONFIG.LOG_FILE, logMessage + "\n");
}

// ==================== GEMINI API WRAPPER ====================
class GeminiClient {
  constructor(state) {
    this.state = state;
    this.genAI = null;
    this.model = null;
    this.initializeClient();
  }

  initializeClient() {
    const apiKey = this.state.getCurrentApiKey();
    this.genAI = new GoogleGenerativeAI(apiKey);

    // Create single model with combined schema for all questions
    const schema = buildCombinedResponseSchema();
    this.model = this.genAI.getGenerativeModel({
      model: CONFIG.MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });

    log("Initialized Gemini client with combined schema for all questions");
  }

  async categorizeAllQuestions(rowData, rowId, retryCount = 0) {
    const prompt = this.buildCombinedPrompt(rowData);

    try {
      const result = await this.model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      const parsed = JSON.parse(text);

      // Track new categories for each question field
      QUESTIONS_CONFIG.questions.forEach((question) => {
        const questionResult = parsed[question.id];

        question.response_fields.forEach((field) => {
          if (field.allow_new_categories) {
            const newCatSuggestion =
              questionResult?.[`${field.name}_new_category_suggestion`];
            if (newCatSuggestion?.name) {
              this.state.addDiscoveredCategory(
                question.id,
                field.name,
                newCatSuggestion.name
              );
            }
          }

          // Track categories if it's an array with allow_new_categories
          if (
            field.allow_new_categories &&
            field.type === "array" &&
            questionResult?.[field.name] &&
            Array.isArray(questionResult[field.name])
          ) {
            questionResult[field.name].forEach((cat) => {
              this.state.addDiscoveredCategory(question.id, field.name, cat);
            });
          }

          // Track single category values with allow_new_categories
          if (
            field.allow_new_categories &&
            field.type === "string" &&
            questionResult?.[field.name]
          ) {
            this.state.addDiscoveredCategory(
              question.id,
              field.name,
              questionResult[field.name]
            );
          }
        });
      });

      return parsed;
    } catch (error) {
      // Handle rate limiting
      if (
        error.message?.includes("429") ||
        error.message?.includes("quota") ||
        error.message?.includes("rate limit")
      ) {
        log(
          `Rate limit hit for row ${rowId}. Attempt ${retryCount + 1}/${
            CONFIG.MAX_RETRIES
          }`,
          "WARN"
        );

        if (retryCount < CONFIG.MAX_RETRIES) {
          // Try switching API key
          this.state.switchToNextApiKey();
          this.initializeClient();

          // Exponential backoff
          const delay = CONFIG.INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
          log(`Retrying after ${delay}ms with new API key...`);
          await this.sleep(delay);

          return this.categorizeAllQuestions(rowData, rowId, retryCount + 1);
        } else {
          log(`Max retries exceeded for row ${rowId}`, "ERROR");
          throw new Error("Rate limit exceeded on all API keys");
        }
      }

      // Handle other errors
      if (retryCount < CONFIG.MAX_RETRIES) {
        const delay = CONFIG.INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
        log(
          `Error for row ${rowId}: ${error.message}. Retrying after ${delay}ms...`,
          "WARN"
        );
        await this.sleep(delay);
        return this.categorizeAllQuestions(rowData, rowId, retryCount + 1);
      }

      throw error;
    }
  }

  buildCombinedPrompt(rowData) {
    let prompt = `You are an expert education researcher analyzing teacher feedback about school changes. You will analyze responses to multiple questions simultaneously and provide comprehensive categorizations.
IMPORTANT: You must analyze ALL questions and provide categorizations for each one in a single response.

`;

    // Add each question and its response
    QUESTIONS_CONFIG.questions.forEach((question, index) => {
      const responseText = rowData[question.csv_column];

      // Build field-specific instructions FIRST
      let fieldInstructions = "";
      question.response_fields.forEach((field) => {
        if (field.name === "reasoning") return; // Skip reasoning, handled separately

        const discoveredCats = this.state.discoveredCategories[question.id]?.[
          field.name
        ]
          ? Array.from(this.state.discoveredCategories[question.id][field.name])
          : [];
        const emergingSection =
          discoveredCats.length > 0
            ? ` EMERGING CATEGORIES (discovered so far): ${discoveredCats.join(
                ", "
              )}`
            : "";

        const multiCategoryNote = field.allow_multiple_categories
          ? `MULTIPLE categories allowed`
          : `SINGLE category only`;

        const newCategoryNote = field.allow_new_categories
          ? ` | Can suggest NEW category if none fit well`
          : ` | Must use predefined categories only`;

        fieldInstructions += `  • ${field.name}: ${multiCategoryNote}${newCategoryNote}${emergingSection}\n`;
      });

      prompt += `
${"=".repeat(80)}
QUESTION ${index + 1} [ID: ${question.id}]
${"=".repeat(80)}

QUESTION ASKED TO TEACHER:
"${question.question_text}"

TEACHER'S RESPONSE:
"${responseText}"

CATEGORIZATION INSTRUCTIONS:
${question.categorization_criteria}

FIELD-SPECIFIC RULES:
${fieldInstructions}
GENERAL REQUIREMENTS:
  • Focus on substantive educational content, not formulaic framing
  • Analyze each field independently according to its rules above
  • Provide brief reasoning for your categorization
  • For NEW category suggestions, provide: name, justification, and similarity to existing categories

`;
    });

    prompt += `
${"=".repeat(80)}
FINAL INSTRUCTIONS
${"=".repeat(80)}

Analyze ALL ${
      QUESTIONS_CONFIG.questions.length
    } questions above and provide categorizations for each one following the schema provided. Each question should be analyzed independently with its own categorization and reasoning.

Your response must include results for all question IDs: ${QUESTIONS_CONFIG.questions
      .map((q) => q.id)
      .join(", ")}
`;

    return prompt;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ==================== CSV PROCESSING ====================
async function readCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => {
        log(`Read ${rows.length} rows from CSV`);
        resolve(rows);
      })
      .on("error", reject);
  });
}

async function writeCSV(filePath, rows, headers) {
  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: headers.map((h) => ({ id: h, title: h })),
  });

  await csvWriter.writeRecords(rows);
  log(`Wrote ${rows.length} rows to ${filePath}`);
}

async function loadExistingOutput() {
  if (fs.existsSync(CONFIG.OUTPUT_CSV)) {
    try {
      const existingRows = await readCSV(CONFIG.OUTPUT_CSV);
      log(`Loaded ${existingRows.length} existing rows from output CSV`);
      return existingRows;
    } catch (error) {
      log(
        `Warning: Could not load existing output CSV: ${error.message}`,
        "WARN"
      );
      return [];
    }
  }
  return [];
}

// ==================== RESULT FORMATTING ====================
function formatResultForCSV(question, result) {
  const formatted = {};

  question.response_fields.forEach((field) => {
    if (field.name === "reasoning") {
      // Handle reasoning separately
      formatted.reasoning = result.reasoning || "";
      return;
    }

    const value = result[field.name];

    if (field.type === "array") {
      // Multiple categories
      formatted[field.name] = Array.isArray(value)
        ? value.join("; ")
        : value || "";
    } else {
      // Single value (string or enum)
      formatted[field.name] = value || "";
    }

    // Add new category suggestion if this field allows it
    if (field.allow_new_categories) {
      const newCatKey = `${field.name}_new_category_suggestion`;
      formatted[newCatKey] = result[newCatKey]
        ? JSON.stringify(result[newCatKey])
        : "";
    }
  });

  return formatted;
}

// ==================== MAIN PROCESSING ====================
async function processRows() {
  log("=".repeat(60));
  log("Starting OPTIMIZED Multi-Question CSV Categorization");
  log("(Single API Call Per Row)");
  log("=".repeat(60));

  // Load questions config
  loadQuestionsConfig();

  // Initialize
  const state = new ProcessingState();
  const client = new GeminiClient(state);

  // Load previous progress if exists
  const previousProgress = ProcessingState.loadProgress();
  const startFrom = previousProgress?.lastProcessedIndex
    ? previousProgress.lastProcessedIndex + 1
    : CONFIG.START_ROW;

  if (previousProgress) {
    log(
      `Resuming from row ${startFrom} (previous run processed ${previousProgress.processedRows} rows)`
    );
  }

  // Read input CSV
  const inputRows = await readCSV(CONFIG.INPUT_CSV);

  // Verify that all question columns exist
  const firstRow = inputRows[0];
  const missingColumns = [];
  QUESTIONS_CONFIG.questions.forEach((q) => {
    if (!(q.csv_column in firstRow)) {
      missingColumns.push(q.csv_column);
    }
  });

  if (missingColumns.length > 0) {
    log(`ERROR: Missing columns in CSV: ${missingColumns.join(", ")}`, "ERROR");
    throw new Error(
      "Some question columns are missing from the input CSV. Please check your questions-config.json and input CSV."
    );
  }

  // Determine processing range
  const endRow = CONFIG.MAX_ROWS
    ? Math.min(startFrom + CONFIG.MAX_ROWS, inputRows.length)
    : inputRows.length;

  log(
    `Processing rows ${startFrom} to ${endRow - 1} (${endRow - startFrom} rows)`
  );
  log(
    `Processing ${QUESTIONS_CONFIG.questions.length} questions per row with 1 API call`
  );

  // Load existing output to preserve previous work
  const outputRows = await loadExistingOutput();

  // Prepare output headers
  const allHeaders = Object.keys(inputRows[0]);
  const newHeaders = [...allHeaders];

  // Add output columns for each question
  QUESTIONS_CONFIG.questions.forEach((q) => {
    q.response_fields.forEach((field) => {
      if (field.name === "reasoning") {
        newHeaders.push(`${q.id}_reasoning`);
      } else {
        newHeaders.push(`${q.id}_${field.name}`);

        if (field.allow_new_categories) {
          newHeaders.push(`${q.id}_${field.name}_new_category_suggested`);
        }
      }
    });

    newHeaders.push(`${q.id}_processing_status`);
    newHeaders.push(`${q.id}_error_message`);
  });

  // Process rows
  for (let i = startFrom; i < endRow; i++) {
    const row = inputRows[i];
    const rowId = row[CONFIG.ID_COLUMN] || `row_${i}`;

    log(`\nProcessing row ${i + 1}/${endRow} (ID: ${rowId})`);
    log("-".repeat(60));

    // Preprocess all responses for this row
    const rowData = { ...row };
    QUESTIONS_CONFIG.questions.forEach((question) => {
      const rawText = row[question.csv_column];
      rowData[question.csv_column] = preprocessResponse(rawText);
    });

    const outputRow = { ...row };
    let rowSuccessCount = 0;
    let rowErrorCount = 0;

    try {
      // Single API call for all questions!
      log(
        `  Making single API call for all ${QUESTIONS_CONFIG.questions.length} questions...`
      );
      const allResults = await client.categorizeAllQuestions(rowData, rowId);

      // Process results for each question
      for (const question of QUESTIONS_CONFIG.questions) {
        try {
          const result = allResults[question.id];

          if (!result) {
            throw new Error(`No result returned for question ${question.id}`);
          }

          const formatted = formatResultForCSV(question, result);

          // Add results to output row with question-specific prefixes
          question.response_fields.forEach((field) => {
            if (field.name === "reasoning") {
              outputRow[`${question.id}_reasoning`] = formatted.reasoning;
            } else {
              outputRow[`${question.id}_${field.name}`] = formatted[field.name];

              if (field.allow_new_categories) {
                outputRow[
                  `${question.id}_${field.name}_new_category_suggested`
                ] = formatted[`${field.name}_new_category_suggestion`];
              }
            }
          });

          outputRow[`${question.id}_processing_status`] = "SUCCESS";
          outputRow[`${question.id}_error_message`] = "";

          state.questionStats[question.id].successCount++;
          rowSuccessCount++;

          // Build summary for logging
          const resultSummary = question.response_fields
            .filter((f) => f.name !== "reasoning")
            .map((f) => formatted[f.name])
            .join(" | ");
          log(`  [${question.id}] ✓ Categorized: ${resultSummary}`);
        } catch (error) {
          // Handle individual question failure within successful API call
          log(`  [${question.id}] ✗ Parse error: ${error.message}`, "ERROR");

          // Initialize error columns
          question.response_fields.forEach((field) => {
            if (field.name === "reasoning") {
              outputRow[`${question.id}_reasoning`] = "";
            } else {
              outputRow[`${question.id}_${field.name}`] = "ERROR";

              if (field.allow_new_categories) {
                outputRow[
                  `${question.id}_${field.name}_new_category_suggested`
                ] = "";
              }
            }
          });

          outputRow[`${question.id}_processing_status`] = "ERROR";
          outputRow[`${question.id}_error_message`] = error.message;

          state.questionStats[question.id].errorCount++;
          rowErrorCount++;
        }
      }
    } catch (error) {
      // Handle complete API call failure
      log(`  ✗ API call failed: ${error.message}`, "ERROR");

      // Mark all questions as ERROR for this row
      for (const question of QUESTIONS_CONFIG.questions) {
        question.response_fields.forEach((field) => {
          if (field.name === "reasoning") {
            outputRow[`${question.id}_reasoning`] = "";
          } else {
            outputRow[`${question.id}_${field.name}`] = "ERROR";

            if (field.allow_new_categories) {
              outputRow[`${question.id}_${field.name}_new_category_suggested`] =
                "";
            }
          }
        });

        outputRow[`${question.id}_processing_status`] = "ERROR";
        outputRow[`${question.id}_error_message`] = error.message;

        state.questionStats[question.id].errorCount++;
        rowErrorCount++;
      }
    }

    state.processedRows++;
    state.successCount += rowSuccessCount;
    state.errorCount += rowErrorCount;

    outputRows.push(outputRow);

    log(
      `Row ${
        i + 1
      } completed: ${rowSuccessCount} successes, ${rowErrorCount} errors (1 API call)`
    );

    // Save progress periodically
    if (state.processedRows % CONFIG.BATCH_SIZE === 0) {
      await writeCSV(CONFIG.OUTPUT_CSV, outputRows, newHeaders);
      state.saveProgress(i);
      log(`Progress saved: ${state.processedRows} rows processed`);
    }

    // Rate limiting delay between rows
    await client.sleep(CONFIG.REQUEST_DELAY);
  }

  // Final save
  await writeCSV(CONFIG.OUTPUT_CSV, outputRows, newHeaders);
  state.saveProgress(endRow - 1);

  // Print final statistics
  log("\n" + "=".repeat(60));
  log("Processing Complete!");
  log("=".repeat(60));
  const stats = state.getStats();
  log(`Total Rows Processed: ${stats.processedRows}`);
  log(`Total API Calls Made: ${stats.processedRows} (1 per row!)`);
  log(`Total Successful Categorizations: ${stats.totalSuccessCount}`);
  log(`Total Errors: ${stats.totalErrorCount}`);
  log(`API Key Switches: ${stats.apiKeySwitchCount}`);
  log(`Processing Rate: ${stats.rowsPerMinute} rows/minute`);
  log(`Total Time: ${stats.elapsedTime}`);

  const oldApiCalls = stats.processedRows * QUESTIONS_CONFIG.questions.length;
  const savings = (
    ((oldApiCalls - stats.processedRows) / oldApiCalls) *
    100
  ).toFixed(1);
  log(
    `\n🎉 API Call Reduction: ${oldApiCalls} → ${stats.processedRows} (${savings}% savings!)`
  );

  log("\nPer-Question Statistics:");
  log("-".repeat(60));
  Object.keys(stats.questionStats).forEach((qId) => {
    const qStats = stats.questionStats[qId];
    log(`\n${qId}:`);
    log(`  Success: ${qStats.successCount}`);
    log(`  Errors: ${qStats.errorCount}`);

    if (Object.keys(qStats.discoveredCategories).length > 0) {
      log(`  Discovered Categories by Field:`);
      Object.keys(qStats.discoveredCategories).forEach((fieldName) => {
        const cats = qStats.discoveredCategories[fieldName];
        if (cats.length > 0) {
          log(`    - ${fieldName}: ${cats.join(", ")}`);
        }
      });
    }
  });

  log(`\nOutput saved to: ${CONFIG.OUTPUT_CSV}`);
}

// ==================== ERROR HANDLING ====================
process.on("unhandledRejection", (error) => {
  log(`Unhandled rejection: ${error.message}`, "ERROR");
  log(error.stack, "ERROR");
  process.exit(1);
});

process.on("SIGINT", () => {
  log("Process interrupted by user. Progress has been saved.", "WARN");
  process.exit(0);
});

// ==================== RUN ====================
processRows().catch((error) => {
  log(`Fatal error: ${error.message}`, "ERROR");
  log(error.stack, "ERROR");
  process.exit(1);
});
