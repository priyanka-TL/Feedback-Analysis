/**
 * Validation Utility
 * 
 * Provides validation functions for data, responses, and configurations.
 */

class Validator {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.emptyIndicators = config.validation.emptyIndicators;
    this.minResponseLength = config.validation.minResponseLength;
  }

  /**
   * Check if a response is empty or invalid
   * @param {string} response - Response text to validate
   * @returns {boolean} True if empty
   */
  isEmpty(response) {
    if (!response) return true;
    
    const trimmed = response.trim();
    
    // Check against empty indicators
    if (this.emptyIndicators.includes(trimmed)) {
      return true;
    }

    // Check minimum length
    if (trimmed.length < this.minResponseLength) {
      return true;
    }

    return false;
  }

  /**
   * Check if response has meaningful content
   * @param {string} response - Response text
   * @returns {boolean} True if valid
   */
  isValidResponse(response) {
    if (this.isEmpty(response)) return false;

    // Additional checks for meaningful content
    const trimmed = response.trim();
    
    // Check for common non-responses
    const nonResponses = [
      /^\.+$/, // Only dots
      /^-+$/, // Only dashes
      /^\?+$/, // Only question marks
      /^n\/?a$/i, // N/A variations
      /^nil$/i,
      /^null$/i
    ];

    for (const pattern of nonResponses) {
      if (pattern.test(trimmed)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate category value against allowed categories
   * @param {string|Array} category - Category value(s)
   * @param {Array} allowedCategories - List of allowed categories
   * @returns {boolean} True if valid
   */
  isValidCategory(category, allowedCategories) {
    if (!category) return false;

    // Handle array of categories
    if (Array.isArray(category)) {
      return category.every(cat => allowedCategories.includes(cat));
    }

    // Handle single category
    return allowedCategories.includes(category);
  }

  /**
   * Validate row data has required fields
   * @param {object} row - CSV row data
   * @param {Array<string>} requiredFields - Required field names
   * @returns {object} Validation result
   */
  validateRow(row, requiredFields) {
    const missing = [];
    const invalid = [];

    for (const field of requiredFields) {
      if (!(field in row)) {
        missing.push(field);
      } else if (!row[field] || row[field].trim() === '') {
        invalid.push(field);
      }
    }

    return {
      valid: missing.length === 0 && invalid.length === 0,
      missing,
      invalid
    };
  }

  /**
   * Validate questions configuration
   * @param {object} questionsConfig - Questions configuration object
   * @returns {object} Validation result
   */
  validateQuestionsConfig(questionsConfig) {
    const errors = [];
    const warnings = [];

    if (!questionsConfig || typeof questionsConfig !== 'object') {
      errors.push('Questions config must be an object');
      return { valid: false, errors, warnings };
    }

    for (const [questionKey, questionConfig] of Object.entries(questionsConfig)) {
      // Validate question structure
      if (!questionConfig.question_text) {
        errors.push(`${questionKey}: Missing question_text`);
      }

      if (!questionConfig.column_name) {
        errors.push(`${questionKey}: Missing column_name`);
      }

      // Validate response fields
      if (questionConfig.response_fields) {
        for (const [fieldName, fieldConfig] of Object.entries(questionConfig.response_fields)) {
          if (!fieldConfig.type) {
            errors.push(`${questionKey}.${fieldName}: Missing type`);
          }

          if (fieldConfig.type === 'enum' && !fieldConfig.enum) {
            errors.push(`${questionKey}.${fieldName}: Enum type requires enum values`);
          }

          if (fieldConfig.type === 'array' && !fieldConfig.items) {
            warnings.push(`${questionKey}.${fieldName}: Array type should define items`);
          }
        }
      }

      // Validate categorization criteria (can be string or object)
      if (questionConfig.categorization_criteria) {
        // Accept both string format (plain text instructions) and object format
        if (typeof questionConfig.categorization_criteria === 'string') {
          // String format is valid - this is the instruction text for the AI
          if (questionConfig.categorization_criteria.trim().length === 0) {
            warnings.push(`${questionKey}: categorization_criteria is empty`);
          }
        } else if (typeof questionConfig.categorization_criteria === 'object') {
          // Object format should have categories array
          if (!questionConfig.categorization_criteria.categories) {
            errors.push(`${questionKey}: Missing categories in categorization_criteria object`);
          } else if (!Array.isArray(questionConfig.categorization_criteria.categories)) {
            errors.push(`${questionKey}: Categories must be an array`);
          }
        } else {
          errors.push(`${questionKey}: categorization_criteria must be a string or object`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Sanitize text by removing extra whitespace and normalizing
   * @param {string} text - Text to sanitize
   * @returns {string} Sanitized text
   */
  sanitizeText(text) {
    if (!text) return '';

    return text
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n+/g, '\n') // Replace multiple newlines with single newline
      .trim();
  }

  /**
   * Fix common typos in responses
   * @param {string} text - Text to fix
   * @returns {string} Fixed text
   */
  fixCommonTypos(text) {
    if (!text) return text;

    const typoMap = {
      'NO RESPOSNE': 'NO RESPONSE',
      'NO RESPONE': 'NO RESPONSE',
      'no resposne': 'no response',
      'no respone': 'no response'
    };

    let fixed = text;
    for (const [typo, correction] of Object.entries(typoMap)) {
      fixed = fixed.replace(new RegExp(typo, 'g'), correction);
    }

    return fixed;
  }

  /**
   * Validate and normalize category name
   * @param {string} category - Category name
   * @param {Array} allowedCategories - List of allowed categories
   * @returns {string|null} Normalized category or null if invalid
   */
  normalizeCategory(category, allowedCategories) {
    if (!category) return null;

    const normalized = category.trim();

    // Exact match
    if (allowedCategories.includes(normalized)) {
      return normalized;
    }

    // Case-insensitive match
    const lowerCategory = normalized.toLowerCase();
    for (const allowed of allowedCategories) {
      if (allowed.toLowerCase() === lowerCategory) {
        return allowed;
      }
    }

    // Fuzzy match (contains)
    for (const allowed of allowedCategories) {
      if (normalized.includes(allowed) || allowed.includes(normalized)) {
        this.logger.debug(`Fuzzy matched '${normalized}' to '${allowed}'`);
        return allowed;
      }
    }

    return null;
  }

  /**
   * Validate API response structure
   * @param {object} response - API response
   * @param {object} expectedFields - Expected fields and types
   * @returns {object} Validation result
   */
  validateAPIResponse(response, expectedFields) {
    const errors = [];

    if (!response || typeof response !== 'object') {
      errors.push('Response must be an object');
      return { valid: false, errors };
    }

    for (const [field, expectedType] of Object.entries(expectedFields)) {
      if (!(field in response)) {
        errors.push(`Missing field: ${field}`);
        continue;
      }

      const actualType = Array.isArray(response[field]) ? 'array' : typeof response[field];
      
      if (actualType !== expectedType) {
        errors.push(`Field '${field}' should be ${expectedType}, got ${actualType}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Check if text contains any of the specified keywords
   * @param {string} text - Text to check
   * @param {Array<string>} keywords - Keywords to look for
   * @returns {boolean} True if any keyword found
   */
  containsKeywords(text, keywords) {
    if (!text || !keywords || keywords.length === 0) return false;

    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
  }

  /**
   * Extract numbers from text
   * @param {string} text - Text to extract from
   * @returns {Array<number>} Array of numbers found
   */
  extractNumbers(text) {
    if (!text) return [];
    
    const matches = text.match(/\d+(\.\d+)?/g);
    return matches ? matches.map(n => parseFloat(n)) : [];
  }

  /**
   * Validate file path exists and is accessible
   * @param {string} filePath - File path to validate
   * @returns {boolean} True if valid
   */
  validateFilePath(filePath) {
    const fs = require('fs');
    
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      this.logger.error(`Error validating file path: ${error.message}`);
      return false;
    }
  }
}

module.exports = Validator;
