#!/usr/bin/env node

/**
 * Categorization Script
 * 
 * Categorizes feedback responses using AI based on configurable criteria.
 * Supports multiple questions, progress tracking, and resume capability.
 * 
 * Usage:
 *   node categorize.js [options]
 * 
 * Options:
 *   --config <path>      Path to config file (default: ./config.js)
 *   --questions <path>   Path to questions config (default: from config.js)
 *   --input <path>       Input CSV file (default: from config.js)
 *   --output <path>      Output CSV file (default: from config.js)
 *   --resume             Resume from previous progress
 *   --clear              Clear progress and start fresh
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  configPath: './config.js',
  questionsConfig: null,
  inputFile: null,
  outputFile: null,
  resume: false,
  clear: false
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--config':
      options.configPath = args[++i];
      break;
    case '--questions':
      options.questionsConfig = args[++i];
      break;
    case '--input':
      options.inputFile = args[++i];
      break;
    case '--output':
      options.outputFile = args[++i];
      break;
    case '--resume':
      options.resume = true;
      break;
    case '--clear':
      options.clear = true;
      break;
    case '--help':
      console.log(`
Categorization Script - AI-powered feedback categorization

Usage:
  node categorize.js [options]

Options:
  --config <path>      Path to config file (default: ./config.js)
  --questions <path>   Path to questions config (default: from config.js)
  --input <path>       Input CSV file (default: from config.js)
  --output <path>      Output CSV file (default: from config.js)
  --resume             Resume from previous progress
  --clear              Clear progress and start fresh
  --help               Show this help message

Environment Variables:
  API_KEYS             Comma-separated Gemini API keys (required)
  MODEL_NAME           Gemini model name (default: gemini-2.0-flash-exp)
  BATCH_SIZE           Number of rows per batch (default: 10)
  TEMPERATURE          Model temperature (default: 0.3)

Examples:
  node categorize.js --input data.csv --output results.csv
  node categorize.js --resume
  node categorize.js --clear --input data.csv
      `);
      process.exit(0);
  }
}

// Load configuration
const config = require(path.resolve(options.configPath));

// Override config with command line options
if (options.questionsConfig) {
  config.paths.questionsConfig = options.questionsConfig;
}
if (options.inputFile) {
  config.paths.input = options.inputFile;
}
if (options.outputFile) {
  config.paths.output = options.outputFile;
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
 * Load questions configuration
 */
function loadQuestionsConfig() {
  try {
    const configPath = path.resolve(config.paths.questionsConfig);
    
    if (!fs.existsSync(configPath)) {
      throw new Error(`Questions config file not found: ${configPath}`);
    }

    const configData = fs.readFileSync(configPath, 'utf8');
    const questionsConfig = JSON.parse(configData);

    // Validate questions config
    const validation = validator.validateQuestionsConfig(questionsConfig);
    
    if (!validation.valid) {
      logger.error('Questions config validation failed:');
      validation.errors.forEach(err => logger.error(`  - ${err}`));
      throw new Error('Invalid questions configuration');
    }

    if (validation.warnings.length > 0) {
      validation.warnings.forEach(warn => logger.warn(`  - ${warn}`));
    }

    logger.info(`Loaded configuration for ${Object.keys(questionsConfig).length} questions`);
    return questionsConfig;

  } catch (error) {
    logger.error(`Failed to load questions config: ${error.message}`);
    throw error;
  }
}

/**
 * Build optimized prompt for categorization (shorter, more efficient)
 */
function buildPrompt(row, questionConfig) {
  const columnName = questionConfig.column_name;
  const response = row[columnName];
  const criteria = questionConfig.categorization_criteria;

  // Shorter, more direct prompt
  let prompt = `Categorize this teacher feedback response.\n\n`;
  
  prompt += `Response: "${response}"\n\n`;
  
  if (criteria && criteria.categories) {
    prompt += `Categories:\n`;
    criteria.categories.forEach(cat => {
      const name = cat.name || cat;
      prompt += `- ${name}`;
      if (cat.keywords && cat.keywords.length > 0) {
        prompt += ` (${cat.keywords.slice(0, 3).join(', ')})`;
      }
      prompt += `\n`;
    });
  }

  prompt += `\nProvide categorization.`;

  return prompt;
}

/**
 * Build prompt for batch categorization (multiple rows at once)
 */
function buildBatchPrompt(rows, questionConfig) {
  const columnName = questionConfig.column_name;
  const criteria = questionConfig.categorization_criteria;

  let prompt = `Categorize these ${rows.length} teacher feedback responses.\n\n`;
  
  if (criteria && criteria.categories) {
    prompt += `Categories: `;
    const categories = criteria.categories.map(cat => {
      const name = cat.name || cat;
      if (cat.keywords && cat.keywords.length > 0) {
        return `${name} (${cat.keywords.slice(0, 2).join(', ')})`;
      }
      return name;
    });
    prompt += categories.join(', ') + '\n\n';
  }

  prompt += `Responses:\n`;
  rows.forEach((row, index) => {
    const response = row[columnName];
    prompt += `${index + 1}. "${response}"\n`;
  });

  prompt += `\nProvide categorization for each response in order.`;

  return prompt;
}

/**
 * Build response schema from question config
 */
function buildResponseSchema(questionConfig) {
  if (!questionConfig.response_fields) {
    return null;
  }

  return apiManager.buildSchema(questionConfig.response_fields);
}

/**
 * Build batch response schema (array of categorizations)
 */
function buildBatchResponseSchema(questionConfig, batchSize) {
  if (!questionConfig.response_fields) {
    return null;
  }

  // Create schema for array of responses
  const itemSchema = {
    type: 'object',
    properties: questionConfig.response_fields,
    required: Object.keys(questionConfig.response_fields)
  };

  return {
    type: 'array',
    items: itemSchema,
    minItems: batchSize,
    maxItems: batchSize,
    description: `Array of ${batchSize} categorization results in order`
  };
}

/**
 * Process a single row (optimized - one API call for all questions)
 */
async function processRow(row, questionsConfig) {
  const results = {};
  const questionsToProcess = [];

  // First pass: identify which questions need processing
  for (const [questionKey, questionConfig] of Object.entries(questionsConfig)) {
    const columnName = questionConfig.column_name;
    
    // Skip if column doesn't exist
    if (!(columnName in row)) {
      logger.debug(`Column '${columnName}' not found in row, skipping`);
      continue;
    }

    const response = row[columnName];

    // Skip empty responses
    if (validator.isEmpty(response)) {
      logger.debug(`Empty response for ${questionKey}, skipping`);
      
      // Set default values for empty responses
      if (questionConfig.response_fields) {
        for (const fieldName of Object.keys(questionConfig.response_fields)) {
          results[fieldName] = 'NO RESPONSE';
        }
      }
      continue;
    }

    questionsToProcess.push({ questionKey, questionConfig, response });
  }

  // If no questions to process, return defaults
  if (questionsToProcess.length === 0) {
    return results;
  }

  // Process all questions in ONE API call
  if (questionsToProcess.length > 0) {
    try {
      // Build combined prompt for all questions
      let combinedPrompt = `Categorize these ${questionsToProcess.length} responses:\n\n`;
      
      const combinedSchema = { type: 'object', properties: {} };
      
      questionsToProcess.forEach(({ questionKey, questionConfig, response }, index) => {
        const columnName = questionConfig.column_name;
        combinedPrompt += `${index + 1}. ${columnName}: "${response}"\n`;
        
        // Add fields to combined schema
        if (questionConfig.response_fields) {
          for (const [fieldName, fieldDef] of Object.entries(questionConfig.response_fields)) {
            combinedSchema.properties[fieldName] = fieldDef;
          }
        }
      });

      combinedPrompt += `\nProvide categorization for all responses.`;

      // Single API call for all questions
      const apiResponse = await apiManager.generateContent(combinedPrompt, combinedSchema);

      // Store results
      for (const { questionConfig } of questionsToProcess) {
        if (questionConfig.response_fields) {
          for (const fieldName of Object.keys(questionConfig.response_fields)) {
            if (fieldName in apiResponse) {
              results[fieldName] = apiResponse[fieldName];
            }
          }
        }
      }

    } catch (error) {
      logger.error(`Failed to process questions: ${error.message}`);
      
      // Set error values
      for (const { questionConfig } of questionsToProcess) {
        if (questionConfig.response_fields) {
          for (const fieldName of Object.keys(questionConfig.response_fields)) {
            results[fieldName] = 'ERROR';
          }
        }
      }
      
      throw error;
    }
  }

  return results;
}

/**
 * Process multiple rows as a batch (FASTEST - one API call for N rows)
 */
async function processBatch(rows, questionConfig, startIndex) {
  const results = [];
  const validRows = [];
  const rowIndices = [];

  // Filter out empty responses
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const columnName = questionConfig.column_name;
    
    if (!(columnName in row) || validator.isEmpty(row[columnName])) {
      // Empty response - set defaults
      const emptyResult = { rowIndex: startIndex + i, empty: true };
      if (questionConfig.response_fields) {
        for (const fieldName of Object.keys(questionConfig.response_fields)) {
          emptyResult[fieldName] = 'NO RESPONSE';
        }
      }
      results.push(emptyResult);
    } else {
      validRows.push(row);
      rowIndices.push(startIndex + i);
    }
  }

  // If no valid rows, return defaults
  if (validRows.length === 0) {
    return results;
  }

  // Process all valid rows in ONE API call
  try {
    const prompt = buildBatchPrompt(validRows, questionConfig);
    const schema = buildBatchResponseSchema(questionConfig, validRows.length);

    const apiResponse = await apiManager.generateContent(prompt, schema);

    // Parse array response
    const responses = Array.isArray(apiResponse) ? apiResponse : [apiResponse];

    for (let i = 0; i < validRows.length; i++) {
      const responseData = responses[i] || {};
      results.push({
        rowIndex: rowIndices[i],
        success: true,
        ...responseData
      });
    }

  } catch (error) {
    logger.error(`Batch processing failed: ${error.message}`);
    
    // Set error values for all valid rows
    for (const rowIndex of rowIndices) {
      const errorResult = { rowIndex, error: true };
      if (questionConfig.response_fields) {
        for (const fieldName of Object.keys(questionConfig.response_fields)) {
          errorResult[fieldName] = 'ERROR';
        }
      }
      results.push(errorResult);
    }
  }

  return results;
}

/**
 * Main execution function
 */
async function main() {
  try {
    logger.section('Feedback Categorization Script');
    logger.info(`Input: ${config.paths.input}`);
    logger.info(`Output: ${config.paths.output}`);
    logger.info(`Model: ${config.api.model}`);
    logger.info(`API Keys: ${config.api.keys.length}`);

    // Clear progress if requested
    if (options.clear) {
      logger.info('Clearing previous progress...');
      progressTracker.clear();
    }

    // Load questions configuration
    logger.section('Loading Questions Configuration');
    const questionsConfig = loadQuestionsConfig();

    // Load input data
    logger.section('Loading Input Data');
    const data = await csvHandler.read(config.paths.input);
    
    if (data.length === 0) {
      throw new Error('No data found in input file');
    }

    // Validate required columns
    const allColumns = Object.values(questionsConfig).map(q => q.column_name);
    csvHandler.validateColumns(data, allColumns);

    // Initialize or load progress
    let startIndex = 0;
    
    if (options.resume && progressTracker.load()) {
      startIndex = progressTracker.getNextRowIndex();
      logger.info(`Resuming from row ${startIndex}`);
    } else {
      progressTracker.initialize(data.length, {
        inputFile: config.paths.input,
        outputFile: config.paths.output,
        questionsCount: Object.keys(questionsConfig).length
      });
    }

    // Process rows with OPTIMIZED processing (one API call per row for all questions)
    logger.section('Processing Rows');
    
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let i = startIndex; i < data.length; i++) {
      const row = data[i];
      
      logger.info(`Processing row ${i + 1}/${data.length}`);

      try {
        // Process all questions for this row in ONE API call
        const categorizations = await processRow(row, questionsConfig);

        // Merge results into row
        Object.assign(row, categorizations);

        // Count how many questions were processed
        const nonEmptyCount = Object.values(categorizations).filter(v => v !== 'NO RESPONSE').length;
        
        if (nonEmptyCount > 0) {
          totalProcessed++;
          progressTracker.update('success');
        } else {
          totalSkipped++;
        }

      } catch (error) {
        logger.error(`Error processing row ${i}: ${error.message}`);
        totalErrors++;
        progressTracker.update('error', { error: error.message });
      }

      // Save progress periodically
      if ((i + 1) % config.processing.saveProgressEvery === 0) {
        progressTracker.save();
        await csvHandler.write(config.paths.output, data);
        logger.info(`Progress: Processed ${totalProcessed}, Skipped ${totalSkipped}, Errors ${totalErrors}`);
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

    logger.info('\nCategorization complete! ✓');

  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
