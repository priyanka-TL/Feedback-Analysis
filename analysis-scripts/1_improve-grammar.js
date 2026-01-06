#!/usr/bin/env node

/**
 * Grammar Improvement Script - OPTIMIZED VERSION
 *
 * Combines the best features from both implementations:
 * - Uses official @google/generative-ai package
 * - Smart filtering (only processes responses that need improvement)
 * - Full-row context processing (processes all questions together when needed)
 * - Modular architecture with utilities
 * - Command-line argument support
 * - Comprehensive acronym handling
 * - Backup creation and progress tracking
 *
 * Usage:
 *   node 1_improve-grammar.js [options]
 *
 * Options:
 *   --config <path>      Path to config file (default: ./config.js)
 *   --input <path>       Input CSV file (default: from config.js)
 *   --output <path>      Output CSV file (default: from config.js)
 *   --columns <path>     Path to question columns config (optional)
 *   --resume             Resume from previous progress
 *   --clear              Clear progress and start fresh
 *   --backup             Create backup before processing (default: true)
 *   --strategy <type>    Processing strategy: 'smart' (default), 'full', or 'batch'
 */

const path = require('path');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  configPath: './config.js',
  inputFile: './temp_with_relation.csv',
  outputFile: './temp_grammer_output.csv',
  columnsConfig: null,
  resume: false,
  clear: false,
  backup: true,
  strategy: 'smart' // smart, full, or batch
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--config':
      options.configPath = args[++i];
      break;
    case '--input':
      options.inputFile = args[++i];
      break;
    case '--output':
      options.outputFile = args[++i];
      break;
    case '--columns':
      options.columnsConfig = args[++i];
      break;
    case '--resume':
      options.resume = true;
      break;
    case '--clear':
      options.clear = true;
      break;
    case '--backup':
      options.backup = args[++i] !== 'false';
      break;
    case '--strategy':
      options.strategy = args[++i];
      break;
    case '--help':
      console.log(`
Grammar Improvement Script - AI-powered text improvement

Usage:
  node 1_improve-grammar.js [options]

Options:
  --config <path>      Path to config file (default: ./config.js)
  --input <path>       Input CSV file (default: from config.js)
  --output <path>      Output CSV file (default: from config.js)
  --columns <path>     Path to question columns config (optional)
  --resume             Resume from previous progress
  --clear              Clear progress and start fresh
  --backup             Create backup before processing (default: true)
  --strategy <type>    Processing strategy: 'smart', 'full', or 'batch'
                       smart = Only process responses needing improvement (default)
                       full  = Process all questions together with context
                       batch = Process multiple rows at once
  --help               Show this help message

Strategies:
  smart: Most efficient - only improves responses that need it
  full:  Best quality - processes all questions together for context consistency
  batch: Fastest - processes multiple rows concurrently (experimental)

Environment Variables:
  API_PROVIDER         API provider: 'gemini' or 'bedrock' (default: gemini)
  API_KEYS             Comma-separated Gemini API keys (for Gemini)
  AWS_ACCESS_KEY_ID    AWS access key (for Bedrock)
  AWS_SECRET_ACCESS_KEY AWS secret key (for Bedrock)
  MODEL_NAME           Model name (provider-specific)
  TEMPERATURE          Model temperature (default: 0.3)

Examples:
  # Using Gemini
  API_PROVIDER=gemini node 1_improve-grammar.js --input data.csv --output improved.csv
  
  # Using Bedrock (Claude)
  API_PROVIDER=bedrock node 1_improve-grammar.js --input data.csv --output improved.csv
  
  node 1_improve-grammar.js --resume --strategy full
  node 1_improve-grammar.js --clear --backup true --strategy smart
      `);
      process.exit(0);
  }
}

// Load configuration
const config = require(path.resolve(options.configPath));

// Override config with command line options
if (options.inputFile) {
  config.paths.input = options.inputFile;
}
if (options.outputFile) {
  config.paths.output = options.outputFile;
}
if (options.columnsConfig) {
  config.paths.questionColumns = options.columnsConfig;
}

// Validate configuration
try {
  config.validate();
} catch (error) {
  console.error('Configuration Error:', error.message);
  process.exit(1);
}

// Load utilities
const Logger = require('./utils/logger');
const CSVHandler = require('./utils/csv-handler');
const ProgressTracker = require('./utils/progress-tracker');
const APIManager = require('./utils/api-manager');
const Validator = require('./utils/validator');
const { getInstance: getQuestionLoader } = require('./utils/question-loader');

// Initialize utilities
const logger = new Logger(config.logging);
const csvHandler = new CSVHandler(logger);
const progressTracker = new ProgressTracker(config.paths.progress, logger);
const apiManager = new APIManager(config, logger);
const validator = new Validator(config, logger);

/**
 * Load question columns configuration
 */
function loadQuestionColumns() {
  try {
    const questionLoader = getQuestionLoader(config.paths.questionsConfig, logger);
    const questionColumns = questionLoader.getColumnMapping();

    logger.info(`Loaded ${Object.keys(questionColumns).length} question columns`);
    return questionColumns;

  } catch (error) {
    logger.error(`Failed to load question columns: ${error.message}`);
    throw error;
  }
}

/**
 * Generate question list for prompt context
 */
function generateQuestionList(questionColumns) {
  const questions = [];
  for (const [qNum, fullQuestion] of Object.entries(questionColumns)) {
    // Remove the "Q1. " or "Q1: " prefix to get just the question text
    const questionText = fullQuestion.replace(/^Q\d+[.:]\s*/, '');
    questions.push(`${qNum.toUpperCase()}: ${questionText}`);
  }
  return questions.join('\n');
}

/**
 * Get acronym expansions text from config
 */
function getAcronymExpansions() {
  const acronyms = config.grammarImprovement.acronyms;

  if (!acronyms || Object.keys(acronyms).length === 0) {
    return '';
  }

  let text = '\n**Known Acronyms & Full Forms** (expand when found):\n';
  for (const [acronym, expansion] of Object.entries(acronyms)) {
    text += `• **${acronym}** – ${expansion}\n`;
  }

  return text;
}

/**
 * Check if response needs improvement
 */
function needsImprovement(text) {
  if (!text || validator.isEmpty(text)) return false;

  const trimmed = text.trim();

  // Skip very short responses
  if (trimmed.length < 10) return false;

  // Check for obvious issues that need fixing
  const hasIssues =
    /\b(tlm|ptm|pbl|fln|lnf|ebrc|diet|smc|hm|ict)\b/i.test(trimmed) || // Has acronyms
    /[a-z][A-Z]/.test(trimmed) || // Has camelCase (likely error)
    /\s{2,}/.test(trimmed) || // Multiple spaces
    /[.!?]\s*[a-z]/.test(trimmed) || // Lowercase after punctuation
    /\b(306|206)\s*months\b/i.test(trimmed) || // Common mistranslation
    !/[.!?]$/.test(trimmed); // Missing ending punctuation

  return hasIssues || trimmed.length > 50;
}

/**
 * STRATEGY 1: SMART - Only process responses that need improvement
 */
async function processRowSmart(row, questionColumns) {
  // Filter to only non-empty responses that need improvement
  const responsesToImprove = [];
  for (const [key, columnName] of Object.entries(questionColumns)) {
    if (columnName in row && row[columnName]) {
      const response = row[columnName];
      if (needsImprovement(response)) {
        responsesToImprove.push({ key, columnName, text: response });
      }
    }
  }

  // If nothing needs improvement, return null
  if (responsesToImprove.length === 0) {
    return { skipped: true, reason: 'no_improvement_needed' };
  }

  const acronymText = getAcronymExpansions();

  let prompt = `You are an expert editor improving teacher feedback responses. Your task is to:

1. Fix grammar, spelling, and punctuation errors
2. Improve clarity and readability
3. Expand acronyms where appropriate (keep both acronym and full form)
4. Maintain the original meaning and authentic teacher voice
5. Keep responses concise and professional
6. Preserve context from the full response
${acronymText}

**IMPORTANT Rules:**
- Do NOT change the meaning or add information not present in the original
- Do NOT make responses too formal - maintain a natural teaching tone
- If the response is already clear and correct, minimal changes are acceptable
- Preserve formatting like bullet points or numbers if present
- Correct obvious factual errors (e.g., "306 months" → "3-6 months")
- Break long run-on sentences into clear, shorter sentences

Here are the responses to improve:

`;

  // Add only responses that need improvement
  responsesToImprove.forEach(({ columnName, text }) => {
    prompt += `\n**${columnName}:**\n"${text}"\n`;
  });

  prompt += `\n\nPlease improve each response above, maintaining their authentic voice and meaning.`;

  // Build dynamic schema for only the responses being improved
  const fields = {};
  responsesToImprove.forEach(({ columnName }) => {
    fields[columnName] = {
      type: 'string',
      description: `Improved version of ${columnName} response`
    };
  });

  const schema = apiManager.buildSchema(fields);

  try {
    const apiResponse = await apiManager.generateContent(prompt, schema);

    // Update row with improved responses
    const improvements = {};
    for (const { columnName } of responsesToImprove) {
      if (columnName in apiResponse) {
        const improved = apiResponse[columnName];

        if (improved && !validator.isEmpty(improved)) {
          improvements[columnName] = improved.trim();
        }
      }
    }

    return {
      success: true,
      improvements,
      improvedCount: Object.keys(improvements).length,
      totalResponses: responsesToImprove.length
    };

  } catch (error) {
    logger.error(`Failed to process row (smart): ${error.message}`);
    throw error;
  }
}

/**
 * STRATEGY 2: FULL - Process all questions together with full context
 * (Best for maintaining consistency across related responses)
 */
async function processRowFull(row, questionColumns) {
  // Build responses text with all questions
  const responsesText = [];
  const allResponses = [];

  for (const [qNum, colName] of Object.entries(questionColumns)) {
    const answer = row[colName] || "";
    const trimmed = answer.trim();
    responsesText.push(`${qNum.toUpperCase()}: ${trimmed || "(empty)"}`);

    if (trimmed.length > 10) {
      allResponses.push({ qNum, colName, text: trimmed });
    }
  }

  // Skip if all responses are empty
  if (allResponses.length === 0) {
    return { skipped: true, reason: 'all_empty' };
  }

  const questionList = generateQuestionList(questionColumns);
  const acronymText = getAcronymExpansions();

  const prompt = `You are a translation and editing assistant. A teacher has provided feedback responses originally given in Hindi and translated to English. Your task is to improve the clarity, grammar, and readability of ALL responses while maintaining the teacher's authentic voice and preserving all information.

**Context**: The same teacher answered these ${Object.keys(questionColumns).length} questions about changes in their school:
${questionList}

**Teacher's Original Responses**:
${responsesText.join('\n\n')}
${acronymText}

**Editing Rules:**
1. Preserve all original ideas and details exactly — do not add or remove information.
2. Fix grammar, clarity, and mistranslations while keeping the intended meaning.
3. Correct typos **and** known acronym errors where context clearly indicates a mistake.
4. When expanding acronyms, **keep both the acronym and full form** (e.g., "TLM (Teaching Learning Material)").
5. For **PBL (Project-Based Learning)**:
   - Normalize dynamically if the response contains a likely variant or misspelling (e.g., "PVL", "BPL", "TVL").
   - Replace it with "PBL (Project-Based Learning)" while preserving the original mention if present.
6. Break long or run-on sentences into short, clear sentences.
7. Maintain the teacher's authentic tone and phrasing across all responses.
8. Ensure terminology consistency across all answers (e.g., if they use "TLM" in one answer, use consistent spelling elsewhere).
9. Keep educational and institutional terms uniform.
10. Retain all details about challenges, needs, and support mentioned.
11. Use simple, natural English — not overly formal.
12. If multiple distinct ideas appear in one response, format them as bullet points if appropriate.
13. Keep unclear acronyms or local terms as-is if meaning cannot be confidently inferred.
14. Correct obvious factual or numeric errors (e.g., "306 months" → "3-6 months").
15. Maintain logical continuity between related questions.
16. If a response is empty, under 10 characters, or just whitespace, return it as an empty string.

Return ONLY the improved responses in JSON format, with no meta-commentary.`;

  // Build schema for all questions
  const fields = {};
  for (const [qNum] of Object.entries(questionColumns)) {
    fields[qNum.toUpperCase()] = {
      type: 'string',
      description: `Improved response for ${qNum}`
    };
  }

  const schema = apiManager.buildSchema(fields);

  try {
    const apiResponse = await apiManager.generateContent(prompt, schema);

    // Update row with improved responses
    const improvements = {};
    let improvedCount = 0;

    for (const [qNum, colName] of Object.entries(questionColumns)) {
      const key = qNum.toUpperCase();
      if (key in apiResponse) {
        const improved = apiResponse[key];

        // Only update if we got a valid improvement and it's not just whitespace
        if (improved && improved.trim().length > 0) {
          improvements[colName] = improved.trim();
          improvedCount++;
        }
      }
    }

    return {
      success: true,
      improvements,
      improvedCount,
      totalResponses: Object.keys(questionColumns).length
    };

  } catch (error) {
    logger.error(`Failed to process row (full): ${error.message}`);
    throw error;
  }
}

/**
 * Main row processor - delegates to selected strategy
 */
async function processRow(row, questionColumns, strategy) {
  switch (strategy) {
    case 'full':
      return await processRowFull(row, questionColumns);
    case 'smart':
    default:
      return await processRowSmart(row, questionColumns);
  }
}

/**
 * Log execution metrics to cost.log file
 */
function logCostMetrics(metrics) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    script: "1_improve-grammar.js",
    ...metrics
  };

  const logLine = JSON.stringify(logEntry) + '\n';
  const logPath = path.join(__dirname, 'cost.log');

  try {
    fs.appendFileSync(logPath, logLine);
    logger.info(`\n💾 Cost metrics logged to: cost.log`);
  } catch (error) {
    logger.warn(`⚠️  Failed to write to cost.log: ${error.message}`);
  }
}

/**
 * Main execution function
 */
async function main() {
  const startTime = Date.now();

  try {
    logger.section('Grammar Improvement Script - OPTIMIZED');
    logger.info(`Input: ${config.paths.input}`);
    logger.info(`Output: ${config.paths.output}`);
    logger.info(`Provider: ${config.api.provider}`);
    if (config.api.provider === 'gemini') {
      logger.info(`Model: ${config.api.gemini.model}`);
      logger.info(`API Keys: ${config.api.gemini.keys.length}`);
    } else if (config.api.provider === 'bedrock') {
      logger.info(`Model: ${config.api.bedrock.model}`);
      logger.info(`Region: ${config.api.bedrock.region}`);
    }
    logger.info(`Strategy: ${options.strategy}`);

    // Create backup if requested
    if (options.backup && config.grammarImprovement.createBackup) {
      logger.section('Creating Backup');
      try {
        const backupPath = config.paths.input.replace('.csv', '_backup.csv');
        await fs.promises.copyFile(config.paths.input, backupPath);
        logger.info(`Backup created: ${backupPath}`);
      } catch (error) {
        logger.warn(`Backup failed: ${error.message}`);
      }
    }

    // Clear progress if requested
    if (options.clear) {
      logger.info('Clearing previous progress...');
      progressTracker.clear();
    }

    // Load question columns configuration
    logger.section('Loading Configuration');
    const questionColumns = loadQuestionColumns();
    logger.info(`Processing ${Object.keys(questionColumns).length} question columns`);
    logger.info(`Columns: ${Object.keys(questionColumns).map(k => k.toUpperCase()).join(', ')}`);

    // Load input data
    logger.section('Loading Input Data');
    const data = await csvHandler.read(config.paths.input);

    if (data.length === 0) {
      throw new Error('No data found in input file');
    }

    logger.info(`Loaded ${data.length} rows`);

    // Validate columns exist
    const columnNames = Object.values(questionColumns);
    const existingColumns = columnNames.filter(col => col in data[0]);

    if (existingColumns.length === 0) {
      throw new Error('None of the specified columns found in input data');
    }

    logger.info(`Found ${existingColumns.length}/${columnNames.length} columns in data`);

    // Initialize or load progress
    let startIndex = 0;

    if (options.resume && progressTracker.load()) {
      startIndex = progressTracker.getNextRowIndex();
      logger.info(`Resuming from row ${startIndex}`);
    } else {
      progressTracker.initialize(data.length, {
        inputFile: config.paths.input,
        outputFile: config.paths.output,
        columnsCount: existingColumns.length,
        strategy: options.strategy
      });
    }

    // Process rows
    logger.section('Processing Rows');

    let totalImproved = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalResponsesImproved = 0;

    for (let i = startIndex; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 1;

      logger.info(`\nProcessing row ${rowNum}/${data.length} (ID: ${row.id || 'N/A'}, District: ${row.District || 'N/A'})`);

      try {
        const result = await processRow(row, questionColumns, options.strategy);

        if (result.error) {
          progressTracker.update('error', { error: result.message });
          totalErrors++;
        } else if (result.skipped) {
          logger.debug(`  ⊘ Skipped: ${result.reason}`);
          progressTracker.update('skipped');
          totalSkipped++;
        } else if (result.success) {
          // Apply improvements to row
          Object.assign(row, result.improvements);

          logger.info(`  ✓ Improved ${result.improvedCount}/${result.totalResponses} responses`);
          progressTracker.update('success');
          totalImproved++;
          totalResponsesImproved += result.improvedCount;
        }

      } catch (error) {
        logger.error(`  ✗ Error: ${error.message}`);
        progressTracker.update('error', { error: error.message });
        totalErrors++;

        // Stop if all API keys are exhausted
        if (error.message.includes('All API keys exhausted') ||
            error.message.includes('after') && error.message.includes('attempts')) {
          logger.error('Critical error - stopping processing');
          break;
        }
      }

      // Save progress periodically
      if ((i + 1) % config.processing.saveProgressEvery === 0) {
        progressTracker.save();
        await csvHandler.write(config.paths.output, data);
        logger.info(`  💾 Progress saved (${i + 1} rows processed)`);
      }

      // Log stats periodically
      if ((i + 1) % config.processing.logEvery === 0 || i === data.length - 1) {
        const percentComplete = (((i + 1 - startIndex) / (data.length - startIndex)) * 100).toFixed(1);
        logger.info(`  📊 Progress: ${percentComplete}% | Improved: ${totalImproved} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`);
      }

      // Delay between rows if configured
      if (config.processing.delayBetweenRows > 0 && i < data.length - 1) {
        await new Promise(resolve => setTimeout(resolve, config.processing.delayBetweenRows));
      }
    }

    // Final save
    logger.section('Saving Results');
    await csvHandler.write(config.paths.output, data);
    progressTracker.save();

    // Log summary
    logger.section('Processing Complete');
    progressTracker.logSummary();

    const apiStats = apiManager.getStats();
    const costInfo = apiManager.calculateCost();

    logger.info('\n📊 Final Statistics:');
    logger.info(`  Total Rows: ${data.length}`);
    logger.info(`  Rows Improved: ${totalImproved}`);
    logger.info(`  Rows Skipped: ${totalSkipped}`);
    logger.info(`  Rows with Errors: ${totalErrors}`);
    logger.info(`  Total Responses Improved: ${totalResponsesImproved}`);
    logger.info(`  Provider: ${apiStats.provider}`);
    logger.info(`  API Requests: ${apiStats.totalRequests}`);
    logger.info(`  API Errors: ${apiStats.totalErrors}`);
    logger.info(`  Success Rate: ${apiStats.successRate}`);
    if (apiStats.provider === 'gemini' && apiStats.currentKeyIndex !== undefined) {
      logger.info(`  Current Key Index: ${apiStats.currentKeyIndex}`);
    }

    logger.info('\n💰 Token Usage & Cost:');
    logger.info(`  Provider: ${costInfo.provider}`);
    logger.info(`  Model: ${costInfo.model}`);
    logger.info(`  Input Tokens: ${costInfo.inputTokens.toLocaleString()}`);
    logger.info(`  Output Tokens: ${costInfo.outputTokens.toLocaleString()}`);
    logger.info(`  Total Tokens: ${costInfo.totalTokens.toLocaleString()}`);
    logger.info(`  Input Cost: $${costInfo.inputCostUSD.toFixed(4)}`);
    logger.info(`  Output Cost: $${costInfo.outputCostUSD.toFixed(4)}`);
    logger.info(`  Total Cost: $${costInfo.totalCostUSD.toFixed(4)}`);

    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    // Log to cost.log
    logCostMetrics({
      status: 'success',
      inputFile: config.paths.input,
      outputFile: config.paths.output,
      strategy: options.strategy,
      totalRows: data.length,
      rowsImproved: totalImproved,
      rowsSkipped: totalSkipped,
      rowsWithErrors: totalErrors,
      responsesImproved: totalResponsesImproved,
      apiRequests: apiStats.totalRequests,
      apiErrors: apiStats.totalErrors,
      successRate: apiStats.successRate,
      tokenUsage: {
        inputTokens: costInfo.inputTokens,
        outputTokens: costInfo.outputTokens,
        totalTokens: costInfo.totalTokens
      },
      cost: {
        inputCostUSD: costInfo.inputCostUSD,
        outputCostUSD: costInfo.outputCostUSD,
        totalCostUSD: costInfo.totalCostUSD,
        model: costInfo.model,
        pricing: costInfo.pricing
      },
      executionTimeSeconds: parseFloat(executionTime)
    });

    logger.info('\n✓ Grammar improvement complete!');
    logger.info(`  Output: ${config.paths.output}`);
    logger.info(`  Execution time: ${executionTime}s`);

  } catch (error) {
    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    // Log error to cost.log
    logCostMetrics({
      status: 'error',
      inputFile: config.paths.input,
      outputFile: config.paths.output,
      strategy: options.strategy,
      error: error.message,
      executionTimeSeconds: parseFloat(executionTime)
    });

    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { main, processRow, processRowSmart, processRowFull };
