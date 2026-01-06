#!/usr/bin/env node

/**
 * Grammar Improvement Script - ENHANCED VERSION
 *
 * Improvements:
 * - Better grammar detection and fixing
 * - More detailed prompts for AI
 * - Improved error handling
 * - Better validation of improvements
 * - Enhanced logging and debugging
 * - Fallback mechanisms for failed improvements
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
 *   --debug              Enable debug mode with verbose logging
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
  strategy: 'smart', // smart, full, or batch
  debug: false
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
    case '--debug':
      options.debug = true;
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
                       full  = Process all questions together with context consistency
                       batch = Process multiple rows at once (experimental)
  --debug              Enable debug mode with verbose logging
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
  node 1_improve-grammar.js --clear --backup true --strategy smart --debug
      `);
      process.exit(0);
  }
}

// Load configuration
let config;
try {
  config = require(path.resolve(options.configPath));
} catch (error) {
  console.error(`Error loading config from ${options.configPath}: ${error.message}`);
  process.exit(1);
}

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
  if (config.validate) {
    config.validate();
  }
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
if (options.debug) {
  logger.setLevel('debug');
}

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
  const acronyms = config.grammarImprovement?.acronyms || {};

  if (Object.keys(acronyms).length === 0) {
    return '';
  }

  let text = '\n**Known Acronyms & Their Full Forms** (always expand these):\n';
  for (const [acronym, expansion] of Object.entries(acronyms)) {
    text += `• **${acronym}** → ${expansion}\n`;
  }

  return text;
}

/**
 * Enhanced grammar issue detection
 */
function detectGrammarIssues(text) {
  if (!text || validator.isEmpty(text)) {
    return { hasIssues: false, issues: [] };
  }

  const trimmed = text.trim();
  const issues = [];

  // Skip very short responses
  if (trimmed.length < 5) {
    return { hasIssues: false, issues: [] };
  }

  // Check for acronyms that need expansion
  const acronymPattern = /\b(tlm|ptm|pbl|fln|lnf|ebrc|diet|smc|hm|ict|ssr|cwsn|ecce|mdm|pvl|bpl|tvl)\b/i;
  if (acronymPattern.test(trimmed)) {
    issues.push('unexpanded_acronyms');
  }

  // Check for camelCase (likely translation error)
  if (/[a-z][A-Z]/.test(trimmed)) {
    issues.push('camelCase');
  }

  // Check for multiple consecutive spaces
  if (/\s{2,}/.test(trimmed)) {
    issues.push('multiple_spaces');
  }

  // Check for lowercase after sentence-ending punctuation
  if (/[.!?]\s+[a-z]/.test(trimmed)) {
    issues.push('lowercase_after_punctuation');
  }

  // Check for common mistranslations
  if (/\b(306|206)\s*months?\b/i.test(trimmed)) {
    issues.push('mistranslation_months');
  }

  // Check for missing ending punctuation (for longer responses)
  if (trimmed.length > 20 && !/[.!?]$/.test(trimmed)) {
    issues.push('missing_punctuation');
  }

  // Check for run-on sentences (very long sentences without punctuation)
  const sentences = trimmed.split(/[.!?]+/);
  for (const sentence of sentences) {
    if (sentence.trim().length > 200) {
      issues.push('run_on_sentence');
      break;
    }
  }

  // Check for repeated words
  if (/\b(\w+)\s+\1\b/i.test(trimmed)) {
    issues.push('repeated_words');
  }

  // Check for basic grammar patterns
  if (/\b(is|are|was|were)\s+(is|are|was|were)\b/i.test(trimmed)) {
    issues.push('double_verbs');
  }

  // Check for unclear references
  if (/\b(this|that|it|they)\b/i.test(trimmed) && trimmed.length < 50) {
    issues.push('unclear_reference');
  }

  // Check for incomplete sentences (starts with lowercase or has no verb)
  if (/^[a-z]/.test(trimmed)) {
    issues.push('lowercase_start');
  }

  return {
    hasIssues: issues.length > 0,
    issues: issues,
    issueCount: issues.length
  };
}

/**
 * Check if response needs improvement (enhanced version)
 */
function needsImprovement(text) {
  const detection = detectGrammarIssues(text);
  
  if (options.debug && detection.hasIssues) {
    logger.debug(`  Issues detected: ${detection.issues.join(', ')}`);
  }
  
  return detection.hasIssues || (text && text.trim().length > 50);
}

/**
 * Validate improved text quality
 */
function validateImprovement(original, improved) {
  if (!improved || validator.isEmpty(improved)) {
    return { valid: false, reason: 'empty_result' };
  }

  const origTrimmed = original.trim();
  const impTrimmed = improved.trim();

  // Check if improvement is too different (might have changed meaning)
  const origWords = origTrimmed.toLowerCase().split(/\s+/);
  const impWords = impTrimmed.toLowerCase().split(/\s+/);
  
  // Count matching words
  const matchingWords = origWords.filter(word => 
    impWords.includes(word) && word.length > 3
  ).length;
  
  const matchRatio = matchingWords / Math.max(origWords.length, impWords.length);

  // If less than 30% of significant words match, improvement might have changed meaning
  if (matchRatio < 0.3 && origTrimmed.length > 20) {
    logger.warn(`  ⚠️  Low word match ratio (${(matchRatio * 100).toFixed(0)}%) - possible meaning change`);
    return { valid: false, reason: 'meaning_changed', matchRatio };
  }

  // Check if improvement is just the same text
  if (origTrimmed.toLowerCase() === impTrimmed.toLowerCase()) {
    return { valid: true, reason: 'no_changes_needed', unchanged: true };
  }

  // Check if improvement is substantially longer (might have added info)
  if (impTrimmed.length > origTrimmed.length * 1.5 && origTrimmed.length > 50) {
    logger.warn(`  ⚠️  Improvement is ${((impTrimmed.length / origTrimmed.length) * 100).toFixed(0)}% of original length`);
  }

  return { valid: true, reason: 'improved', matchRatio };
}

/**
 * STRATEGY 1: SMART - Only process responses that need improvement
 * Enhanced with better prompts and validation
 */
async function processRowSmart(row, questionColumns) {
  // Filter to only non-empty responses that need improvement
  const responsesToImprove = [];
  for (const [key, columnName] of Object.entries(questionColumns)) {
    if (columnName in row && row[columnName]) {
      const response = row[columnName];
      const detection = detectGrammarIssues(response);
      
      if (detection.hasIssues || response.trim().length > 50) {
        responsesToImprove.push({ 
          key, 
          columnName, 
          text: response,
          issues: detection.issues 
        });
        
        if (options.debug) {
          logger.debug(`  ${columnName}: ${detection.issues.join(', ')}`);
        }
      }
    }
  }

  // If nothing needs improvement, return null
  if (responsesToImprove.length === 0) {
    return { skipped: true, reason: 'no_improvement_needed' };
  }

  const acronymText = getAcronymExpansions();

  let prompt = `You are an expert editor specializing in improving educational feedback responses from teachers. These responses were originally in Hindi and have been machine-translated to English, which has introduced various grammar, clarity, and translation errors.

**Your Task:**
Improve the grammar, clarity, and readability of the teacher feedback responses while maintaining their authentic voice and original meaning.

**Critical Rules:**
1. **Preserve Original Meaning**: NEVER add information that wasn't in the original text
2. **Fix Grammar Errors**: Correct all grammatical mistakes, including:
   - Subject-verb agreement errors
   - Incorrect tense usage
   - Missing or incorrect articles (a, an, the)
   - Wrong prepositions
   - Run-on sentences (break into clear, shorter sentences)
3. **Improve Clarity**: Make the text clear and easy to understand
4. **Expand Acronyms**: When you see acronyms, expand them while keeping the acronym
   - Format: "TLM (Teaching Learning Materials)" not just "TLM" or just "Teaching Learning Materials"
5. **Fix Punctuation**: Add missing periods, commas, and other punctuation
6. **Fix Capitalization**: Ensure proper capitalization throughout
7. **Remove Extra Spaces**: Clean up any multiple spaces or weird spacing
8. **Fix Translation Errors**: Correct obvious mistranslations (e.g., "306 months" → "3-6 months")
9. **Natural Teacher Voice**: Keep the tone authentic to how a teacher would speak
10. **Consistency**: Use consistent terminology and style
${acronymText}

**Common Issues to Fix:**
- CamelCase text → Separate words properly
- Repeated words → Remove duplicates
- Missing punctuation at end of sentences
- Lowercase letters after periods
- Long run-on sentences → Break into 2-3 clear sentences
- Vague pronouns → Make references clear when possible

**Example Improvements:**

Original: "we need more tlm materials but not received from diet office student facing problem"
Improved: "We need more TLM (Teaching Learning Materials). However, we have not received them from the DIET (District Institute of Education and Training) office. Students are facing problems due to this shortage."

Original: "teacher training is good but practical implementation facing challenge smc support needed"
Improved: "Teacher training sessions have been good, but we are facing challenges with practical implementation. We need more support from the SMC (School Management Committee) to address these issues."

Now improve these responses:

`;

  // Add only responses that need improvement with their specific issues
  responsesToImprove.forEach(({ columnName, text, issues }) => {
    const issuesList = issues.length > 0 ? ` [Issues: ${issues.join(', ')}]` : '';
    prompt += `\n**${columnName}:**${issuesList}\nOriginal: "${text}"\n`;
  });

  prompt += `\n\n**IMPORTANT**: 
- Return ONLY the improved responses in the exact format requested
- Do NOT add explanations, comments, or meta-text
- Each improved response should fix ALL grammar and clarity issues
- Maintain the teacher's authentic voice and preserve all factual information
- Break long sentences into clear, concise sentences (aim for 15-25 words per sentence)
- Ensure every sentence starts with a capital letter and ends with proper punctuation`;

  // Build dynamic schema for only the responses being improved
  const fields = {};
  responsesToImprove.forEach(({ columnName }) => {
    fields[columnName] = {
      type: 'string',
      description: `Grammatically correct and clear version of the ${columnName} response. Must preserve original meaning while fixing all grammar, clarity, and translation errors.`
    };
  });

  const schema = apiManager.buildSchema(fields);

  try {
    const apiResponse = await apiManager.generateContent(prompt, schema);

    // Update row with improved responses (with validation)
    const improvements = {};
    const validationResults = {};
    
    for (const { columnName, text: originalText } of responsesToImprove) {
      if (columnName in apiResponse) {
        const improved = apiResponse[columnName];

        if (improved && !validator.isEmpty(improved)) {
          const validation = validateImprovement(originalText, improved);
          validationResults[columnName] = validation;
          
          if (validation.valid) {
            improvements[columnName] = improved.trim();
            
            if (options.debug) {
              logger.debug(`  ✓ ${columnName}: ${validation.reason}`);
              if (validation.matchRatio) {
                logger.debug(`    Match ratio: ${(validation.matchRatio * 100).toFixed(0)}%`);
              }
            }
          } else {
            logger.warn(`  ⚠️  ${columnName}: ${validation.reason} - keeping original`);
          }
        }
      }
    }

    return {
      success: true,
      improvements,
      improvedCount: Object.keys(improvements).length,
      totalResponses: responsesToImprove.length,
      validationResults
    };

  } catch (error) {
    logger.error(`Failed to process row (smart): ${error.message}`);
    throw error;
  }
}

/**
 * STRATEGY 2: FULL - Process all questions together with full context
 * Enhanced with better prompts and validation
 */
async function processRowFull(row, questionColumns) {
  // Build responses text with all questions
  const responsesText = [];
  const allResponses = [];

  for (const [qNum, colName] of Object.entries(questionColumns)) {
    const answer = row[colName] || "";
    const trimmed = answer.trim();
    
    if (trimmed) {
      const detection = detectGrammarIssues(trimmed);
      const issuesTag = detection.hasIssues ? ` [Issues: ${detection.issues.join(', ')}]` : '';
      responsesText.push(`${qNum.toUpperCase()}:${issuesTag}\n${trimmed}`);
      
      if (trimmed.length > 5) {
        allResponses.push({ qNum, colName, text: trimmed, issues: detection.issues });
      }
    } else {
      responsesText.push(`${qNum.toUpperCase()}: (empty)`);
    }
  }

  // Skip if all responses are empty
  if (allResponses.length === 0) {
    return { skipped: true, reason: 'all_empty' };
  }

  const questionList = generateQuestionList(questionColumns);
  const acronymText = getAcronymExpansions();

  const prompt = `You are an expert editor specializing in educational content. A teacher has provided feedback responses that were originally in Hindi and have been machine-translated to English. Your task is to improve ALL responses for grammar, clarity, and readability while maintaining consistency across all answers.

**Context**: The same teacher answered these ${Object.keys(questionColumns).length} questions about changes in their school:

${questionList}

**Teacher's Original Responses (with detected issues):**
${responsesText.join('\n\n')}
${acronymText}

**Comprehensive Editing Rules:**

**Grammar & Mechanics:**
1. Fix ALL grammatical errors:
   - Subject-verb agreement (e.g., "student have" → "students have")
   - Tense consistency (maintain past, present, or future appropriately)
   - Article usage (add missing "a", "an", "the")
   - Preposition errors (e.g., "good for students" not "good to students")
2. Fix punctuation:
   - Add missing periods, commas, semicolons
   - Remove extra punctuation
   - Ensure proper spacing after punctuation
3. Fix capitalization:
   - Capitalize first word of every sentence
   - Capitalize proper nouns (school names, programs, etc.)
   - Use consistent capitalization for acronyms

**Clarity & Structure:**
4. Break long run-on sentences into clear, concise sentences (15-25 words each)
5. Remove redundancy and repeated words
6. Fix translation artifacts:
   - "306 months" → "3-6 months"
   - CamelCase → proper spacing
   - Weird word order → natural English order
7. Make vague references clear when context allows
8. Format multiple items as bullet points if more than 3 distinct points

**Acronyms & Terminology:**
9. ALWAYS expand acronyms on first use: "TLM (Teaching Learning Materials)"
10. After first use in same response, acronym alone is OK: "More TLM is needed"
11. Maintain consistency: if using "TLM" in one response, use it consistently
12. Fix acronym misspellings: "PVL/TVL/BPL" → "PBL (Project-Based Learning)"

**Content Preservation:**
13. NEVER add information not in the original
14. NEVER remove important details or facts
15. Preserve all mentions of:
    - Specific challenges or problems
    - Support needs or requests
    - Student impacts
    - Resource requirements
16. Keep the authentic teacher voice (don't make it overly formal)
17. Maintain logical flow between related questions

**Consistency Across Responses:**
18. Use consistent terminology across all answers
19. Maintain consistent style and tone
20. Ensure program names and acronyms are spelled identically

**For Empty/Short Responses:**
21. If response is empty or just whitespace, return empty string ""
22. If response is under 5 characters, keep as-is unless it's obviously wrong

**Output Format:**
Return ONLY a JSON object with improved responses. No explanations, no comments, no markdown.
Each key should be the question number (Q1, Q2, etc.) and the value should be the improved response.

Example of good improvement:
Original: "teacher need training on ict but not getting proper support from diet smc also need improvement"
Improved: "Teachers need training on ICT (Information and Communication Technology). However, we are not getting proper support from the DIET (District Institute of Education and Training). The SMC (School Management Committee) also needs improvement to provide better support."`;

  // Build schema for all questions
  const fields = {};
  for (const [qNum] of Object.entries(questionColumns)) {
    fields[qNum.toUpperCase()] = {
      type: 'string',
      description: `Grammatically correct, clear, and well-structured version of ${qNum} response. Must fix all grammar errors while preserving meaning.`
    };
  }

  const schema = apiManager.buildSchema(fields);

  try {
    const apiResponse = await apiManager.generateContent(prompt, schema);

    // Update row with improved responses (with validation)
    const improvements = {};
    const validationResults = {};
    let improvedCount = 0;

    for (const [qNum, colName] of Object.entries(questionColumns)) {
      const key = qNum.toUpperCase();
      const originalText = row[colName] || '';
      
      if (key in apiResponse) {
        const improved = apiResponse[key];

        if (improved && improved.trim().length > 0) {
          const validation = validateImprovement(originalText, improved);
          validationResults[colName] = validation;
          
          if (validation.valid && !validation.unchanged) {
            improvements[colName] = improved.trim();
            improvedCount++;
            
            if (options.debug) {
              logger.debug(`  ✓ ${colName}: ${validation.reason}`);
            }
          } else if (validation.unchanged) {
            if (options.debug) {
              logger.debug(`  = ${colName}: no changes needed`);
            }
          } else {
            logger.warn(`  ⚠️  ${colName}: ${validation.reason} - keeping original`);
          }
        }
      }
    }

    return {
      success: true,
      improvements,
      improvedCount,
      totalResponses: Object.keys(questionColumns).length,
      validationResults
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
    logger.section('Grammar Improvement Script - ENHANCED VERSION');
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
    logger.info(`Debug Mode: ${options.debug ? 'ON' : 'OFF'}`);

    // Create backup if requested
    if (options.backup && config.grammarImprovement?.createBackup !== false) {
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
    let totalValidationWarnings = 0;

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

          // Count validation warnings
          if (result.validationResults) {
            const warnings = Object.values(result.validationResults).filter(
              v => !v.valid || v.matchRatio < 0.5
            ).length;
            totalValidationWarnings += warnings;
          }

          logger.info(`  ✓ Improved ${result.improvedCount}/${result.totalResponses} responses`);
          progressTracker.update('success');
          totalImproved++;
          totalResponsesImproved += result.improvedCount;
        }

      } catch (error) {
        logger.error(`  ✗ Error: ${error.message}`);
        if (options.debug && error.stack) {
          logger.debug(error.stack);
        }
        progressTracker.update('error', { error: error.message });
        totalErrors++;

        // Stop if all API keys are exhausted
        if (error.message.includes('All API keys exhausted') ||
            (error.message.includes('after') && error.message.includes('attempts'))) {
          logger.error('Critical error - stopping processing');
          break;
        }
      }

      // Save progress periodically
      if ((i + 1) % (config.processing?.saveProgressEvery || 10) === 0) {
        progressTracker.save();
        await csvHandler.write(config.paths.output, data);
        logger.info(`  💾 Progress saved (${i + 1} rows processed)`);
      }

      // Log stats periodically
      if ((i + 1) % (config.processing?.logEvery || 10) === 0 || i === data.length - 1) {
        const percentComplete = (((i + 1 - startIndex) / (data.length - startIndex)) * 100).toFixed(1);
        logger.info(`  📊 Progress: ${percentComplete}% | Improved: ${totalImproved} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`);
        if (totalValidationWarnings > 0) {
          logger.info(`  ⚠️  Validation warnings: ${totalValidationWarnings}`);
        }
      }

      // Delay between rows if configured
      const delayMs = config.processing?.delayBetweenRows || 0;
      if (delayMs > 0 && i < data.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
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
    logger.info(`  Validation Warnings: ${totalValidationWarnings}`);
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
      validationWarnings: totalValidationWarnings,
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
    if (options.debug && error.stack) {
      logger.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { 
  main, 
  processRow, 
  processRowSmart, 
  processRowFull,
  needsImprovement,
  detectGrammarIssues,
  validateImprovement
};