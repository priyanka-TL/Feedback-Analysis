/**
 * API Manager Utility
 * 
 * Manages Gemini API interactions with key rotation, rate limiting, and retry logic.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

class APIManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.apiKeys = config.api.keys;
    this.currentKeyIndex = 0;
    this.models = new Map();
    this.requestCount = 0;
    this.errorCount = 0;
    
    // Token tracking for rate limiting
    this.tokenUsage = {
      count: 0,
      resetTime: Date.now() + 60000 // Reset every minute
    };

    // Initialize models for all keys
    this._initializeModels();
  }

  /**
   * Initialize Gemini models for all API keys
   */
  _initializeModels() {
    if (!this.apiKeys || this.apiKeys.length === 0) {
      throw new Error('No API keys provided');
    }

    this.apiKeys.forEach((key, index) => {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({
        model: this.config.api.model,
        generationConfig: {
          temperature: this.config.api.temperature,
          responseMimeType: "application/json"
        }
      });
      
      this.models.set(index, model);
    });

    this.logger.info(`Initialized ${this.apiKeys.length} API key(s)`);
  }

  /**
   * Get current active model
   * @returns {object} Gemini model instance
   */
  _getCurrentModel() {
    return this.models.get(this.currentKeyIndex);
  }

  /**
   * Rotate to next API key
   */
  _rotateKey() {
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    this.logger.debug(`Rotated to API key ${this.currentKeyIndex + 1}/${this.apiKeys.length}`);
  }

  /**
   * Check and update token usage for rate limiting
   * @param {number} estimatedTokens - Estimated tokens for this request
   */
  _checkRateLimit(estimatedTokens = 1000) {
    const now = Date.now();
    
    // Reset counter if minute has passed
    if (now >= this.tokenUsage.resetTime) {
      this.tokenUsage.count = 0;
      this.tokenUsage.resetTime = now + 60000;
    }

    // Check if we're approaching the limit
    const limit = this.config.api.tokensPerMinute * this.config.api.tokenBuffer;
    if (this.tokenUsage.count + estimatedTokens > limit) {
      const waitTime = this.tokenUsage.resetTime - now;
      this.logger.warn(`Approaching rate limit. Waiting ${waitTime}ms`);
      return waitTime;
    }

    this.tokenUsage.count += estimatedTokens;
    return 0;
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate content with retry logic
   * @param {string} prompt - Prompt text
   * @param {object} schema - Response schema (optional)
   * @param {object} options - Additional options
   * @returns {Promise<object>} API response
   */
  async generateContent(prompt, schema = null, options = {}) {
    const maxRetries = options.maxRetries || this.config.api.maxRetries;
    const estimatedTokens = Math.ceil(prompt.length / 4); // Rough estimate
    
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Check rate limit
        const waitTime = this._checkRateLimit(estimatedTokens);
        if (waitTime > 0) {
          await this._sleep(waitTime);
        }

        // Add delay between requests
        if (this.requestCount > 0) {
          await this._sleep(this.config.api.requestDelay);
        }

        // Get current model
        const model = this._getCurrentModel();

        // Generate content with schema if provided
        let result;
        if (schema) {
          result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: this.config.api.temperature,
              responseMimeType: "application/json",
              responseSchema: schema
            }
          });
        } else {
          result = await model.generateContent(prompt);
        }

        this.requestCount++;

        // Extract response text
        const responseText = result.response.text();
        
        // Parse JSON response
        try {
          return JSON.parse(responseText);
        } catch (parseError) {
          this.logger.warn('Failed to parse JSON response, returning raw text');
          return { text: responseText };
        }

      } catch (error) {
        lastError = error;
        this.errorCount++;

        // Log the error
        this.logger.warn(`API request failed (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);

        // Handle rate limiting
        if (error.message.includes('429') || error.message.includes('RATE_LIMIT')) {
          this.logger.warn('Rate limit hit, waiting before retry');
          await this._sleep(this.config.api.rateLimitDelay);
          this._rotateKey(); // Try next key
          continue;
        }

        // Handle quota exceeded
        if (error.message.includes('quota') || error.message.includes('RESOURCE_EXHAUSTED')) {
          this.logger.warn('Quota exceeded, rotating to next key');
          this._rotateKey();
          await this._sleep(5000);
          continue;
        }

        // Exponential backoff for other errors
        if (attempt < maxRetries - 1) {
          const delay = this.config.api.initialRetryDelay * Math.pow(2, attempt);
          this.logger.debug(`Waiting ${delay}ms before retry`);
          await this._sleep(delay);
        }
      }
    }

    // All retries failed
    throw new Error(`API request failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Generate batch of content with parallel processing
   * @param {Array<object>} items - Array of {prompt, schema} objects
   * @param {number} concurrency - Number of concurrent requests
   * @returns {Promise<Array>} Array of responses
   */
  async generateBatch(items, concurrency = 3) {
    const results = [];
    const errors = [];

    this.logger.info(`Processing batch of ${items.length} items with concurrency ${concurrency}`);

    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      
      const batchPromises = batch.map(async (item, index) => {
        try {
          const result = await this.generateContent(item.prompt, item.schema, item.options);
          return { success: true, index: i + index, result };
        } catch (error) {
          this.logger.error(`Batch item ${i + index} failed: ${error.message}`);
          return { success: false, index: i + index, error: error.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach(br => {
        if (br.success) {
          results.push(br.result);
        } else {
          errors.push({ index: br.index, error: br.error });
        }
      });

      this.logger.progress(i + batch.length, items.length, `Completed ${results.length}, Errors: ${errors.length}`);
    }

    return { results, errors };
  }

  /**
   * Build response schema for structured output
   * @param {object} fields - Field definitions
   * @returns {object} JSON schema
   */
  buildSchema(fields) {
    const properties = {};
    const required = [];

    for (const [fieldName, fieldConfig] of Object.entries(fields)) {
      // Handle different field types
      if (fieldConfig.type === 'array' && fieldConfig.items) {
        properties[fieldName] = {
          type: 'array',
          description: fieldConfig.description || '',
          items: {
            type: fieldConfig.items.type || 'string',
            enum: fieldConfig.items.enum || undefined
          }
        };
      } else if (fieldConfig.enum) {
        properties[fieldName] = {
          type: fieldConfig.type || 'string',
          description: fieldConfig.description || '',
          enum: fieldConfig.enum
        };
      } else {
        properties[fieldName] = {
          type: fieldConfig.type || 'string',
          description: fieldConfig.description || ''
        };
      }

      // Add to required if specified
      if (fieldConfig.required !== false) {
        required.push(fieldName);
      }
    }

    return {
      type: 'object',
      properties,
      required
    };
  }

  /**
   * Get API usage statistics
   * @returns {object} Usage stats
   */
  getStats() {
    return {
      totalRequests: this.requestCount,
      totalErrors: this.errorCount,
      currentKeyIndex: this.currentKeyIndex + 1,
      totalKeys: this.apiKeys.length,
      successRate: this.requestCount > 0 
        ? (((this.requestCount - this.errorCount) / this.requestCount) * 100).toFixed(1) + '%'
        : '0%'
    };
  }
}

module.exports = APIManager;
