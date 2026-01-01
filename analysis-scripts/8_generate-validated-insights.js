#!/usr/bin/env node

/**
 * State-Level Insights with Validation Script
 * 
 * Generates STATE-LEVEL analysis with KEY INSIGHTS and automatically validates
 * each insight with supporting feedback examples and relevance scores.
 * 
 * This script:
 * - Uses existing categories from the categorized CSV (no re-categorization)
 * - Analyzes ALL districts together for state-level insights
 * - Generates KEY INSIGHTS for each question across all feedback
 * - Validates each insight with top supporting examples and relevance scores
 * - Uses config-driven approach (no hardcoded category mappings)
 * 
 * Output includes:
 * - Category summary (from existing categorization)
 * - KEY INSIGHTS for each question (state-level)
 * - VALIDATION section with top supporting feedback (relevance scores)
 * - Statistics (total responses, supporting count, confidence level)
 * 
 * Usage:
 *   node 8_generate-validated-insights.js [options]
 */

const fs = require('fs').promises;
const path = require('path');
const Papa = require('papaparse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  configPath: './config.js',
  inputFile: '../key-metrics/test.csv',
  outputFile: './reports/validated_insights_report.md'
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
    case '--help':
      console.log(`
State-Level Insights with Validation - Generate KEY INSIGHTS with supporting evidence

This script performs STATE-LEVEL analysis, combining all districts together to generate
insights for each question across all feedback data.

Usage:
  node 8_generate-validated-insights.js [options]

Options:
  --config <path>      Path to config file (default: ./config.js)
  --input <path>       Input CSV file (default: from config.js)
  --output <path>      Output report (default: ./reports/validated_insights_report.md)
  --help               Show this help message

Environment Variables:
  API_KEYS             Comma-separated Gemini API keys (required)
  MODEL_NAME           Gemini model name (default: gemini-2.0-flash-exp)

Examples:
  node 8_generate-validated-insights.js
  node 8_generate-validated-insights.js --input data.csv --output report.md
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

// Load utilities
const Logger = require('./utils/logger');
const CSVHandler = require('./utils/csv-handler');
const APIManager = require('./utils/api-manager');

// Initialize utilities
const logger = new Logger(config.logging);
const csvHandler = new CSVHandler(logger);
const apiManager = new APIManager(config, logger);

/**
 * Get category summary from already categorized data
 */
function getCategorySummary(allData, questionConfig) {
  // Get category columns from questions-config.json
  const questionsConfig = require('./questions-config.json');
  const categoryColumns = [];
  
  // Find the question in config and extract category field names
  for (const q of questionsConfig.questions || []) {
    if (q.csv_column === questionConfig.column || q.question_text === questionConfig.column) {
      // Extract field names from response_fields
      if (q.response_fields && Array.isArray(q.response_fields)) {
        for (const field of q.response_fields) {
          if (field.name && field.name !== 'reasoning') {
            categoryColumns.push(field.name);
          }
        }
      }
      break;
    }
  }
  
  if (categoryColumns.length === 0) {
    logger.warn(`No category columns found in config for: ${questionConfig.column}`);
  }
  const categorySummary = {};

  // Count categories and collect example responses
  for (const row of allData) {
    const response = row[questionConfig.column];
    if (!response || !response.trim()) continue;

    for (const catCol of categoryColumns) {
      const categories = row[catCol];
      if (!categories) continue;

      // Handle both single category and array of categories
      const catList = categories.includes(';') ? categories.split(';') : [categories];
      
      for (const cat of catList) {
        const category = cat.trim();
        if (!category || category === 'NO RESPONSE' || category === 'ERROR') continue;

        if (!categorySummary[category]) {
          categorySummary[category] = {
            count: 0,
            examples: []
          };
        }
        
        categorySummary[category].count++;
        if (categorySummary[category].examples.length < 5) {
          categorySummary[category].examples.push(response);
        }
      }
    }
  }

  return categorySummary;
}

/**
 * Generate KEY INSIGHTS only (using existing categories)
 */
async function generateInsights(responses, categorySummary, questionConfig) {
  // Build category summary text
  let categoryText = '';
  if (Object.keys(categorySummary).length > 0) {
    categoryText = '\n\nEXISTING CATEGORIES (already categorized):\n';
    for (const [category, data] of Object.entries(categorySummary)) {
      categoryText += `- ${category}: ${data.count} responses\n`;
    }
  }

  const prompt = `You are analyzing teacher feedback responses for: ${questionConfig.shortName}

TOTAL RESPONSES: ${responses.length}
${categoryText}

SAMPLE RESPONSES (for context):
${responses.slice(0, 20).map((r, i) => `${i + 1}. "${r}"`).join('\n')}

TASK: Generate 3-5 KEY INSIGHTS
These insights should:
- Synthesize the most important patterns, trends, or findings
- Be evidence-based and grounded in the data
- Highlight significant patterns or themes
- Be actionable or meaningful for policy/practice
- Be specific rather than generic
- Reference the existing categories where relevant
- Maximum 5 insights per question

Format your response as JSON with an array of insight strings (maximum 5).`;

  const schema = {
    type: 'object',
    properties: {
      key_insights: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 key insights synthesizing the data'
      }
    },
    required: ['key_insights']
  };

  try {
    const result = await apiManager.generateContent(prompt, schema);
    // Limit to top 5 insights
    const insights = result.key_insights || [];
    return insights.slice(0, 5);
  } catch (error) {
    logger.error(`Failed to generate insights: ${error.message}`);
    return [];
  }
}

/**
 * Validate ALL insights in a single API call (BATCH VALIDATION)
 * This reduces API calls from N (one per insight) to just 1
 */
async function validateAllInsights(insights, allResponses, questionName) {
  const prompt = `You are validating ${insights.length} insights derived from teacher feedback.

QUESTION: ${questionName}

ALL FEEDBACK (${allResponses.length} responses):
${allResponses.map((r, i) => `${i + 1}. "${r}"`).join('\n')}

INSIGHTS TO VALIDATE:
${insights.map((insight, i) => `${i + 1}. "${insight}"`).join('\n')}

TASK:
For EACH insight above, identify:
1. TOP 5 responses that BEST SUPPORT this insight (with response number, text, relevance score 1-10, explanation)
2. Total count of responses that support this insight (out of ${allResponses.length})
3. Confidence level: HIGH (strong data support), MEDIUM (moderate support), or LOW (weak support)

Return an array with validation results for each insight in order.`;

  const schema = {
    type: 'object',
    properties: {
      validations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            insight: { type: 'string', description: 'The insight being validated' },
            supporting_examples: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  response_number: { type: 'number' },
                  response_text: { type: 'string' },
                  relevance_score: { type: 'number', description: 'Score from 1-10' },
                  explanation: { type: 'string' }
                },
                required: ['response_number', 'response_text', 'relevance_score', 'explanation']
              },
              description: 'Top 5 supporting responses'
            },
            total_supporting: { type: 'number', description: 'Total responses supporting this insight' },
            confidence: { 
              type: 'string', 
              enum: ['HIGH', 'MEDIUM', 'LOW'],
              description: 'Confidence level'
            }
          },
          required: ['insight', 'supporting_examples', 'total_supporting', 'confidence']
        },
        description: 'Validation results for each insight'
      }
    },
    required: ['validations']
  };

  try {
    const result = await apiManager.generateContent(prompt, schema);
    return result.validations || insights.map(insight => ({
      insight,
      supporting_examples: [],
      total_supporting: 0,
      confidence: 'ERROR'
    }));
  } catch (error) {
    logger.error(`Failed to validate insights: ${error.message}`);
    return insights.map(insight => ({
      insight,
      supporting_examples: [],
      total_supporting: 0,
      confidence: 'ERROR'
    }));
  }
}

/**
 * Validate an insight with supporting feedback (DEPRECATED - use validateAllInsights instead)
 */
async function validateInsight(insight, allResponses, questionName) {
  const prompt = `You are validating an insight derived from teacher feedback.

INSIGHT TO VALIDATE:
"${insight}"

QUESTION: ${questionName}

ALL FEEDBACK (${allResponses.length} responses):
${allResponses.map((r, i) => `${i + 1}. "${r}"`).join('\n')}

TASK:
Identify the TOP 5 responses that BEST SUPPORT this insight. For each:
1. Provide the response number and text
2. Rate relevance (1-10, where 10 = perfect support)
3. Explain why it supports the insight

Also provide:
- Total count of responses that support this insight (out of ${allResponses.length})
- Confidence level: HIGH (strong data support), MEDIUM (moderate support), or LOW (weak support)`;

  const schema = {
    type: 'object',
    properties: {
      supporting_examples: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            response_number: { type: 'number' },
            response_text: { type: 'string' },
            relevance_score: { type: 'number', description: 'Score from 1-10' },
            explanation: { type: 'string' }
          },
          required: ['response_number', 'response_text', 'relevance_score', 'explanation']
        },
        description: 'Top 5 supporting responses'
      },
      total_supporting: { type: 'number', description: 'Total responses supporting this insight' },
      confidence: { 
        type: 'string', 
        enum: ['HIGH', 'MEDIUM', 'LOW'],
        description: 'Confidence level'
      }
    },
    required: ['supporting_examples', 'total_supporting', 'confidence']
  };

  try {
    const result = await apiManager.generateContent(prompt, schema);
    return result;
  } catch (error) {
    logger.error(`Failed to validate insight: ${error.message}`);
    return {
      supporting_examples: [],
      total_supporting: 0,
      confidence: 'ERROR'
    };
  }
}

/**
 * Process a single question at STATE LEVEL (all districts combined)
 */
async function processQuestion(allData, questionConfig) {
  const columnName = questionConfig.column;
  
  // Extract non-empty responses from ALL districts
  const responses = allData
    .map(row => row[columnName])
    .filter(text => text && text.trim().length > 0);
  
  if (responses.length === 0) {
    logger.warn(`No responses found for: ${questionConfig.shortName}`);
    return null;
  }
  
  logger.info(`Analyzing ${responses.length} responses for: ${questionConfig.shortName}`);
  
  // Step 1: Get category summary from existing categorized data
  const categorySummary = getCategorySummary(allData, questionConfig);
  
  // Step 2: Generate insights using existing categories
  const insights = await generateInsights(responses, categorySummary, questionConfig);
  
  if (!insights || insights.length === 0) {
    logger.warn(`No insights generated for: ${questionConfig.shortName}`);
    return { 
      key_insights: [],
      validatedInsights: [],
      totalResponses: responses.length,
      categorySummary
    };
  }
  
  logger.info(`Generated ${insights.length} insights`);
  
  // Step 3: Validate ALL insights in a SINGLE API call (batch validation)
  logger.info(`  Validating all ${insights.length} insights in batch...`);
  const validatedInsights = await validateAllInsights(insights, responses, questionConfig.shortName);
  
  // Log validation results
  for (let i = 0; i < validatedInsights.length; i++) {
    const validation = validatedInsights[i];
    logger.info(`    Insight ${i + 1}: Confidence: ${validation.confidence}, Supporting: ${validation.total_supporting}/${responses.length}`);
  }
  
  return {
    key_insights: insights,
    validatedInsights,
    totalResponses: responses.length,
    categorySummary
  };
}

/**
 * Generate markdown report for STATE-LEVEL analysis
 */
function generateMarkdown(results) {
  let md = `# School Improvement Analysis Report (State-Level)\n\n`;
  md += `**Generated:** ${new Date().toISOString()}\n`;
  md += `**Analysis Scope:** State-level\n`;
  md += `**Districts Included:** ${results.districts.join(', ')}\n`;
  md += `**Total Responses:** ${results.totalResponses}\n\n`;
  md += `---\n\n`;
  
  md += `## Overview\n\n`;
  md += `This report presents KEY INSIGHTS for each question at the STATE level, analyzing feedback from all districts together. `;
  md += `Each insight is validated with supporting evidence and relevance scores.\n\n`;
  md += `---\n\n`;
  
  for (const questionResult of results.questions) {
    if (!questionResult) continue;
    
    md += `## ${questionResult.question_text || questionResult.column}\n\n`;
    md += `**Total Responses:** ${questionResult.totalResponses}\n\n`;
    
    // Existing Categories Summary
    if (questionResult.categorySummary && Object.keys(questionResult.categorySummary).length > 0) {
      md += `### Existing Categories (from categorization)\n\n`;
      
      // Sort categories by count
      const sortedCategories = Object.entries(questionResult.categorySummary)
        .sort(([, a], [, b]) => b.count - a.count);
      
      for (const [category, data] of sortedCategories) {
        md += `**${category}** - ${data.count} responses\n`;
      }
      md += `\n`;
    }
    
    // Key Insights with Validation
    md += `### KEY INSIGHTS\n\n`;
    
    if (!questionResult.validatedInsights || questionResult.validatedInsights.length === 0) {
      md += `⚠️ No insights generated for this question.\n\n`;
    } else {
      for (let i = 0; i < questionResult.validatedInsights.length; i++) {
        const validated = questionResult.validatedInsights[i];
        md += `#### Insight ${i + 1}\n\n`;
        md += `**${validated.insight}**\n\n`;
        md += `- **Supporting Evidence:** ${validated.total_supporting}/${questionResult.totalResponses} responses (${Math.round(validated.total_supporting/questionResult.totalResponses*100)}%)\n\n`;
        
        if (validated.supporting_examples && validated.supporting_examples.length > 0) {
          md += `**Top Supporting Feedback:**\n\n`;
          
          // Sort by relevance score and take top 5
          const sortedExamples = [...validated.supporting_examples]
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .slice(0, 5);
          
          for (const example of sortedExamples) {
            md += `${example.response_number}. **[Relevance: ${example.relevance_score}/10]** "${example.response_text}"\n\n`;
          }
        } else {
          md += `⚠️ No strong supporting evidence found.\n\n`;
        }
        
        md += `---\n\n`;
      }
    }
    
    md += `\n`;
  }
  
  return md;
}

/**
 * Main execution function
 */
async function main() {
  try {
    logger.section('State-Level Insights with Validation');
    logger.info(`Input: ${config.paths.input}`);
    logger.info(`Output: ${options.outputFile}`);
    
    // Load data
    logger.section('Loading Data');
    const data = await csvHandler.read(config.paths.input);
    logger.info(`Loaded ${data.length} rows`);
    
    // Get unique districts for information purposes
    const districts = [...new Set(data.map(row => row.District))].filter(d => d);
    logger.info(`Data contains ${districts.length} districts: ${districts.join(', ')}`);
    
    // Load questions from questions-config.json
    const questionsConfig = require('./questions-config.json');
    const questionColumns = require('./question-columns.json');
    
    // Build question mappings
    const questions = [];
    for (const q of questionsConfig.questions || []) {
      const shortName = q.id ? q.id.toUpperCase() : q.question_text.substring(0, 50);
      questions.push({
        id: q.id,
        shortName: shortName,
        column: q.csv_column,
        question_text: q.question_text,
        response_fields: q.response_fields
      });
    }
    
    logger.info(`Processing ${questions.length} questions`);

    
    // STATE-LEVEL ANALYSIS: Process all data together, not district-wise
    logger.section('Processing State-Level Analysis');
    logger.info('Analyzing all districts together for state-level insights');
    
    const results = {
      totalResponses: data.length,
      districts: districts,
      questions: []
    };
    
    // Process each question
    for (let i = 0; i < questions.length; i++) {
      const questionConfig = questions[i];
      logger.info(`\n=== Processing Question ${i + 1}/${questions.length}: ${questionConfig.shortName} ===`);
      const result = await processQuestion(data, questionConfig);
      if (result) {
        results.questions.push({
          ...result,
          shortName: questionConfig.shortName,
          column: questionConfig.column,
          question_text: questionConfig.question_text
        });
      }
      
      // Add delay between questions ONLY if not the last question
      // Rate limits are handled within APIManager
      if (i < questions.length - 1) {
        logger.info('Waiting 7 seconds before next question to respect rate limits...');
        await new Promise(resolve => setTimeout(resolve, 7000));
      }
    }
    
    // Generate report
    logger.section('Generating Report');
    const markdown = generateMarkdown(results);
    
    // Save report
    const outputDir = path.dirname(options.outputFile);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(options.outputFile, markdown, 'utf8');
    
    logger.info(`Report saved: ${options.outputFile}`);
    
    // Summary
    logger.section('Summary');
    logger.info(`Total districts in data: ${districts.length}`);
    logger.info(`Total responses analyzed: ${results.totalResponses}`);
    logger.info(`Questions processed: ${results.questions.length}`);
    
    const apiStats = apiManager.getStats();
    logger.info('\nAPI Statistics:');
    logger.info(`  Total Requests: ${apiStats.totalRequests}`);
    logger.info(`  Total Errors: ${apiStats.totalErrors}`);
    logger.info(`  Success Rate: ${apiStats.successRate}`);
    
    logger.info('\n✓ State-level analysis complete with validation!');

    
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
