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
  questionsConfig: './questions-config-single.json',
  inputFile: 'Final_Report/singleQ.csv',
  outputFile: 'Final_Report/singleQ_output.csv',
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

// ==================== STATE MANAGEMENT FOR DISCOVERED CATEGORIES ====================
class DiscoveredCategoriesTracker {
  constructor(questionsConfig) {
    this.discoveredCategories = {};

    // Initialize per-question tracking
    if (questionsConfig) {
      Object.keys(questionsConfig).forEach((questionKey) => {
        const questionConfig = questionsConfig[questionKey];
        this.discoveredCategories[questionKey] = {};

        if (questionConfig.response_fields) {
          Object.entries(questionConfig.response_fields).forEach(([fieldName, fieldDef]) => {
            if (fieldDef.allow_new_categories) {
              this.discoveredCategories[questionKey][fieldName] = new Set();
            }
          });
        }
      });
    }
  }

  addDiscoveredCategory(questionKey, fieldName, category) {
    if (
      category &&
      this.discoveredCategories[questionKey] &&
      this.discoveredCategories[questionKey][fieldName] &&
      !this.discoveredCategories[questionKey][fieldName].has(category)
    ) {
      this.discoveredCategories[questionKey][fieldName].add(category);
      logger.info(`[${questionKey}.${fieldName}] New category discovered: ${category}`);
    }
  }

  getDiscoveredCategories(questionKey, fieldName) {
    if (
      this.discoveredCategories[questionKey] &&
      this.discoveredCategories[questionKey][fieldName]
    ) {
      return Array.from(this.discoveredCategories[questionKey][fieldName]);
    }
    return [];
  }

  getAllDiscovered() {
    const result = {};
    Object.keys(this.discoveredCategories).forEach((qKey) => {
      result[qKey] = {};
      Object.keys(this.discoveredCategories[qKey]).forEach((fName) => {
        result[qKey][fName] = Array.from(this.discoveredCategories[qKey][fName]);
      });
    });
    return result;
  }
}

// ==================== TEXT PREPROCESSING ====================
function preprocessResponse(text) {
  if (!text || text.trim() === '') return '';

  return text
    // Remove HTML tags and entities
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Remove leading/trailing punctuation artifacts
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
}

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
    const rawConfig = JSON.parse(configData);

    // Convert array format to object format for easier access
    let questionsConfig;
    if (Array.isArray(rawConfig.questions)) {
      // Convert from array format: { questions: [{id, ...}] } to object format: { q1: {...}, q2: {...} }
      questionsConfig = {};
      rawConfig.questions.forEach(question => {
        // Convert response_fields array to object for compatibility
        const responseFields = {};
        if (Array.isArray(question.response_fields)) {
          question.response_fields.forEach(field => {
            responseFields[field.name] = {
              type: field.type,
              description: field.description,
              enum: field.enum,
              allow_multiple_categories: field.allow_multiple_categories,
              allow_new_categories: field.allow_new_categories
            };
          });
        }

        questionsConfig[question.id] = {
          column_name: question.csv_column,
          question_text: question.question_text,
          categorization_criteria: question.categorization_criteria,
          response_fields: responseFields
        };
      });
    } else {
      // Already in object format
      questionsConfig = rawConfig;
    }

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
 * Build combined prompt for all questions with discovered categories
 */
function buildCombinedPrompt(questionsToProcess, categoriesTracker) {
  let prompt = `You are an expert education researcher analyzing teacher feedback about school changes. You will analyze responses to multiple questions simultaneously and provide comprehensive categorizations.
IMPORTANT: You must analyze ALL questions and provide categorizations for each one in a single response.

`;

  // Add each question and its response
  questionsToProcess.forEach(({ questionKey, questionConfig, response }, index) => {
    // Build field-specific instructions FIRST
    let fieldInstructions = '';
    if (questionConfig.response_fields) {
      Object.entries(questionConfig.response_fields).forEach(([fieldName, fieldDef]) => {
        if (fieldName === 'reasoning') return; // Skip reasoning, handled separately

        const discoveredCats = categoriesTracker.getDiscoveredCategories(questionKey, fieldName);
        const emergingSection = discoveredCats.length > 0
          ? ` EMERGING CATEGORIES (discovered so far): ${discoveredCats.join(', ')}`
          : '';

        const multiCategoryNote = fieldDef.allow_multiple_categories
          ? 'MULTIPLE categories allowed'
          : 'SINGLE category only';

        const newCategoryNote = fieldDef.allow_new_categories
          ? ' | Can suggest NEW category if none fit well'
          : ' | Must use predefined categories only';

        fieldInstructions += `  • ${fieldName}: ${multiCategoryNote}${newCategoryNote}${emergingSection}\n`;
      });
    }

    prompt += `
${'='.repeat(80)}
QUESTION ${index + 1} [ID: ${questionKey}]
${'='.repeat(80)}

QUESTION ASKED TO TEACHER:
"${questionConfig.question_text || questionConfig.column_name}"

TEACHER'S RESPONSE:
"${response}"

CATEGORIZATION INSTRUCTIONS:
${questionConfig.categorization_criteria || 'Categorize this response appropriately.'}

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
${'='.repeat(80)}
FINAL INSTRUCTIONS
${'='.repeat(80)}

Analyze ALL ${questionsToProcess.length} questions above and provide categorizations for each one following the schema provided. Each question should be analyzed independently with its own categorization and reasoning.

Your response must include results for all question IDs: ${questionsToProcess.map(({ questionKey }) => questionKey).join(', ')}
`;

  return prompt;
}

/**
 * Process a single row (optimized - one API call for all questions)
 */
async function processRow(row, questionsConfig, categoriesTracker) {
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

    const rawResponse = row[columnName];
    const response = preprocessResponse(rawResponse);

    // Skip empty responses
    if (validator.isEmpty(response)) {
      logger.debug(`Empty response for ${questionKey}, skipping`);

      // Set default values for empty responses
      if (questionConfig.response_fields) {
        for (const fieldName of Object.keys(questionConfig.response_fields)) {
          results[`${questionKey}_${fieldName}`] = 'NO RESPONSE';
        }
        // Add new category suggestion fields
        Object.entries(questionConfig.response_fields).forEach(([fieldName, fieldDef]) => {
          if (fieldDef.allow_new_categories) {
            results[`${questionKey}_${fieldName}_new_category_suggestion`] = '';
          }
        });
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
      // Build combined prompt with discovered categories
      const combinedPrompt = buildCombinedPrompt(questionsToProcess, categoriesTracker);

      // Build combined schema
      const combinedSchema = { type: 'object', properties: {}, required: [] };

      questionsToProcess.forEach(({ questionKey, questionConfig }) => {
        const questionProperties = {};
        const questionRequired = [];

        // Add fields to schema
        if (questionConfig.response_fields) {
          Object.entries(questionConfig.response_fields).forEach(([fieldName, fieldDef]) => {
            // Build clean schema property without metadata fields
            const cleanFieldDef = {};

            // Handle different field types
            if (fieldDef.type === 'enum') {
              // For enum fields, use STRING type with enum values
              cleanFieldDef.type = 'string';
              cleanFieldDef.description = fieldDef.description;
              if (fieldDef.enum) {
                cleanFieldDef.enum = fieldDef.enum;
              }
            } else if (fieldDef.type === 'array') {
              cleanFieldDef.type = 'array';
              cleanFieldDef.description = fieldDef.description;
              if (fieldDef.items) {
                cleanFieldDef.items = fieldDef.items;
              } else {
                // Default items type if not specified
                cleanFieldDef.items = { type: 'string' };
              }
            } else {
              // string, object, or other types
              cleanFieldDef.type = fieldDef.type;
              cleanFieldDef.description = fieldDef.description;
            }

            questionProperties[fieldName] = cleanFieldDef;
            questionRequired.push(fieldName);

            // Add new category suggestion field
            if (fieldDef.allow_new_categories) {
              questionProperties[`${fieldName}_new_category_suggestion`] = {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  justification: { type: 'string' },
                  similar_to_existing: { type: 'string' }
                },
                nullable: true
              };
            }
          });
        }

        combinedSchema.properties[questionKey] = {
          type: 'object',
          properties: questionProperties,
          required: questionRequired
        };
        combinedSchema.required.push(questionKey);
      });

      // Single API call for all questions
      const apiResponse = await apiManager.generateContent(combinedPrompt, combinedSchema);

      // Store results and track discovered categories
      for (const { questionKey, questionConfig } of questionsToProcess) {
        const questionResult = apiResponse[questionKey];

        if (questionConfig.response_fields) {
          Object.entries(questionConfig.response_fields).forEach(([fieldName, fieldDef]) => {
            const value = questionResult?.[fieldName];
            results[`${questionKey}_${fieldName}`] = value || '';

            // Track new categories
            if (fieldDef.allow_new_categories) {
              const newCatSuggestion = questionResult?.[`${fieldName}_new_category_suggestion`];
              if (newCatSuggestion?.name) {
                categoriesTracker.addDiscoveredCategory(questionKey, fieldName, newCatSuggestion.name);
                results[`${questionKey}_${fieldName}_new_category_suggestion`] = JSON.stringify(newCatSuggestion);
              } else {
                results[`${questionKey}_${fieldName}_new_category_suggestion`] = '';
              }

              // Track categories from array responses
              if (fieldDef.type === 'array' && Array.isArray(value)) {
                value.forEach(cat => categoriesTracker.addDiscoveredCategory(questionKey, fieldName, cat));
              }

              // Track single category values
              if (fieldDef.type === 'string' && value) {
                categoriesTracker.addDiscoveredCategory(questionKey, fieldName, value);
              }
            }
          });
        }
      }

    } catch (error) {
      logger.error(`Failed to process questions: ${error.message}`);

      // Set error values
      for (const { questionKey, questionConfig } of questionsToProcess) {
        if (questionConfig.response_fields) {
          Object.entries(questionConfig.response_fields).forEach(([fieldName, fieldDef]) => {
            results[`${questionKey}_${fieldName}`] = 'ERROR';
            if (fieldDef.allow_new_categories) {
              results[`${questionKey}_${fieldName}_new_category_suggestion`] = '';
            }
          });
        }
      }

      throw error;
    }
  }

  return results;
}

/**
 * Log execution metrics to cost.log file
 */
function logCostMetrics(metrics) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    script: "3_categorize.js",
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

    // Initialize discovered categories tracker
    const categoriesTracker = new DiscoveredCategoriesTracker(questionsConfig);

    // Load input data
    logger.section('Loading Input Data');
    const data = await csvHandler.read(config.paths.input);
    
    if (data.length === 0) {
      throw new Error('No data found in input file');
    }

    // Validate required columns
    const allColumns = Object.values(questionsConfig).map(q => q.column_name);
    console.log(allColumns,"alll")
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
        const categorizations = await processRow(row, questionsConfig, categoriesTracker);

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
    const costInfo = apiManager.calculateCost();

    logger.info('\n📊 API Statistics:');
    logger.info(`  Total Requests: ${apiStats.totalRequests}`);
    logger.info(`  Total Errors: ${apiStats.totalErrors}`);
    logger.info(`  Success Rate: ${apiStats.successRate}`);

    logger.info('\n💰 Token Usage & Cost:');
    logger.info(`  Input Tokens: ${costInfo.inputTokens.toLocaleString()}`);
    logger.info(`  Output Tokens: ${costInfo.outputTokens.toLocaleString()}`);
    logger.info(`  Total Tokens: ${costInfo.totalTokens.toLocaleString()}`);
    logger.info(`  Model: ${costInfo.model}`);
    logger.info(`  Input Cost: $${costInfo.inputCostUSD.toFixed(4)}`);
    logger.info(`  Output Cost: $${costInfo.outputCostUSD.toFixed(4)}`);
    logger.info(`  Total Cost: $${costInfo.totalCostUSD.toFixed(4)}`);

    // Log discovered categories
    const allDiscovered = categoriesTracker.getAllDiscovered();
    const hasDiscoveredCategories = Object.values(allDiscovered).some(qCats =>
      Object.values(qCats).some(cats => cats.length > 0)
    );

    const discoveredCategoriesSummary = {};
    if (hasDiscoveredCategories) {
      logger.info('\n🔍 Discovered Categories:');
      Object.entries(allDiscovered).forEach(([questionKey, fieldCategories]) => {
        const hasCategories = Object.values(fieldCategories).some(cats => cats.length > 0);
        if (hasCategories) {
          logger.info(`\n${questionKey}:`);
          discoveredCategoriesSummary[questionKey] = {};
          Object.entries(fieldCategories).forEach(([fieldName, categories]) => {
            if (categories.length > 0) {
              logger.info(`  ${fieldName}: ${categories.join(', ')}`);
              discoveredCategoriesSummary[questionKey][fieldName] = categories;
            }
          });
        }
      });
    }

    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    // Log to cost.log
    logCostMetrics({
      status: 'success',
      inputFile: config.paths.input,
      outputFile: config.paths.output,
      questionsCount: Object.keys(questionsConfig).length,
      totalRows: data.length,
      rowsProcessed: totalProcessed,
      rowsSkipped: totalSkipped,
      rowsWithErrors: totalErrors,
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
      discoveredCategories: discoveredCategoriesSummary,
      executionTimeSeconds: parseFloat(executionTime)
    });

    logger.info('\n✅ Categorization complete!');
    logger.info(`⏱️  Execution time: ${executionTime}s`);

  } catch (error) {
    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    // Log error to cost.log
    logCostMetrics({
      status: 'error',
      inputFile: config.paths.input,
      outputFile: config.paths.output,
      error: error.message,
      executionTimeSeconds: parseFloat(executionTime)
    });

    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
