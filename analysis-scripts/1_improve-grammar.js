#!/usr/bin/env node

/**
 * Grammar Improvement Script
 * 
 * Improves grammar, clarity, and readability of feedback responses while preserving meaning.
 * Handles acronym expansion and maintains context.
 * 
 * Usage:
 *   node improve-grammar.js [options]
 * 
 * Options:
 *   --config <path>      Path to config file (default: ./config.js)
 *   --input <path>       Input CSV file (default: from config.js)
 *   --output <path>      Output CSV file (default: from config.js)
 *   --columns <path>     Path to question columns config (optional)
 *   --resume             Resume from previous progress
 *   --clear              Clear progress and start fresh
 *   --backup             Create backup before processing (default: true)
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  configPath: './config.js',
  inputFile: null,
  outputFile: null,
  columnsConfig: null,
  resume: false,
  clear: false,
  backup: true
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
    case '--help':
      console.log(`
Grammar Improvement Script - AI-powered text improvement

Usage:
  node improve-grammar.js [options]

Options:
  --config <path>      Path to config file (default: ./config.js)
  --input <path>       Input CSV file (default: from config.js)
  --output <path>      Output CSV file (default: from config.js)
  --columns <path>     Path to question columns config (optional)
  --resume             Resume from previous progress
  --clear              Clear progress and start fresh
  --backup             Create backup before processing (default: true)
  --help               Show this help message

Environment Variables:
  API_KEYS             Comma-separated Gemini API keys (required)
  MODEL_NAME           Gemini model name (default: gemini-2.0-flash-exp)
  TEMPERATURE          Model temperature (default: 0.3)

Examples:
  node improve-grammar.js --input data.csv --output improved.csv
  node improve-grammar.js --resume
  node improve-grammar.js --clear --backup true
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
    const configPath = path.resolve(config.paths.questionColumns);
    
    // If config file doesn't exist, return default columns
    if (!fs.existsSync(configPath)) {
      logger.warn('Question columns config not found, using default Q1-Q8');
      return {
        q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4',
        q5: 'Q5', q6: 'Q6', q7: 'Q7', q8: 'Q8'
      };
    }

    const configData = fs.readFileSync(configPath, 'utf8');
    const questionColumns = JSON.parse(configData);

    logger.info(`Loaded ${Object.keys(questionColumns).length} question columns`);
    return questionColumns;

  } catch (error) {
    logger.error(`Failed to load question columns: ${error.message}`);
    throw error;
  }
}

/**
 * Get acronym expansions text
 */
function getAcronymExpansions() {
  const acronyms = config.grammarImprovement.acronyms;
  
  if (!acronyms || Object.keys(acronyms).length === 0) {
    return '';
  }

  let text = '\n\nKnown Acronyms to expand if found:\n';
  for (const [acronym, expansion] of Object.entries(acronyms)) {
    text += `- ${acronym} = ${expansion}\n`;
  }
  
  return text;
}

/**
 * Check if response needs improvement (skip if already good)
 */
function needsImprovement(text) {
  if (!text || validator.isEmpty(text)) return false;
  
  const trimmed = text.trim();
  
  // Skip very short responses (likely already concise)
  if (trimmed.length < 10) return false;
  
  // Check for obvious issues that need fixing
  const hasIssues = 
    /\b(tlm|ptm|fln|diet|smdc|smc)\b/i.test(trimmed) || // Has acronyms
    /[a-z][A-Z]/.test(trimmed) || // Has camelCase (likely error)
    /\s{2,}/.test(trimmed) || // Multiple spaces
    /[.!?]\s*[a-z]/.test(trimmed) || // Lowercase after punctuation
    !/[.!?]$/.test(trimmed); // Missing ending punctuation
  
  return hasIssues || trimmed.length > 50; // Improve if has issues or is substantial
}

/**
 * Build prompt for grammar improvement (optimized - only non-empty responses)
 */
function buildPrompt(row, questionColumns) {
  const acronymText = getAcronymExpansions();
  
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
    return null;
  }
  
  let prompt = `You are an expert editor improving teacher feedback responses. Your task is to:

1. Fix grammar, spelling, and punctuation errors
2. Improve clarity and readability
3. Expand acronyms where appropriate
4. Maintain the original meaning and tone
5. Keep responses concise and professional
6. Preserve context from the full response

${acronymText}

IMPORTANT: 
- Do NOT change the meaning or add information not present in the original
- Do NOT make responses too formal - maintain a natural teaching tone
- If the response is already clear and correct, minimal changes are acceptable
- Preserve formatting like bullet points or numbers if present

Here are the responses to improve:

`;

  // Add only responses that need improvement
  responsesToImprove.forEach(({ columnName, text }) => {
    prompt += `\n${columnName}: "${text}"`;
  });

  prompt += `\n\nPlease improve each response above, returning them in the same order.`;

  return { prompt, responsesToImprove };
}

/**
 * Build response schema for improved responses (optimized - only needed fields)
 */
function buildResponseSchema(responsesToImprove) {
  const fields = {};

  responsesToImprove.forEach(({ columnName }) => {
    fields[columnName] = {
      type: 'string',
      description: `Improved version of ${columnName} response`
    };
  });

  return apiManager.buildSchema(fields);
}

/**
 * Process a single row (optimized)
 */
async function processRow(row, questionColumns) {
  // Build prompt and schema (returns null if nothing needs improvement)
  const promptData = buildPrompt(row, questionColumns);
  
  if (!promptData) {
    logger.debug('Row has no content needing improvement, skipping');
    return { skipped: true, reason: 'no_improvement_needed' };
  }

  const { prompt, responsesToImprove } = promptData;
  const schema = buildResponseSchema(responsesToImprove);

  try {
    // Generate improved responses
    const apiResponse = await apiManager.generateContent(prompt, schema);

    // Update row with improved responses
    const improvements = {};
    for (const { columnName } of responsesToImprove) {
      if (columnName in apiResponse) {
        const improved = apiResponse[columnName];
        
        // Only update if we got a valid improvement
        if (improved && !validator.isEmpty(improved)) {
          improvements[columnName] = improved.trim();
        }
      }
    }

    return { success: true, improvements, improvedCount: Object.keys(improvements).length };

  } catch (error) {
    logger.error(`Failed to process row: ${error.message}`);
    throw error;
  }
}

/**
 * Process multiple rows in a batch (for better throughput)
 */
async function processBatch(rows, questionColumns, startIndex) {
  const results = [];
  
  for (let i = 0; i < rows.length; i++) {
    const rowIndex = startIndex + i;
    const row = rows[i];
    
    try {
      const result = await processRow(row, questionColumns);
      result.rowIndex = rowIndex;
      results.push(result);
      
      if (result.success) {
        Object.assign(row, result.improvements);
        logger.info(`Row ${rowIndex}: Improved ${result.improvedCount} responses`);
      } else if (result.skipped) {
        logger.debug(`Row ${rowIndex}: Skipped (${result.reason})`);
      }
      
    } catch (error) {
      logger.error(`Row ${rowIndex}: Error - ${error.message}`);
      results.push({ error: true, rowIndex, message: error.message });
    }
  }
  
  return results;
}

/**
 * Main execution function
 */
async function main() {
  try {
    logger.section('Grammar Improvement Script');
    logger.info(`Input: ${config.paths.input}`);
    logger.info(`Output: ${config.paths.output}`);
    logger.info(`Model: ${config.api.model}`);

    // Create backup if requested
    if (options.backup && config.grammarImprovement.createBackup) {
      logger.section('Creating Backup');
      const backupPath = csvHandler.backup(config.paths.input);
      logger.info(`Backup created: ${backupPath}`);
    }

    // Clear progress if requested
    if (options.clear) {
      logger.info('Clearing previous progress...');
      progressTracker.clear();
    }

    // Load question columns configuration
    logger.section('Loading Configuration');
    const questionColumns = loadQuestionColumns();
    logger.info(`Processing columns: ${Object.values(questionColumns).join(', ')}`);

    // Load input data
    logger.section('Loading Input Data');
    const data = await csvHandler.read(config.paths.input);
    
    if (data.length === 0) {
      throw new Error('No data found in input file');
    }

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
        columnsCount: existingColumns.length
      });
    }

    // Process rows in optimized batches
    logger.section('Processing Rows');
    
    const BATCH_SIZE = config.processing.batchSize || 5; // Process 5 rows at a time
    let totalImproved = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    
    for (let i = startIndex; i < data.length; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, data.length);
      const batch = data.slice(i, batchEnd);
      
      logger.info(`\nProcessing batch: rows ${i}-${batchEnd-1} (${batch.length} rows)`);
      
      try {
        // Process batch
        const results = await processBatch(batch, questionColumns, i);
        
        // Update progress tracker
        for (const result of results) {
          if (result.error) {
            progressTracker.update('error', { error: result.message });
            totalErrors++;
          } else if (result.skipped) {
            progressTracker.update('skipped');
            totalSkipped++;
          } else if (result.success) {
            progressTracker.update('success');
            totalImproved++;
          }
        }
        
        // Save progress after each batch
        progressTracker.save();
        await csvHandler.write(config.paths.output, data);
        
        logger.info(`Batch complete: ${totalImproved} improved, ${totalSkipped} skipped, ${totalErrors} errors`);
        
      } catch (error) {
        logger.error(`Batch error: ${error.message}`);
        // Continue with next batch
      }

      // Add delay between batches if configured
      if (config.processing.delayBetweenRows > 0 && batchEnd < data.length) {
        await new Promise(resolve => setTimeout(resolve, config.processing.delayBetweenRows));
      }
    }

    // Final save
    logger.section('Saving Results');
    await csvHandler.write(config.paths.output, data);
    progressTracker.save();

    // Log summary
    progressTracker.logSummary();
    
    const apiStats = apiManager.getStats();
    logger.info('\nAPI Statistics:');
    logger.info(`  Total Requests: ${apiStats.totalRequests}`);
    logger.info(`  Total Errors: ${apiStats.totalErrors}`);
    logger.info(`  Success Rate: ${apiStats.successRate}`);

    logger.info('\nGrammar improvement complete! ✓');

  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
