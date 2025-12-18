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

  // Processing configuration
  START_ROW: 0, // Start from row N (0-indexed)
  MAX_ROWS: 10, // Process N rows (null = all)
  BATCH_SIZE: 10, // Save progress every N rows

  // API configuration
  MODEL_NAME: "gemini-flash-latest",
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY: 2000, // ms
  REQUEST_DELAY: 1000, // Delay between requests (ms)

  // Column names
  QUESTION_COLUMN:
    "Q1. In the last 6 to 12 months, what do you think are some important changes in your school? These can be in students, teachers, parents or the school in general.",
  ID_COLUMN: "id",
};

// ==================== RESPONSE SCHEMA ====================
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    category_1: {
      type: "string",
      description:
        "Single category from: Classroom, Student, Teacher, School, Parental Engagement, Not Identified",
    },
    category_2: {
      type: "string",
      description: "Either PBL, Non-PBL or Not Identified",
      enum: ["PBL", "Non-PBL", "Not Identified"],
    },
    new_category_suggestion: {
      type: "object",
      properties: {
        name: { type: "string" },
        justification: { type: "string" },
        similar_to_existing: { type: "string" },
      },
      nullable: true,
    },
    reasoning: {
      type: "string",
      description: "Brief explanation of the categorization",
    },
  },
  required: ["category_1", "category_2", "reasoning"],
};

// ==================== CATEGORIZATION CRITERIA ====================
const CATEGORIZATION_CRITERIA = `
CATEGORY 1 DEFINITIONS (Choose ONE):

**Classroom**
Definition: Use this for changes related to teaching methods, specific subject instruction, learning materials (TLM, kits), or the physical classroom environment.
Examples: "I started using TLMs," "We made the classroom beautiful," "I implemented group work," "Changes in my science teaching."

**Student**
Definition: Use this for changes where the primary focus is on student outcomes, behaviors, attitudes, or skills.
Examples: "Students' attendance improved," "Children became more curious," "The children's learning level increased," "Students are no longer afraid to ask questions."

**Teacher**
Definition: Use this for changes related to the teacher's own professional development, collaboration with other teachers, or personal motivation/attitudes.
Examples: "I started collaborating more with my colleagues," "We hold regular teacher meetings," "My own confidence in teaching has grown."

**School**
Definition: Use this for broad, systemic changes that affect the entire school, its policies, infrastructure, or its overall environment (beyond a single classroom).
Examples: "We started a school-wide kitchen garden," "The entire school environment is more positive," "We improved the school library."

**Parental Engagement**
Definition: Use this for changes specifically focused on improving relationships, communication, or involvement with parents and the wider community.
Examples: "We started holding regular PTMs," "Parents are now more involved in school activities."

**Not Identified**
Definition: Use this category ONLY as a last resort. This is for responses that are too vague, do not describe a change, are non-answers, or are placeholder/error text.

---

CATEGORY 2 DEFINITIONS:

**PBL**
Definition: Use this category when the response explicitly mentions "PBL," "projects," "project-based learning," "making models," or the methodology of "learning by doing" as the primary change or the cause of other changes.
Keywords: PBL, PVL, project based learning, project, projects, making projects, making model, learning by doing, activity-based learning, project work.

**Non-PBL**
Definition: Use this category when the response describes general changes in the school, students, teachers, or infrastructure without attributing them to Project-Based Learning. This includes changes in attendance (with no PBL reason), new resources, government policies, or general observations.
Keywords: attendance, smart classrooms, training programs, government facilities, online attendance, policy, new teachers, infrastructure, electricity, water supply, cleanliness, discipline, uniforms, new building.

**Not Identified**
Definition: Use this category ONLY as a last resort. This is for responses that are too vague, do not describe a change, are non-answers, or are placeholder/error text.

`;

// ==================== STATE MANAGEMENT ====================
class ProcessingState {
  constructor() {
    this.currentApiKeyIndex = 0;
    this.processedRows = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.discoveredCategories = new Set();
    this.apiKeySwitchCount = 0;
    this.startTime = Date.now();
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

  addDiscoveredCategory(category) {
    if (category && !this.discoveredCategories.has(category)) {
      this.discoveredCategories.add(category);
      log(`New category discovered: ${category}`);
    }
  }

  getStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    return {
      processedRows: this.processedRows,
      successCount: this.successCount,
      errorCount: this.errorCount,
      apiKeySwitchCount: this.apiKeySwitchCount,
      elapsedTime: `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`,
      rowsPerMinute: ((this.processedRows / elapsed) * 60).toFixed(2),
      discoveredCategories: Array.from(this.discoveredCategories),
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
    this.model = this.genAI.getGenerativeModel({
      model: CONFIG.MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
  }

  async categorizeResponse(responseText, rowId, retryCount = 0) {
    const prompt = this.buildPrompt(responseText);

    try {
      const result = await this.model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      const parsed = JSON.parse(text);

      // Track new categories
      if (parsed.new_category_suggestion?.name) {
        this.state.addDiscoveredCategory(parsed.new_category_suggestion.name);
      }

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

          return this.categorizeResponse(responseText, rowId, retryCount + 1);
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
        return this.categorizeResponse(responseText, rowId, retryCount + 1);
      }

      throw error;
    }
  }

  buildPrompt(responseText) {
    const discoveredCats = Array.from(this.state.discoveredCategories).join(
      ", "
    );
    const emergingSection = discoveredCats
      ? `\n\nEMERGING CATEGORIES (discovered so far): ${discoveredCats}`
      : "";

    return `You are an expert education researcher analyzing teacher feedback about school changes.

QUESTION ASKED TO TEACHER:
"In the last 6 to 12 months, what do you think are some important changes in your school? These can be in students, teachers, parents or the school in general."

TEACHER'S RESPONSE:
"${responseText}"

${CATEGORIZATION_CRITERIA}${emergingSection}

INSTRUCTIONS:
1. Focus on the substantive educational changes described, not formulaic response framing
2. Assign ONE category from Category 1 that BEST fits the core content
3. Assign either PBL, Non-PBL or Not Identified from Category 2
4. If the response describes a meaningful change that doesn't fit any existing Category 1 options, suggest a NEW category with justification
5. Provide brief reasoning for your categorization

Analyze and categorize this response following the schema provided.`;
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

// ==================== MAIN PROCESSING ====================
async function processRows() {
  log("=".repeat(60));
  log("Starting CSV Categorization Process");
  log("=".repeat(60));

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

  // Determine processing range
  const endRow = CONFIG.MAX_ROWS
    ? Math.min(startFrom + CONFIG.MAX_ROWS, inputRows.length)
    : inputRows.length;

  log(
    `Processing rows ${startFrom} to ${endRow - 1} (${endRow - startFrom} rows)`
  );

  // Prepare output rows
  const outputRows = [];
  const allHeaders = Object.keys(inputRows[0]);
  const newHeaders = [
    ...allHeaders,
    "category_1_result",
    "category_2_result",
    "new_category_suggested",
    "categorization_reasoning",
    "processing_status",
    "error_message",
  ];

  // Process rows
  for (let i = startFrom; i < endRow; i++) {
    const row = inputRows[i];
    const rowId = row[CONFIG.ID_COLUMN] || `row_${i}`;
    const rawResponseText = row[CONFIG.QUESTION_COLUMN];

    // Preprocess the response text
    const responseText = preprocessResponse(rawResponseText);

    log(`Processing row ${i + 1}/${endRow} (ID: ${rowId})`);

    const outputRow = { ...row };

    try {
      if (!responseText || responseText.trim() === "") {
        throw new Error("Empty response text after preprocessing");
      }

      const result = await client.categorizeResponse(responseText, rowId);

      outputRow.category_1_result = result.category_1;
      outputRow.category_2_result = result.category_2;
      outputRow.new_category_suggested = result.new_category_suggestion
        ? JSON.stringify(result.new_category_suggestion)
        : "";
      outputRow.categorization_reasoning = result.reasoning;
      outputRow.processing_status = "SUCCESS";
      outputRow.error_message = "";

      state.successCount++;
      log(
        `✓ Row ${i + 1} categorized: ${result.category_1} | ${
          result.category_2
        }`
      );
    } catch (error) {
      outputRow.category_1_result = "ERROR";
      outputRow.category_2_result = "ERROR";
      outputRow.new_category_suggested = "";
      outputRow.categorization_reasoning = "";
      outputRow.processing_status = "ERROR";
      outputRow.error_message = error.message;

      state.errorCount++;
      log(`✗ Row ${i + 1} failed: ${error.message}`, "ERROR");
    }

    outputRows.push(outputRow);
    state.processedRows++;

    // Save progress periodically
    if (state.processedRows % CONFIG.BATCH_SIZE === 0) {
      await writeCSV(CONFIG.OUTPUT_CSV, outputRows, newHeaders);
      state.saveProgress(i);
      log(`Progress saved: ${state.processedRows} rows processed`);
    }

    // Rate limiting delay
    await client.sleep(CONFIG.REQUEST_DELAY);
  }

  // Final save
  await writeCSV(CONFIG.OUTPUT_CSV, outputRows, newHeaders);
  state.saveProgress(endRow - 1);

  // Print final statistics
  log("=".repeat(60));
  log("Processing Complete!");
  log("=".repeat(60));
  const stats = state.getStats();
  log(`Total Rows Processed: ${stats.processedRows}`);
  log(`Successful: ${stats.successCount}`);
  log(`Errors: ${stats.errorCount}`);
  log(`API Key Switches: ${stats.apiKeySwitchCount}`);
  log(`Processing Rate: ${stats.rowsPerMinute} rows/minute`);
  log(`Total Time: ${stats.elapsedTime}`);
  log(
    `Discovered Categories: ${stats.discoveredCategories.join(", ") || "None"}`
  );
  log(`Output saved to: ${CONFIG.OUTPUT_CSV}`);
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
