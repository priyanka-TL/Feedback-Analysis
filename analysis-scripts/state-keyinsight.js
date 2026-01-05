#!/usr/bin/env node

/**
 * State-Level Category-Based Insights Script
 * 
 * Generates STATE-LEVEL analysis with category-based KEY INSIGHTS and validates
 * each insight with supporting feedback examples.
 * 
 * This script:
 * - Uses existing categories from the categorized CSV (no re-categorization)
 * - Analyzes ALL districts together for state-level insights
 * - Generates KEY INSIGHTS for EACH CATEGORY separately
 * - Groups insights by themes with supporting teacher quotes
 * - Avoids quote repetition across insights
 * - Shows accurate percentages matching actual responses used
 * - Uses config-driven approach (no hardcoded category mappings)
 * 
 * Output includes:
 * - Category summary with percentages
 * - Category-based KEY INSIGHTS (theme-organized)
 * - Supporting teacher quotes for each insight (no relevance scores)
 * - Accurate percentages for supporting evidence
 * 
 * Usage:
 *   node state-keyinsight.js [options]
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
  questionsConfig: './questions-config-single.json',
  // inputFile: './test.csv',
  inputFile: './Final_Report/singleQ_outputcopy.csv',
  outputFile: './Final_Report/key_insights_report.md'
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
    case '--help':
      console.log(`
State-Level Category-Based Insights - Generate KEY INSIGHTS by category with supporting quotes

This script performs STATE-LEVEL analysis, combining all districts together to generate
category-based insights for each question.

Usage:
  node state-keyinsight.js [options]

Options:
  --config <path>      Path to config file (default: ./config.js)
  --questions <path>   Path to questions config (default: ./questions-config-single.json)
  --input <path>       Input CSV file (default: from config.js)
  --output <path>      Output report (default: ./reports/validated_insights_report.md)
  --help               Show this help message

Environment Variables:
  API_KEYS             Comma-separated Gemini API keys (required)
  MODEL_NAME           Gemini model name (default: gemini-2.0-flash-exp)

Examples:
  node state-keyinsight.js
  node state-keyinsight.js --input data.csv --output report.md
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

// Load utilities
const Logger = require('./utils/logger');
const CSVHandler = require('./utils/csv-handler');
const APIManager = require('./utils/api-manager');

// Initialize utilities
const logger = new Logger(config.logging);
const csvHandler = new CSVHandler(logger);
const apiManager = new APIManager(config, logger);

/**
 * Get category summary from already categorized data with ALL responses
 * Returns primary and secondary categories separately
 */
function getCategorySummary(allData, questionConfig, questionsConfigPath) {
  // Get category columns from questions-config.json
  const questionsConfig = require(path.resolve(questionsConfigPath));
  const primaryColumns = [];
  const secondaryColumns = [];
  
  // Find the question in config and extract category field names
  for (const q of questionsConfig.questions || []) {
    if (q.csv_column === questionConfig.column || q.question_text === questionConfig.column) {
      // Extract field names from response_fields and prepend question ID
      if (q.response_fields && Array.isArray(q.response_fields)) {
        for (const field of q.response_fields) {
          if (field.name && field.name !== 'reasoning') {
            // Construct actual CSV column name: q1_category_1, q2_categories, etc.
            const csvColumnName = `${q.id}_${field.name}`;
            
            // Separate primary and secondary categories based on field description
            if (field.description && field.description.toLowerCase().includes('primary')) {
              primaryColumns.push(csvColumnName);
            } else if (field.description && field.description.toLowerCase().includes('secondary')) {
              secondaryColumns.push(csvColumnName);
            } else {
              // Default: treat as primary if not specified
              primaryColumns.push(csvColumnName);
            }
          }
        }
      }
      break;
    }
  }
  
  if (primaryColumns.length === 0 && secondaryColumns.length === 0) {
    logger.warn(`No category columns found in config for: ${questionConfig.column}`);
    return { primary: {}, secondary: {} };
  }
  
  logger.info(`  Primary category columns: ${primaryColumns.join(', ')}`);
  logger.info(`  Secondary category columns: ${secondaryColumns.join(', ')}`);
  
  const primarySummary = {};
  const secondarySummary = {};

  // Count categories and collect ALL responses
  for (const row of allData) {
    const response = row[questionConfig.column];
    if (!response || !response.trim()) continue;

    // Process primary categories
    for (const catCol of primaryColumns) {
      const categories = row[catCol];
      if (!categories) continue;

      const catList = categories.includes(';') ? categories.split(';') : [categories];
      
      for (const cat of catList) {
        const category = cat.trim();
        if (!category || category === 'NO RESPONSE' || category === 'ERROR') continue;

        if (!primarySummary[category]) {
          primarySummary[category] = {
            count: 0,
            responses: []
          };
        }
        
        primarySummary[category].count++;
        primarySummary[category].responses.push(response);
      }
    }

    // Process secondary categories
    for (const catCol of secondaryColumns) {
      const categories = row[catCol];
      if (!categories) continue;

      const catList = categories.includes(';') ? categories.split(';') : [categories];
      
      for (const cat of catList) {
        const category = cat.trim();
        if (!category || category === 'NO RESPONSE' || category === 'ERROR') continue;

        if (!secondarySummary[category]) {
          secondarySummary[category] = {
            count: 0,
            responses: []
          };
        }
        
        secondarySummary[category].count++;
        secondarySummary[category].responses.push(response);
      }
    }
  }

  return { primary: primarySummary, secondary: secondarySummary };
}

/**
 * Generate insights AND validate them with supporting quotes in a SINGLE API call
 * This reduces API calls from 2 per category to 1 per category
 */
async function generateAndValidateCategoryInsights(category, categoryData, questionConfig, totalResponses, usedQuotes) {
  const responses = categoryData.responses;
  const categoryPercentage = Math.round((categoryData.count / totalResponses) * 100);
  
  // Filter out already used quotes
  const availableResponses = responses.filter(r => !usedQuotes.has(r));
  
  if (availableResponses.length === 0) {
    logger.warn(`No unused quotes available for category: ${category}`);
    return [];
  }
  
  const prompt = `You are analyzing teacher feedback for category "${category}" under question: ${questionConfig.shortName}

CATEGORY: ${category}
RESPONSES IN THIS CATEGORY: ${categoryData.count} out of ${totalResponses} (${categoryPercentage}%)

ALL RESPONSES IN THIS CATEGORY:
${availableResponses.map((r, i) => `${i + 1}. "${r}"`).join('\n')}

TASK: Generate 1-3 KEY INSIGHTS with supporting quotes in ONE response
For each insight:
1. Create a clear THEME (descriptive title)
2. Write the INSIGHT statement (specific to this category, evidence-based, actionable)
3. Select 2-4 SUPPORTING QUOTES from the responses above that BEST support this insight
   - Use DIFFERENT quotes for each insight (no repetition)
   - Include the exact quote text and response number

Guidelines:
- Be specific to THIS category only
- Synthesize patterns within this category
- Be actionable and meaningful for policy/practice
- Avoid generic statements
- Each insight must have unique supporting quotes`;

  const schema = {
    type: 'object',
    properties: {
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            theme: { type: 'string', description: 'Clear theme or topic of this insight' },
            insight: { type: 'string', description: 'The actual insight statement' },
            supporting_quotes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  response_number: { type: 'number' },
                  quote: { type: 'string' }
                },
                required: ['response_number', 'quote']
              },
              description: '2-4 unique supporting quotes for this insight'
            }
          },
          required: ['theme', 'insight', 'supporting_quotes']
        },
        description: '1-3 key insights with supporting quotes'
      }
    },
    required: ['insights']
  };

  try {
    const result = await apiManager.generateContent(prompt, schema);
    const insights = result.insights || [];
    
    // Mark quotes as used and calculate percentages
    const validatedInsights = insights.map(insight => {
      const quotes = insight.supporting_quotes || [];
      const uniqueQuotes = [];
      
      // Filter to ensure no duplicates and mark as used
      for (const q of quotes) {
        if (!usedQuotes.has(q.quote)) {
          uniqueQuotes.push(q);
          usedQuotes.add(q.quote);
        }
      }
      
      return {
        theme: insight.theme || 'Theme',
        insight: insight.insight || '',
        supporting_quotes: uniqueQuotes,
        supporting_count: uniqueQuotes.length,
        percentage: uniqueQuotes.length > 0 ? Math.round((uniqueQuotes.length / responses.length) * 100) : 0
      };
    });
    
    return validatedInsights;
  } catch (error) {
    logger.error(`Failed to generate insights for category ${category}: ${error.message}`);
    return [];
  }
}

/**
 * Process a single question at STATE LEVEL (all districts combined)
 */
async function processQuestion(allData, questionConfig, questionsConfigPath) {
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
  
  // Step 1: Get category summary from existing categorized data (separated by primary/secondary)
  const categorySummary = getCategorySummary(allData, questionConfig, questionsConfigPath);
  
  if (Object.keys(categorySummary.primary).length === 0 && Object.keys(categorySummary.secondary).length === 0) {
    logger.warn(`No categories found for: ${questionConfig.shortName}`);
    return {
      primaryInsights: [],
      secondaryInsights: [],
      totalResponses: responses.length,
      categorySummary
    };
  }
  
  // Step 2: Process PRIMARY categories first
  const primaryInsights = [];
  const usedQuotes = new Set(); // Track used quotes across all categories
  
  if (Object.keys(categorySummary.primary).length > 0) {
    logger.info(`\n  === PRIMARY CATEGORIES ===`);
    const sortedPrimary = Object.entries(categorySummary.primary)
      .sort(([, a], [, b]) => b.count - a.count);
    
    for (const [category, categoryData] of sortedPrimary) {
      logger.info(`  Processing PRIMARY category: ${category} (${categoryData.count} responses)`);
      
      const validatedInsights = await generateAndValidateCategoryInsights(
        category, 
        categoryData, 
        questionConfig, 
        responses.length,
        usedQuotes
      );
      
      if (validatedInsights.length === 0) {
        logger.warn(`    No insights generated for category: ${category}`);
        continue;
      }
      
      logger.info(`    Generated and validated ${validatedInsights.length} insights for category: ${category}`);
      
      primaryInsights.push({
        category,
        count: categoryData.count,
        percentage: Math.round((categoryData.count / responses.length) * 100),
        insights: validatedInsights
      });
      
      // Small delay between categories
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Step 3: Process SECONDARY categories
  const secondaryInsights = [];
  
  if (Object.keys(categorySummary.secondary).length > 0) {
    logger.info(`\n  === SECONDARY CATEGORIES ===`);
    const sortedSecondary = Object.entries(categorySummary.secondary)
      .sort(([, a], [, b]) => b.count - a.count);
    
    for (const [category, categoryData] of sortedSecondary) {
      logger.info(`  Processing SECONDARY category: ${category} (${categoryData.count} responses)`);
      
      const validatedInsights = await generateAndValidateCategoryInsights(
        category, 
        categoryData, 
        questionConfig, 
        responses.length,
        usedQuotes
      );
      
      if (validatedInsights.length === 0) {
        logger.warn(`    No insights generated for category: ${category}`);
        continue;
      }
      
      logger.info(`    Generated and validated ${validatedInsights.length} insights for category: ${category}`);
      
      secondaryInsights.push({
        category,
        count: categoryData.count,
        percentage: Math.round((categoryData.count / responses.length) * 100),
        insights: validatedInsights
      });
      
      // Small delay between categories
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  return {
    primaryInsights,
    secondaryInsights,
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
  md += `This report presents category-based KEY INSIGHTS for each question at the STATE level, analyzing feedback from all districts together. `;
  md += `Categories are organized as Primary Categories first, followed by Secondary Categories. `;
  md += `Each category includes theme-based insights with supporting teacher quotes.\n\n`;
  md += `---\n\n`;
  
  for (const questionResult of results.questions) {
    if (!questionResult) continue;
    
    md += `## ${questionResult.question_text || questionResult.column}\n\n`;
    md += `**Total Responses:** ${questionResult.totalResponses}\n\n`;
    
    // Category Summary Section - Show PRIMARY first, then SECONDARY
    if (questionResult.categorySummary) {
      const hasPrimary = questionResult.categorySummary.primary && Object.keys(questionResult.categorySummary.primary).length > 0;
      const hasSecondary = questionResult.categorySummary.secondary && Object.keys(questionResult.categorySummary.secondary).length > 0;
      
      if (hasPrimary || hasSecondary) {
        md += `### Categories Summary\n\n`;
        
        if (hasPrimary) {
          md += `**Primary Categories:**\n\n`;
          const sortedPrimary = Object.entries(questionResult.categorySummary.primary)
            .sort(([, a], [, b]) => b.count - a.count);
          
          for (const [category, data] of sortedPrimary) {
            const percentage = Math.round((data.count / questionResult.totalResponses) * 100);
            md += `- **${category}**: ${data.count} responses (${percentage}%)\n`;
          }
          md += `\n`;
        }
        
        if (hasSecondary) {
          md += `**Secondary Categories:**\n\n`;
          const sortedSecondary = Object.entries(questionResult.categorySummary.secondary)
            .sort(([, a], [, b]) => b.count - a.count);
          
          for (const [category, data] of sortedSecondary) {
            const percentage = Math.round((data.count / questionResult.totalResponses) * 100);
            md += `- **${category}**: ${data.count} responses (${percentage}%)\n`;
          }
          md += `\n`;
        }
      }
    }
    
    // PRIMARY CATEGORY INSIGHTS
    if (questionResult.primaryInsights && questionResult.primaryInsights.length > 0) {
      md += `### Primary Category Insights\n\n`;
      
      for (const categoryInsight of questionResult.primaryInsights) {
        md += `#### ${categoryInsight.category}\n\n`;
        md += `**Responses:** ${categoryInsight.count} (${categoryInsight.percentage}%)\n\n`;
        
        if (!categoryInsight.insights || categoryInsight.insights.length === 0) {
          md += `⚠️ No insights generated for this category.\n\n`;
          continue;
        }
        
        // Group insights by theme
        for (const insight of categoryInsight.insights) {
          md += `##### ${insight.theme}\n\n`;
          md += `${insight.insight}\n\n`;
          
          if (insight.supporting_quotes && insight.supporting_quotes.length > 0) {
            md += `**Supporting Evidence (${insight.supporting_count} response${insight.supporting_count !== 1 ? 's' : ''}, ${insight.percentage}%):**\n\n`;
            
            for (const quote of insight.supporting_quotes) {
              md += `- "${quote.quote}"\n\n`;
            }
          } else {
            md += `⚠️ No supporting evidence found.\n\n`;
          }
          
          md += `---\n\n`;
        }
      }
    }
    
    // SECONDARY CATEGORY INSIGHTS
    if (questionResult.secondaryInsights && questionResult.secondaryInsights.length > 0) {
      md += `### Secondary Category Insights\n\n`;
      
      for (const categoryInsight of questionResult.secondaryInsights) {
        md += `#### ${categoryInsight.category}\n\n`;
        md += `**Responses:** ${categoryInsight.count} (${categoryInsight.percentage}%)\n\n`;
        
        if (!categoryInsight.insights || categoryInsight.insights.length === 0) {
          md += `⚠️ No insights generated for this category.\n\n`;
          continue;
        }
        
        // Group insights by theme
        for (const insight of categoryInsight.insights) {
          md += `##### ${insight.theme}\n\n`;
          md += `${insight.insight}\n\n`;
          
          if (insight.supporting_quotes && insight.supporting_quotes.length > 0) {
            md += `**Supporting Evidence (${insight.supporting_count} response${insight.supporting_count !== 1 ? 's' : ''}, ${insight.percentage}%):**\n\n`;
            
            for (const quote of insight.supporting_quotes) {
              md += `- "${quote.quote}"\n\n`;
            }
          } else {
            md += `⚠️ No supporting evidence found.\n\n`;
          }
          
          md += `---\n\n`;
        }
      }
    }
    
    // Handle case where no insights were generated
    if ((!questionResult.primaryInsights || questionResult.primaryInsights.length === 0) && 
        (!questionResult.secondaryInsights || questionResult.secondaryInsights.length === 0)) {
      md += `### Key Insights\n\n`;
      md += `⚠️ No insights generated for this question.\n\n`;
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
    logger.section('State-Level Category-Based Insights');
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
    const questionsConfigPath = config.paths.questionsConfig || options.questionsConfig;
    const questionsConfig = require(path.resolve(questionsConfigPath));
    const questionColumns = require('./question-columns.json');
    
    logger.info(`Using questions config: ${questionsConfigPath}`);
    
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
      const result = await processQuestion(data, questionConfig, questionsConfigPath);
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
    
    logger.info('\n✓ State-level category-based analysis complete!');
    
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
