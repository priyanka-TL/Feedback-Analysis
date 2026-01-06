/**
 * Central Configuration File
 * 
 * This file contains all configurable parameters for the feedback analysis pipeline.
 * Modify these settings to customize the behavior of all scripts.
 */

require('dotenv').config();

module.exports = {
  // ==================== API CONFIGURATION ====================
  api: {
    // API Provider: 'gemini' or 'bedrock'
    provider: process.env.API_PROVIDER || 'gemini',
    
    // Gemini Configuration
    gemini: {
      keys: process.env.API_KEYS 
        ? process.env.API_KEYS.split(',').map(key => key.trim()).filter(key => key.length > 0)
        : [],
      model: process.env.MODEL_NAME || "gemini-2.0-flash-exp",
      temperature: parseFloat(process.env.TEMPERATURE) || 0.3,
    },
    
    // AWS Bedrock (Claude) Configuration
    bedrock: {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      model: process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      modelVersion: process.env.BEDROCK_MODEL_VERSION || 'bedrock-2023-05-31',
      temperature: parseFloat(process.env.TEMPERATURE) || 0.3,
      maxTokens: parseInt(process.env.MAX_TOKENS) || 4096,
    },
    
    // Legacy compatibility - keep for backward compatibility
    keys: process.env.API_KEYS 
      ? process.env.API_KEYS.split(',').map(key => key.trim()).filter(key => key.length > 0)
      : [],
    model: process.env.MODEL_NAME || "gemini-2.0-flash-exp",
    temperature: parseFloat(process.env.TEMPERATURE) || 0.3,
    
    // Rate limiting and retries
    maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
    initialRetryDelay: parseInt(process.env.INITIAL_RETRY_DELAY) || 2000, // ms
    requestDelay: parseInt(process.env.REQUEST_DELAY) || 1000, // ms between requests
    rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY) || 60000, // ms to wait on rate limit
    
    // Token limits
    tokensPerMinute: parseInt(process.env.TOKENS_PER_MINUTE) || 2500000,
    tokenBuffer: parseFloat(process.env.TOKEN_BUFFER) || 0.85, // Use 85% of limit
  },

  // ==================== FILE PATHS ====================
  paths: {
    input: process.env.INPUT_CSV || "./input.csv",
    output: process.env.OUTPUT_CSV || "./output.csv",
    progress: process.env.PROGRESS_FILE || "./progress.json",
    logs: process.env.LOG_DIR || "./logs",
    debug: process.env.DEBUG_DIR || "./debug",
    reports: process.env.REPORTS_DIR || "./reports",
    
    // Config files
    questionsConfig: process.env.QUESTIONS_CONFIG || "./questions-config.json",
    questionColumns: process.env.QUESTION_COLUMNS || "./question-columns.json",
  },

  // ==================== PROCESSING CONFIGURATION ====================
  processing: {
    startRow: parseInt(process.env.START_ROW) || 0,
    maxRows: process.env.MAX_ROWS ? parseInt(process.env.MAX_ROWS) : null,
    batchSize: parseInt(process.env.BATCH_SIZE) || 10,
    saveProgressEvery: parseInt(process.env.SAVE_PROGRESS_EVERY) || 10,
    logEvery: parseInt(process.env.LOG_EVERY) || 5,
    delayBetweenRows: parseInt(process.env.DELAY_BETWEEN_ROWS) || 0,
    
    // Batch processing for large datasets
    maxResponsesPerBatch: parseInt(process.env.MAX_RESPONSES_PER_BATCH) || 1000,
    skipFailedBatches: process.env.SKIP_FAILED_BATCHES === 'true',
  },

  // ==================== COLUMN NAMES ====================
  columns: {
    id: process.env.ID_COLUMN || "id",
    district: process.env.DISTRICT_COLUMN || "District",
    timestamp: process.env.TIMESTAMP_COLUMN || "Timestamp",
  },

  // ==================== TASK TYPES ====================
  tasks: {
    // Available task types
    CATEGORIZE: 'categorize',
    GRAMMAR_IMPROVE: 'grammar-improve',
    FILTER_EMPTY: 'filter-empty',
    EXTRACT_INSIGHTS: 'extract-insights',
    GENERATE_REPORT: 'generate-report',
  },

  // ==================== VALIDATION ====================
  validation: {
    // Minimum response length to consider valid
    minResponseLength: parseInt(process.env.MIN_RESPONSE_LENGTH) || 3,
    
    // Empty response indicators
    emptyIndicators: [
      'NA', 'N/A', 'na', 'n/a', '-', '--', '---',
      'none', 'None', 'NONE', 'nothing', 'Nothing', 'NOTHING',
      '', ' ', '  '
    ],
  },

  // ==================== CATEGORIZATION ====================
  categorization: {
    // Question configuration file
    configFile: process.env.QUESTIONS_CONFIG || "./questions-config.json",
    
    // Response schema generation
    includeReasoning: process.env.INCLUDE_REASONING !== 'false',
    allowNewCategories: process.env.ALLOW_NEW_CATEGORIES === 'true',
  },

  // ==================== GRAMMAR IMPROVEMENT ====================
  grammarImprovement: {
    // Preserve original formatting
    preserveFormatting: process.env.PRESERVE_FORMATTING !== 'false',
    
    // Create backup before processing
    createBackup: process.env.CREATE_BACKUP !== 'false',
    
    // Acronyms to expand
    acronyms: {
      'TLM': 'Teaching Learning Material',
      'PTM': 'Parent Teacher Meeting',
      'PBL': 'Project-Based Learning',
      'LNF': 'Literacy Numeracy Fest',
      'FLN': 'Foundational Literacy and Numeracy',
      'EBRC': 'Education Block Resource Centre',
      'HM': 'Headmaster',
      'DIET': 'District Institute of Education and Training',
      'ICT': 'Information and Communication Technology',
      'SMC': 'School Management Committee',
    },
  },

  // ==================== INSIGHT EXTRACTION ====================
  insights: {
    // Key metrics to extract
    extractMetrics: true,
    includeExamples: true,
    examplesPerItem: parseInt(process.env.EXAMPLES_PER_ITEM) || 3,
    minItemMentions: parseInt(process.env.MIN_ITEM_MENTIONS) || 1,
  },

  // ==================== LOGGING ====================
  logging: {
    level: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
    includeTimestamp: true,
    includeMetadata: true,
    colorize: process.env.COLORIZE_LOGS !== 'false',
  },

  // ==================== VALIDATION FUNCTION ====================
  validate() {
    const errors = [];

    const provider = this.api.provider.toLowerCase();

    // Validate based on provider
    if (provider === 'gemini') {
      if (!this.api.gemini.keys || this.api.gemini.keys.length === 0) {
        errors.push('No Gemini API keys provided. Set the API_KEYS environment variable.');
      }
    } else if (provider === 'bedrock') {
      if (!this.api.bedrock.accessKeyId || !this.api.bedrock.secretAccessKey) {
        errors.push('AWS credentials not provided. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
      }
      if (!this.api.bedrock.region) {
        errors.push('AWS region not provided. Set AWS_REGION.');
      }
    } else {
      errors.push(`Unknown API provider: ${provider}. Use 'gemini' or 'bedrock'.`);
    }

    // Validate file paths
    if (!this.paths.input) {
      errors.push('Input file path not specified.');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    return true;
  }
};
