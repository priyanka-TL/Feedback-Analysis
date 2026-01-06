/**
 * Multi-Provider API Manager
 * 
 * Manages API interactions for multiple providers (Gemini and AWS Bedrock)
 * with key rotation, rate limiting, and retry logic.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

class APIManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.provider = config.api.provider.toLowerCase();
    this.requestCount = 0;
    this.errorCount = 0;
    
    // Token tracking for rate limiting
    this.tokenUsage = {
      count: 0,
      resetTime: Date.now() + 60000 // Reset every minute
    };

    // Token usage statistics
    this.totalTokens = {
      promptTokens: 0,
      candidatesTokens: 0,
      totalTokens: 0
    };

    // Initialize the appropriate provider
    this._initializeProvider();
  }

  /**
   * Initialize API provider based on configuration
   */
  _initializeProvider() {
    if (this.provider === 'gemini') {
      this._initializeGemini();
    } else if (this.provider === 'bedrock') {
      this._initializeBedrock();
    } else {
      throw new Error(`Unsupported API provider: ${this.provider}`);
    }
  }

  /**
   * Initialize Gemini models
   */
  _initializeGemini() {
    this.apiKeys = this.config.api.gemini.keys;
    this.currentKeyIndex = 0;
    this.models = new Map();

    if (!this.apiKeys || this.apiKeys.length === 0) {
      throw new Error('No Gemini API keys provided');
    }

    this.apiKeys.forEach((key, index) => {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({
        model: this.config.api.gemini.model,
        generationConfig: {
          temperature: this.config.api.gemini.temperature,
          responseMimeType: "application/json"
        }
      });
      
      this.models.set(index, model);
    });

    this.logger.info(`Initialized Gemini provider with ${this.apiKeys.length} API key(s)`);
    this.logger.info(`Model: ${this.config.api.gemini.model}`);
  }

  /**
   * Initialize AWS Bedrock client
   */
  _initializeBedrock() {
    const bedrockConfig = this.config.api.bedrock;

    if (!bedrockConfig.accessKeyId || !bedrockConfig.secretAccessKey) {
      throw new Error('AWS credentials not provided');
    }

    this.bedrockClient = new BedrockRuntimeClient({
      region: bedrockConfig.region,
      credentials: {
        accessKeyId: bedrockConfig.accessKeyId,
        secretAccessKey: bedrockConfig.secretAccessKey
      }
    });

    this.bedrockModel = bedrockConfig.model;
    this.bedrockModelVersion = bedrockConfig.modelVersion || 'bedrock-2023-05-31';
    this.bedrockMaxTokens = bedrockConfig.maxTokens;
    this.bedrockTemperature = bedrockConfig.temperature;

    this.logger.info(`Initialized AWS Bedrock provider`);
    this.logger.info(`Region: ${bedrockConfig.region}`);
    this.logger.info(`Model: ${this.bedrockModel}`);
    this.logger.info(`Model Version: ${this.bedrockModelVersion}`);
  }

  /**
   * Get current active Gemini model
   */
  _getCurrentModel() {
    return this.models.get(this.currentKeyIndex);
  }

  /**
   * Rotate to next Gemini API key
   */
  _rotateKey() {
    if (this.provider !== 'gemini') return;
    
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    this.logger.debug(`Rotated to API key ${this.currentKeyIndex + 1}/${this.apiKeys.length}`);
  }

  /**
   * Check and update token usage for rate limiting
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
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate content with Gemini
   */
  async _generateWithGemini(prompt, schema, options) {
    const model = this._getCurrentModel();

    let result;
    if (schema) {
      result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: this.config.api.gemini.temperature,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      });
    } else {
      result = await model.generateContent(prompt);
    }

    // Extract response text
    const responseText = result.response.text();
    
    // Track token usage if available
    if (result.response.usageMetadata) {
      const usage = result.response.usageMetadata;
      this.totalTokens.promptTokens += usage.promptTokenCount || 0;
      this.totalTokens.candidatesTokens += usage.candidatesTokenCount || 0;
      this.totalTokens.totalTokens += usage.totalTokenCount || 0;
      
      this.logger.debug(`Token usage: ${usage.totalTokenCount || 0} (prompt: ${usage.promptTokenCount || 0}, response: ${usage.candidatesTokenCount || 0})`);
    }
    
    // Parse JSON response
    try {
      return JSON.parse(responseText);
    } catch (parseError) {
      this.logger.warn('Failed to parse JSON response, returning raw text');
      return { text: responseText };
    }
  }

  /**
   * Generate content with AWS Bedrock (Claude)
   */
  async _generateWithBedrock(prompt, schema, options) {
    // Build the request body for Claude
    const requestBody = {
      anthropic_version: this.bedrockModelVersion,
      max_tokens: this.bedrockMaxTokens,
      temperature: this.bedrockTemperature,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };

    // If schema is provided, add it to the prompt as instructions
    if (schema) {
      const schemaInstructions = `\n\nIMPORTANT: You must respond with valid JSON that matches this exact schema:\n${JSON.stringify(schema, null, 2)}\n\nRespond ONLY with the JSON object, no additional text.`;
      requestBody.messages[0].content += schemaInstructions;
    }

    const command = new InvokeModelCommand({
      modelId: this.bedrockModel,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(requestBody)
    });

    const response = await this.bedrockClient.send(command);
    
    // Parse the response
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    // Track token usage
    if (responseBody.usage) {
      this.totalTokens.promptTokens += responseBody.usage.input_tokens || 0;
      this.totalTokens.candidatesTokens += responseBody.usage.output_tokens || 0;
      this.totalTokens.totalTokens += (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0);
      
      this.logger.debug(`Token usage: ${responseBody.usage.input_tokens + responseBody.usage.output_tokens} (prompt: ${responseBody.usage.input_tokens}, response: ${responseBody.usage.output_tokens})`);
    }

    // Extract the content
    const content = responseBody.content?.[0]?.text || '';
    
    // Try to parse as JSON if schema was provided
    if (schema) {
      try {
        // Remove markdown code blocks if present
        const cleanContent = content
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/, '')
          .replace(/```\s*$/, '')
          .trim();
        return JSON.parse(cleanContent);
      } catch (parseError) {
        this.logger.warn('Failed to parse JSON response from Bedrock');
        // Try to extract JSON from the text
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[0]);
          } catch (e) {
            this.logger.error('Could not extract valid JSON from response');
          }
        }
        return { text: content };
      }
    }
    
    return { text: content };
  }

  /**
   * Generate content with retry logic
   */
  async generateContent(prompt, schema = null, options = {}) {
    const maxRetries = options.maxRetries || this.config.api.maxRetries;
    const estimatedTokens = Math.ceil(prompt.length / 4);
    
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

        // Generate content based on provider
        let result;
        if (this.provider === 'gemini') {
          result = await this._generateWithGemini(prompt, schema, options);
        } else if (this.provider === 'bedrock') {
          result = await this._generateWithBedrock(prompt, schema, options);
        }

        this.requestCount++;
        return result;

      } catch (error) {
        lastError = error;
        this.errorCount++;

        this.logger.warn(`API request failed (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);

        // Handle provider-specific errors
        if (this.provider === 'gemini') {
          // Handle Gemini rate limiting
          if (error.message.includes('429') || error.message.includes('RATE_LIMIT')) {
            this.logger.warn('Rate limit hit, waiting before retry');
            await this._sleep(this.config.api.rateLimitDelay);
            this._rotateKey();
            continue;
          }

          // Handle quota exceeded
          if (error.message.includes('quota') || error.message.includes('RESOURCE_EXHAUSTED')) {
            this.logger.warn('Quota exceeded, rotating to next key');
            this._rotateKey();
            await this._sleep(5000);
            continue;
          }
        } else if (this.provider === 'bedrock') {
          // Handle Bedrock throttling
          if (error.name === 'ThrottlingException' || error.message.includes('throttl')) {
            this.logger.warn('Bedrock throttling, waiting before retry');
            await this._sleep(this.config.api.rateLimitDelay);
            continue;
          }
        }

        // Exponential backoff for other errors
        if (attempt < maxRetries - 1) {
          const delay = this.config.api.initialRetryDelay * Math.pow(2, attempt);
          this.logger.debug(`Waiting ${delay}ms before retry`);
          await this._sleep(delay);
        }
      }
    }

    throw new Error(`API request failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Build response schema for structured output
   */
  buildSchema(fields) {
    const properties = {};
    const required = [];

    for (const [fieldName, fieldConfig] of Object.entries(fields)) {
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
   */
  getStats() {
    const stats = {
      provider: this.provider,
      totalRequests: this.requestCount,
      totalErrors: this.errorCount,
      successRate: this.requestCount > 0 
        ? (((this.requestCount - this.errorCount) / this.requestCount) * 100).toFixed(1) + '%'
        : '0%',
      tokenUsage: {
        promptTokens: this.totalTokens.promptTokens,
        candidatesTokens: this.totalTokens.candidatesTokens,
        totalTokens: this.totalTokens.totalTokens
      }
    };

    if (this.provider === 'gemini') {
      stats.currentKeyIndex = this.currentKeyIndex + 1;
      stats.totalKeys = this.apiKeys.length;
    }

    return stats;
  }

  /**
   * Calculate cost based on token usage and provider
   */
  calculateCost() {
    let inputCostPer1M = 0;
    let outputCostPer1M = 0;
    let modelName = '';

    if (this.provider === 'gemini') {
      modelName = this.config.api.gemini.model;
      const model = modelName.toLowerCase();

      if (model.includes('flash-exp') || model.includes('2.0-flash-exp')) {
        inputCostPer1M = 0;
        outputCostPer1M = 0;
      } else if (model.includes('1.5-flash') || model.includes('flash')) {
        inputCostPer1M = 0.075;
        outputCostPer1M = 0.30;
      } else if (model.includes('1.5-pro') || model.includes('pro')) {
        inputCostPer1M = 3.50;
        outputCostPer1M = 10.50;
      }
    } else if (this.provider === 'bedrock') {
      modelName = this.bedrockModel;
      
      // Claude 3.5 Sonnet pricing (as of 2024)
      if (modelName.includes('claude-3-5-sonnet')) {
        inputCostPer1M = 3.00;
        outputCostPer1M = 15.00;
      }
      // Claude 3 Opus pricing
      else if (modelName.includes('claude-3-opus')) {
        inputCostPer1M = 15.00;
        outputCostPer1M = 75.00;
      }
      // Claude 3 Sonnet pricing
      else if (modelName.includes('claude-3-sonnet')) {
        inputCostPer1M = 3.00;
        outputCostPer1M = 15.00;
      }
      // Claude 3 Haiku pricing
      else if (modelName.includes('claude-3-haiku')) {
        inputCostPer1M = 0.25;
        outputCostPer1M = 1.25;
      }
    }

    const inputCost = (this.totalTokens.promptTokens / 1000000) * inputCostPer1M;
    const outputCost = (this.totalTokens.candidatesTokens / 1000000) * outputCostPer1M;
    const totalCost = inputCost + outputCost;

    return {
      provider: this.provider,
      inputTokens: this.totalTokens.promptTokens,
      outputTokens: this.totalTokens.candidatesTokens,
      totalTokens: this.totalTokens.totalTokens,
      inputCostUSD: parseFloat(inputCost.toFixed(6)),
      outputCostUSD: parseFloat(outputCost.toFixed(6)),
      totalCostUSD: parseFloat(totalCost.toFixed(6)),
      model: modelName,
      pricing: {
        inputCostPer1M: inputCostPer1M,
        outputCostPer1M: outputCostPer1M
      }
    };
  }
}

module.exports = APIManager;
