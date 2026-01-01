/**
 * Question Configuration Loader
 *
 * Single source of truth for question configuration across all scripts.
 * Reads from questions-config.json and provides utilities for:
 * - Grammar improvement (column mappings)
 * - Categorization (full question metadata)
 * - Validation (column existence checks)
 *
 * This eliminates hardcoding and ensures consistency across the pipeline.
 */

const fs = require('fs');
const path = require('path');

class QuestionLoader {
  constructor(configPath = null, logger = null) {
    this.logger = logger;
    this.configPath = configPath || this._findConfigPath();
    this.config = null;
    this.questionColumns = null;
    this.questionMetadata = null;
  }

  /**
   * Find questions-config.json in common locations
   */
  _findConfigPath() {
    const possiblePaths = [
      process.env.QUESTIONS_CONFIG,
      path.join(__dirname, '..', 'questions-config.json'),
      path.join(__dirname, '..', '..', 'cat-ai', 'questions-config.json'),
      path.join(process.cwd(), 'questions-config.json'),
    ].filter(Boolean);

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }

    throw new Error(
      'questions-config.json not found. Searched:\n' +
      possiblePaths.map(p => `  - ${p}`).join('\n')
    );
  }

  /**
   * Load and parse questions-config.json
   */
  load() {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(configData);

      if (!this.config.questions || !Array.isArray(this.config.questions)) {
        throw new Error('Invalid questions-config.json: missing "questions" array');
      }

      this._buildMappings();

      if (this.logger) {
        this.logger.info(`Loaded ${this.config.questions.length} questions from ${this.configPath}`);
      }

      return this.config;

    } catch (error) {
      throw new Error(`Failed to load questions-config.json: ${error.message}`);
    }
  }

  /**
   * Build internal mappings for quick access
   */
  _buildMappings() {
    this.questionColumns = {};
    this.questionMetadata = {};

    for (const question of this.config.questions) {
      const id = question.id;

      // Map question ID to CSV column name
      // e.g., "q1" -> "Q1: In the last 6 to 12 months..."
      this.questionColumns[id] = question.csv_column;

      // Store full metadata
      this.questionMetadata[id] = {
        id: question.id,
        csvColumn: question.csv_column,
        questionText: question.question_text,
        responseFields: question.response_fields || [],
        criteria: question.categorization_criteria || '',
      };
    }
  }

  /**
   * Get simple column mapping (for grammar improvement)
   * Returns: { q1: "Q1: ...", q2: "Q2: ...", ... }
   */
  getColumnMapping() {
    if (!this.questionColumns) {
      this.load();
    }
    return { ...this.questionColumns };
  }

  /**
   * Get CSV column names only
   * Returns: ["Q1: ...", "Q2: ...", ...]
   */
  getColumnNames() {
    if (!this.questionColumns) {
      this.load();
    }
    return Object.values(this.questionColumns);
  }

  /**
   * Get question IDs only
   * Returns: ["q1", "q2", "q3", ...]
   */
  getQuestionIds() {
    if (!this.questionColumns) {
      this.load();
    }
    return Object.keys(this.questionColumns);
  }

  /**
   * Get full question metadata (for categorization)
   * Returns: Array of question objects with all metadata
   */
  getQuestions() {
    if (!this.config) {
      this.load();
    }
    return this.config.questions;
  }

  /**
   * Get metadata for a specific question
   */
  getQuestion(questionId) {
    if (!this.questionMetadata) {
      this.load();
    }
    return this.questionMetadata[questionId] || null;
  }

  /**
   * Get count of questions
   */
  getQuestionCount() {
    if (!this.questionColumns) {
      this.load();
    }
    return Object.keys(this.questionColumns).length;
  }

  /**
   * Generate simplified question list for prompts (without Q1: prefix)
   * Returns: "q1: What is one improvement...\nq2: How did you get the idea...\n..."
   */
  generateQuestionList() {
    if (!this.questionMetadata) {
      this.load();
    }

    const questions = [];
    for (const [id, meta] of Object.entries(this.questionMetadata)) {
      questions.push(`${id}: ${meta.questionText}`);
    }

    return questions.join('\n');
  }

  /**
   * Generate response schema for AI (dynamically based on questions)
   * For grammar improvement: { Q1: {type: "string"}, Q2: {type: "string"}, ... }
   */
  generateGrammarSchema() {
    if (!this.questionColumns) {
      this.load();
    }

    const properties = {};
    const required = [];

    for (const [id, columnName] of Object.entries(this.questionColumns)) {
      // Use simple question ID as key (Q1, Q2, etc.)
      const key = id.toUpperCase(); // q1 -> Q1

      properties[key] = {
        type: 'string',
        nullable: true,
        description: `Improved response for ${columnName}`
      };

      required.push(key);
    }

    return {
      type: 'object',
      properties,
      required
    };
  }

  /**
   * Validate that all expected columns exist in CSV data
   */
  validateColumns(csvRow) {
    if (!this.questionColumns) {
      this.load();
    }

    const missingColumns = [];
    const existingColumns = [];

    for (const [id, columnName] of Object.entries(this.questionColumns)) {
      if (columnName in csvRow) {
        existingColumns.push(columnName);
      } else {
        missingColumns.push(columnName);
      }
    }

    return {
      valid: missingColumns.length === 0,
      existingColumns,
      missingColumns,
      totalExpected: Object.keys(this.questionColumns).length,
      totalFound: existingColumns.length
    };
  }

  /**
   * Get column name by question ID
   * e.g., getColumnName('q1') -> "Q1: In the last 6 to 12 months..."
   */
  getColumnName(questionId) {
    if (!this.questionColumns) {
      this.load();
    }
    return this.questionColumns[questionId] || null;
  }

  /**
   * Get question ID by column name (reverse lookup)
   * e.g., getQuestionId("Q1: In the last...") -> "q1"
   */
  getQuestionId(columnName) {
    if (!this.questionColumns) {
      this.load();
    }

    for (const [id, col] of Object.entries(this.questionColumns)) {
      if (col === columnName) {
        return id;
      }
    }

    return null;
  }

  /**
   * Check if a column is a question column
   */
  isQuestionColumn(columnName) {
    if (!this.questionColumns) {
      this.load();
    }
    return Object.values(this.questionColumns).includes(columnName);
  }

  /**
   * Get configuration file path
   */
  getConfigPath() {
    return this.configPath;
  }
}

// Export singleton instance and class
let instance = null;

module.exports = {
  QuestionLoader,

  /**
   * Get singleton instance
   */
  getInstance(configPath = null, logger = null) {
    if (!instance) {
      instance = new QuestionLoader(configPath, logger);
      instance.load();
    }
    return instance;
  },

  /**
   * Create new instance (for testing or multiple configs)
   */
  create(configPath = null, logger = null) {
    const loader = new QuestionLoader(configPath, logger);
    loader.load();
    return loader;
  }
};
