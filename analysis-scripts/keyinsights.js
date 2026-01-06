#!/usr/bin/env node

/**
 * STATE-LEVEL INSIGHTS SCRIPT - VERSION 3 (ULTRA-STRICT)
 * 
 * CRITICAL FIXES:
 * 1. ULTRA-STRICT duplicate detection - catches "Yes" ≈ "Yes, for now it is done" ≈ "No further plan"
 * 2. Meaning-based similarity instead of just word matching
 * 3. Much stricter AI prompting with concrete examples
 * 4. Post-processing filter to remove ANY remaining duplicates
 * 
 * EXAMPLES OF DUPLICATES NOW CAUGHT:
 * - "Yes" ≈ "Yes, for now it is done" → Keeps longest only
 * - "No further plan" ≈ "Planning to maintain" ≈ "No plan" → Keeps longest only
 * - "Not decided yet" ≈ "No plans as of now" → Keeps longest only
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
  inputFile: './Final_Report/singleQ_output.csv',
  outputFile: './Final_Report/key_insights_report_v3.md'
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
State-Level Category-Based Insights

Critical Improvements:
- Ultra-strict duplicate detection
- Meaning-based similarity (not just word matching)
- Post-processing duplicate removal
- Better semantic grouping

Usage:
  node state-keyinsight-v3.js [options]

Options:
  --config <path>      Path to config file (default: ./config.js)
  --questions <path>   Path to questions config (default: ./questions-config-single.json)
  --input <path>       Input CSV file
  --output <path>      Output report
  --help               Show this help message
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
 * V3: ULTRA-STRICT semantic similarity
 * Catches cases like "Yes" ≈ "Yes, for now" ≈ "No plan"
 */
function calculateSemanticSimilarity(response1, response2) {
  const r1 = response1.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const r2 = response2.toLowerCase().replace(/[^\w\s]/g, '').trim();
  
  // Exact match
  if (r1 === r2) return 1.0;
  
  // One contains the other (e.g., "yes" in "yes for now")
  if (r1.includes(r2) || r2.includes(r1)) {
    return 0.95; // Very high similarity
  }
  
  // Extract meaningful words
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'have', 'has', 'this', 'that', 'from', 
    'they', 'them', 'been', 'were', 'was', 'are', 'will', 'yes', 'just', 
    'but', 'not', 'more', 'can', 'all', 'one', 'out', 'what', 'when', 
    'than', 'like', 'some', 'into', 'very', 'our', 'their', 'also',
    'now', 'yet', 'done', 'plan', 'plans', 'further'
  ]);
  
  const words1 = r1.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  const words2 = r2.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  
  // If both have no meaningful words after filtering, they're likely generic
  if (words1.length === 0 && words2.length === 0) {
    return 0.9; // Generic statements like "Yes" and "Done" are similar
  }
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // ULTRA-STRICT for very brief responses (1-4 meaningful words)
  if (words1.length <= 4 || words2.length <= 4) {
    const commonWords = words1.filter(w => words2.includes(w));
    
    // If they share ANY meaningful word in brief responses, very high similarity
    if (commonWords.length >= 1) {
      // Additional check: are they expressing similar concepts?
      const maintenanceConcepts = new Set(['maintain', 'maintaining', 'keep', 'continue', 'sustain', 'preserve']);
      const noPlanConcepts = new Set(['decided', 'plan', 'planning', 'decide']);
      const completeConcepts = new Set(['done', 'complete', 'completed', 'finished']);
      
      const hasMaintenanceWord1 = words1.some(w => maintenanceConcepts.has(w));
      const hasMaintenanceWord2 = words2.some(w => maintenanceConcepts.has(w));
      
      const hasNoPlanWord1 = words1.some(w => noPlanConcepts.has(w));
      const hasNoPlanWord2 = words2.some(w => noPlanConcepts.has(w));
      
      const hasCompleteWord1 = words1.some(w => completeConcepts.has(w));
      const hasCompleteWord2 = words2.some(w => completeConcepts.has(w));
      
      // Same conceptual category = very similar
      if ((hasMaintenanceWord1 && hasMaintenanceWord2) ||
          (hasNoPlanWord1 && hasNoPlanWord2) ||
          (hasCompleteWord1 && hasCompleteWord2)) {
        return 0.9;
      }
      
      return 0.85;
    }
    
    // Even without shared words, if both are very brief, check length similarity
    if (words1.length <= 2 && words2.length <= 2) {
      return 0.7; // Brief responses are often similar in meaning
    }
    
    return 0;
  }
  
  // For medium-length responses (5-10 words)
  if (words1.length <= 10 || words2.length <= 10) {
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = new Set([...set1].filter(w => set2.has(w)));
    const union = new Set([...set1, ...set2]);
    const jaccard = intersection.size / union.size;
    
    // Boost similarity for medium-length with overlap
    if (jaccard >= 0.3) {
      return jaccard + 0.4; // Makes 30% overlap = 70% similarity
    }
    
    return jaccard;
  }
  
  // For longer responses, standard Jaccard
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = new Set([...set1].filter(w => set2.has(w)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/**
 * V3: Enhanced quality scoring with STRONGER penalties
 */
function calculateResponseQuality(response) {
  const text = response.trim();
  const wordCount = text.split(/\s+/).length;
  
  let score = 0;
  
  // Length score with STRONG preference for detailed responses
  if (wordCount >= 25 && wordCount <= 60) {
    score += 30; // Excellent - very detailed
  } else if (wordCount >= 20 && wordCount < 25) {
    score += 25; // Excellent
  } else if (wordCount >= 15 && wordCount < 20) {
    score += 20; // Very good
  } else if (wordCount >= 12 && wordCount < 15) {
    score += 15; // Good
  } else if (wordCount >= 10 && wordCount < 12) {
    score += 10; // Acceptable
  } else if (wordCount >= 8 && wordCount < 10) {
    score += 5; // Below average
  } else if (wordCount >= 5 && wordCount < 8) {
    score -= 5; // Poor - avoid
  } else {
    score -= 15; // Very poor - strongly avoid
  }
  
  // VERY STRONG penalty for generic responses
  const genericPhrases = [
    'yes', 'no', 'maintain', 'continue', 'planning', 'improvement',
    'just maintain', 'will maintain', 'planning to maintain',
    'no plan', 'not decided', 'not yet', 'for now', 'as of now',
    'done', 'complete', 'decided'
  ];
  
  const lowerText = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  
  // Check for EXACT generic phrase matches
  for (const phrase of genericPhrases) {
    if (lowerText === phrase) {
      score -= 20; // VERY strong penalty for single-word generics
    } else if (lowerText.startsWith(phrase + ' ') || lowerText.endsWith(' ' + phrase)) {
      score -= 10; // Strong penalty for generic phrases
    }
  }
  
  // Bonus for specific details
  const detailIndicators = [
    'by', 'through', 'using', 'with', 'organizing', 'implementing',
    'creating', 'developing', 'establishing', 'conducting', 'introducing',
    'started', 'helped', 'improved', 'encouraged', 'focused', 'noticed',
    'worked', 'collaborated', 'incorporated', 'increased', 'implemented',
    'organized', 'initiated', 'developed', 'enhanced', 'strengthened'
  ];
  
  for (const indicator of detailIndicators) {
    if (lowerText.includes(indicator)) {
      score += 4; // Increased bonus
    }
  }
  
  // Strong bonus for multiple examples (commas)
  const commaCount = (text.match(/,/g) || []).length;
  if (commaCount > 0) {
    score += Math.min(commaCount * 3, 12); // Up to 12 points for examples
  }
  
  return score;
}

/**
 * V3: Post-process to remove ANY remaining semantic duplicates
 */
function removeDuplicatesPostProcessing(quotes, threshold = 0.7) {
  const filtered = [];
  
  for (const quote of quotes) {
    let isDuplicate = false;
    
    for (const existing of filtered) {
      const sim = calculateSemanticSimilarity(quote.quote, existing.quote);
      if (sim >= threshold) {
        // Keep the one with better quality
        const quoteQuality = calculateResponseQuality(quote.quote);
        const existingQuality = calculateResponseQuality(existing.quote);
        
        if (quoteQuality > existingQuality) {
          // Replace existing with this better one
          const idx = filtered.indexOf(existing);
          filtered[idx] = quote;
        }
        // Otherwise, skip this quote (it's a duplicate of existing)
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      filtered.push(quote);
    }
  }
  
  return filtered;
}

function getCategorySummary(allData, questionConfig, questionsConfigPath) {
  const questionsConfig = require(path.resolve(questionsConfigPath));
  const primaryColumns = [];
  const secondaryColumns = [];
  
  for (const q of questionsConfig.questions || []) {
    if (q.csv_column === questionConfig.column || q.question_text === questionConfig.column) {
      if (q.response_fields && Array.isArray(q.response_fields)) {
        for (const field of q.response_fields) {
          if (field.name && field.name !== 'reasoning') {
            const csvColumnName = `${q.id}_${field.name}`;
            
            if (field.description && field.description.toLowerCase().includes('primary')) {
              primaryColumns.push(csvColumnName);
            } else if (field.description && field.description.toLowerCase().includes('secondary')) {
              secondaryColumns.push(csvColumnName);
            } else {
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

  for (const row of allData) {
    const response = row[questionConfig.column];
    if (!response || !response.trim()) continue;

    for (const catCol of primaryColumns) {
      const categories = row[catCol];
      if (!categories) continue;

      let catList = [];
      if (categories.includes(';')) {
        catList = categories.split(';');
      } else if (categories.includes(',')) {
        catList = categories.split(',');
      } else {
        catList = [categories];
      }
      
      for (const cat of catList) {
        const category = cat.trim();
        if (!category || category === 'NO RESPONSE' || category === 'ERROR') continue;

        if (!primarySummary[category]) {
          primarySummary[category] = { count: 0, responses: [] };
        }
        
        primarySummary[category].count++;
        primarySummary[category].responses.push(response);
      }
    }

    for (const catCol of secondaryColumns) {
      const categories = row[catCol];
      if (!categories) continue;

      let catList = [];
      if (categories.includes(';')) {
        catList = categories.split(';');
      } else if (categories.includes(',')) {
        catList = categories.split(',');
      } else {
        catList = [categories];
      }
      
      for (const cat of catList) {
        const category = cat.trim();
        if (!category || category === 'NO RESPONSE' || category === 'ERROR') continue;

        if (!secondarySummary[category]) {
          secondarySummary[category] = { count: 0, responses: [] };
        }
        
        secondarySummary[category].count++;
        secondarySummary[category].responses.push(response);
      }
    }
  }

  return { primary: primarySummary, secondary: secondarySummary };
}

/**
 * V3: ULTRA-STRICT insight generation with extensive examples
 */
async function generateAndValidateCategoryInsights(category, categoryData, questionConfig, totalResponses, usedQuotes) {
  const responses = categoryData.responses;
  const categoryPercentage = Math.round((categoryData.count / totalResponses) * 100);
  
  const availableResponses = responses.filter(r => !usedQuotes.has(r));
  
  if (availableResponses.length === 0) {
    logger.warn(`No unused quotes available for category: ${category}`);
    return [];
  }
  
  // Sort by quality
  const responsesWithQuality = availableResponses.map(r => ({
    text: r,
    quality: calculateResponseQuality(r),
    length: r.trim().split(/\s+/).length
  })).sort((a, b) => b.quality - a.quality);
  
  const topResponses = responsesWithQuality.slice(0, Math.min(100, responsesWithQuality.length));
  
  const prompt = `You are analyzing teacher feedback for category "${category}" under question: ${questionConfig.shortName}

CATEGORY: ${category}
TOTAL RESPONSES: ${categoryData.count} out of ${totalResponses} (${categoryPercentage}%)
HIGH-QUALITY RESPONSES: ${topResponses.length}

TOP RESPONSES (sorted by quality):
${topResponses.map((r, i) => `${i + 1}. "${r.text}" [${r.length} words, score: ${r.quality}]`).join('\n')}

═══════════════════════════════════════════════════════════════
CRITICAL REQUIREMENTS - READ CAREFULLY:
═══════════════════════════════════════════════════════════════

**REQUIREMENT 1: ZERO SEMANTIC DUPLICATES - ABSOLUTELY MANDATORY**

You MUST NOT include quotes that express the same core meaning, even if worded differently.

❌ WRONG - These are ALL DUPLICATES (meaning: "no plan"):
1. "Yes, for now it is done"
2. "No further plan. Planning to maintain"  
3. "Yes"
4. "Not decided yet"
5. "No plans as of now"
→ ALL express "no immediate plan" → Select ONLY ONE (the most detailed)

❌ WRONG - These are ALL DUPLICATES (meaning: "will maintain"):
1. "Planning to maintain"
2. "Will maintain what we have"
3. "Continue maintaining"
4. "Just maintain"
→ ALL express "maintain current state" → Select ONLY ONE

❌ WRONG - These are ALL DUPLICATES (meaning: "parent participation"):
1. "Parents cooperation"
2. "Parents involvement"
3. "Parents participation"
4. "More parents engagement"
→ ALL express "parents participating" → Select ONLY ONE with most detail

✓ CORRECT - These are SEMANTICALLY DIFFERENT:
1. "Since this academic year is already coming to an end next year after resuming school will think over it" (timing constraint)
2. "Not at the moment. The academic session is about to end. The students are appearing their final exams" (specific exam context)
3. "We are putting some agendas for the coming 3 to 7 months" (has specific timeline and plan)
→ Each expresses a DIFFERENT reason/context

**REQUIREMENT 2: MANDATORY LENGTH PREFERENCE**

ALWAYS prioritize responses 12+ words. NEVER select responses <8 words unless there are ZERO alternatives.

❌ NEVER SELECT:
- "Yes"
- "Not yet"
- "No plan"
- "Planning to maintain"
- "Continue"

✓ ALWAYS PREFER:
- "Since this academic year is already coming to an end next year after resuming school will think over it" (19 words)
- "Not at the moment. The academic session is about to end. The students are appearing their final exams" (18 words)

**REQUIREMENT 3: EACH QUOTE MUST ADD NEW, UNIQUE INFORMATION**

Within one insight, every quote must express a DIFFERENT aspect or approach:

✓ GOOD (each adds new info):
1. "organizing group discussions where students share ideas collaboratively" (method: discussion)
2. "Through hands-on activity-based teaching to make lessons joyful" (method: activity, emotional aspect)
3. "Using visual aids and teaching-learning materials for better understanding" (method: visual/materials)
4. "Implementing project-based learning with real-world applications" (method: projects, real-world)

❌ BAD (all say same thing):
1. "organizing group discussions"
2. "conducting group discussions in class"
3. "group work and discussions"
→ Select ONLY the most detailed one!

INSTRUCTIONS:
1. Identify 2-4 DISTINCT themes (only if truly different)
2. For each theme, select 6-12 quotes where EVERY quote expresses something NEW
3. ELIMINATE all semantic duplicates - if meaning is same, keep ONLY the longest/most detailed
4. REQUIRE quotes to be 12+ words (only exception: if literally zero alternatives exist)
5. Each quote must teach us something NEW about the theme

CRITICAL: If you're unsure whether two quotes are duplicates, they probably are - KEEP ONLY ONE.`;

  const schema = {
    type: 'object',
    properties: {
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            theme: { type: 'string' },
            insight: { type: 'string' },
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
              minItems: 6,
              maxItems: 12
            }
          },
          required: ['theme', 'insight', 'supporting_quotes']
        },
        minItems: 2,
        maxItems: 4
      }
    },
    required: ['insights']
  };

  try {
    const result = await apiManager.generateContent(prompt, schema);
    const insights = result.insights || [];
    
    const globallyCountedResponses = new Set();
    
    const validatedInsights = insights.map(insight => {
      const quotes = insight.supporting_quotes || [];
      let selectedQuotes = [];
      
      // Sort by quality
      const quotesWithQuality = quotes.map(q => ({
        ...q,
        quality: calculateResponseQuality(q.quote),
        length: q.quote.trim().split(/\s+/).length
      })).sort((a, b) => b.quality - a.quality);
      
      // First pass: quality-based selection
      for (const q of quotesWithQuality) {
        if (usedQuotes.has(q.quote)) continue;
        
        // Check against already selected in THIS insight
        let isDuplicate = false;
        for (const selected of selectedQuotes) {
          const similarity = calculateSemanticSimilarity(q.quote, selected.quote);
          if (similarity >= 0.7) {
            isDuplicate = true;
            break;
          }
        }
        
        if (isDuplicate) continue;
        
        selectedQuotes.push(q);
      }
      
      // V3: POST-PROCESSING - Remove ANY remaining duplicates
      selectedQuotes = removeDuplicatesPostProcessing(selectedQuotes, 0.7);
      
      // Count representatives
      const finalQuotes = [];
      for (const q of selectedQuotes) {
        let representativeCount = 0;
        for (const response of responses) {
          if (globallyCountedResponses.has(response)) continue;
          
          const similarity = calculateSemanticSimilarity(q.quote, response);
          if (similarity >= 0.7) {
            representativeCount++;
            globallyCountedResponses.add(response);
            usedQuotes.add(response);
          }
        }
        
        if (representativeCount > 0) {
          finalQuotes.push({
            ...q,
            represents_count: representativeCount
          });
        }
      }
      
      const totalRepresentedCount = finalQuotes.reduce((sum, q) => sum + (q.represents_count || 1), 0);
      
      return {
        theme: insight.theme || 'Theme',
        insight: insight.insight || '',
        supporting_quotes: finalQuotes,
        supporting_count: totalRepresentedCount,
        percentage: totalRepresentedCount > 0 ? Math.round((totalRepresentedCount / responses.length) * 100) : 0
      };
    });
    
    const filteredInsights = validatedInsights.filter(insight => {
      if (insight.supporting_quotes.length < 3) {
        logger.warn(`  Filtered out insight "${insight.theme}" - insufficient unique quotes (${insight.supporting_quotes.length} < 3)`);
        return false;
      }
      return true;
    });
    
    const totalCoverage = filteredInsights.reduce((sum, insight) => sum + insight.supporting_count, 0);
    const coveragePercentage = Math.round((totalCoverage / categoryData.count) * 100);
    
    logger.info(`  Coverage for category "${category}": ${totalCoverage}/${categoryData.count} responses (${coveragePercentage}%)`);
    
    if (coveragePercentage < 50) {
      logger.warn(`  ⚠️ LOW COVERAGE: ${coveragePercentage}% (target: 50-70%)`);
    } else if (coveragePercentage >= 50 && coveragePercentage <= 70) {
      logger.info(`  ✓ Good coverage: ${coveragePercentage}%`);
    } else {
      logger.info(`  ℹ High coverage: ${coveragePercentage}%`);
    }
    
    return filteredInsights;
  } catch (error) {
    logger.error(`Failed to generate insights for category ${category}: ${error.message}`);
    return [];
  }
}

async function processQuestion(allData, questionConfig, questionsConfigPath) {
  const columnName = questionConfig.column;
  
  const responses = allData
    .map(row => row[columnName])
    .filter(text => text && text.trim().length > 0);
  
  if (responses.length === 0) {
    logger.warn(`No responses found for: ${questionConfig.shortName}`);
    return null;
  }
  
  logger.info(`Analyzing ${responses.length} responses for: ${questionConfig.shortName}`);
  
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
  
  const primaryInsights = [];
  const usedQuotes = new Set();
  
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
      
      logger.info(`    Generated ${validatedInsights.length} insights for category: ${category}`);
      
      primaryInsights.push({
        category,
        count: categoryData.count,
        percentage: Math.round((categoryData.count / responses.length) * 100),
        insights: validatedInsights
      });
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
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
      
      logger.info(`    Generated ${validatedInsights.length} insights for category: ${category}`);
      
      secondaryInsights.push({
        category,
        count: categoryData.count,
        percentage: Math.round((categoryData.count / responses.length) * 100),
        insights: validatedInsights
      });
      
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

function generateMarkdown(results) {
  let md = `# School Improvement Analysis Report (State-Level)\n\n`;
  md += `**Generated:** ${new Date().toISOString()}\n`;
  md += `**Analysis Scope:** State-level\n`;
  md += `**Districts Included:** ${results.districts.join(', ')}\n`;
  md += `**Total Responses:** ${results.totalResponses}\n\n`;
  
  md += `## Overview\n\n`;
  md += `This report presents category-based KEY INSIGHTS for each question at the STATE level, analyzing feedback from all districts together. `;
  md += `Categories are organized as Primary Categories first, followed by Secondary Categories. `;
  md += `Each category includes theme-based insights with supporting teacher quotes.\n\n`;
  md += `---\n\n`;
  
  for (const questionResult of results.questions) {
    if (!questionResult) continue;
    
    const shortName = questionResult.shortName || questionResult.id || 'Question';
    md += `## ${shortName}\n\n`;
    md += `**Question:** ${questionResult.question_text || questionResult.column}\n\n`;
    md += `**Total Responses:** ${questionResult.totalResponses}\n\n`;
    
    if (questionResult.categorySummary) {
      const hasPrimary = questionResult.categorySummary.primary && Object.keys(questionResult.categorySummary.primary).length > 0;
      const hasSecondary = questionResult.categorySummary.secondary && Object.keys(questionResult.categorySummary.secondary).length > 0;
      
      if (hasPrimary || hasSecondary) {
        md += `### Categories Summary\n\n`;
        
        if (hasPrimary) {
          md += `**Primary Categories:**\n\n`;
          md += `| Category | Responses | Percentage |\n`;
          md += `|----------|-----------|------------|\n`;
          
          const sortedPrimary = Object.entries(questionResult.categorySummary.primary)
            .sort(([, a], [, b]) => b.count - a.count);
          
          for (const [category, data] of sortedPrimary) {
            const percentage = Math.round((data.count / questionResult.totalResponses) * 100);
            md += `| ${category} | ${data.count} | ${percentage}% |\n`;
          }
          md += `\n`;
        }
        
        if (hasSecondary) {
          md += `**Secondary Categories:**\n\n`;
          md += `| Category | Responses | Percentage |\n`;
          md += `|----------|-----------|------------|\n`;
          
          const sortedSecondary = Object.entries(questionResult.categorySummary.secondary)
            .sort(([, a], [, b]) => b.count - a.count);
          
          for (const [category, data] of sortedSecondary) {
            const percentage = Math.round((data.count / questionResult.totalResponses) * 100);
            md += `| ${category} | ${data.count} | ${percentage}% |\n`;
          }
          md += `\n`;
        }
      }
    }
    
    if (questionResult.primaryInsights && questionResult.primaryInsights.length > 0) {
      md += `### Primary Category Insights\n\n`;
      
      for (const categoryInsight of questionResult.primaryInsights) {
        md += `#### ${categoryInsight.category}\n\n`;
        md += `**Responses:** ${categoryInsight.count} (${categoryInsight.percentage}%)\n\n`;
        
        if (!categoryInsight.insights || categoryInsight.insights.length === 0) {
          md += `⚠️ No insights generated for this category.\n\n`;
          continue;
        }
        
        for (const insight of categoryInsight.insights) {
          md += `##### ${insight.theme}\n\n`;
          md += `${insight.insight}\n\n`;
          
          if (insight.supporting_quotes && insight.supporting_quotes.length > 0) {
            const totalFeedbackCount = insight.supporting_count || insight.supporting_quotes.length;
            const feedbackPercentage = Math.round((totalFeedbackCount / categoryInsight.count) * 100);
            md += `**Supporting Evidence (${totalFeedbackCount} of ${categoryInsight.count} responses, ${feedbackPercentage}%):**\n\n`;
            
            const sortedQuotes = [...insight.supporting_quotes].sort((a, b) => {
              const qualityA = calculateResponseQuality(a.quote);
              const qualityB = calculateResponseQuality(b.quote);
              return qualityB - qualityA;
            });
            
            for (const quote of sortedQuotes) {
              md += `- "${quote.quote}"\n\n`;
            }
          } else {
            md += `⚠️ No supporting evidence found.\n\n`;
          }
          
          md += `---\n\n`;
        }
      }
    }
    
    if (questionResult.secondaryInsights && questionResult.secondaryInsights.length > 0) {
      md += `### Secondary Category Insights\n\n`;
      
      for (const categoryInsight of questionResult.secondaryInsights) {
        md += `#### ${categoryInsight.category}\n\n`;
        md += `**Responses:** ${categoryInsight.count} (${categoryInsight.percentage}%)\n\n`;
        
        if (!categoryInsight.insights || categoryInsight.insights.length === 0) {
          md += `⚠️ No insights generated for this category.\n\n`;
          continue;
        }
        
        for (const insight of categoryInsight.insights) {
          md += `##### ${insight.theme}\n\n`;
          md += `${insight.insight}\n\n`;
          
          if (insight.supporting_quotes && insight.supporting_quotes.length > 0) {
            const totalFeedbackCount = insight.supporting_count || insight.supporting_quotes.length;
            const feedbackPercentage = Math.round((totalFeedbackCount / categoryInsight.count) * 100);
            md += `**Supporting Evidence (${totalFeedbackCount} of ${categoryInsight.count} responses, ${feedbackPercentage}%):**\n\n`;
            
            const sortedQuotes = [...insight.supporting_quotes].sort((a, b) => {
              const qualityA = calculateResponseQuality(a.quote);
              const qualityB = calculateResponseQuality(b.quote);
              return qualityB - qualityA;
            });
            
            for (const quote of sortedQuotes) {
              md += `- "${quote.quote}"\n\n`;
            }
          } else {
            md += `⚠️ No supporting evidence found.\n\n`;
          }
          
          md += `---\n\n`;
        }
      }
    }
    
    if ((!questionResult.primaryInsights || questionResult.primaryInsights.length === 0) && 
        (!questionResult.secondaryInsights || questionResult.secondaryInsights.length === 0)) {
      md += `### Key Insights\n\n`;
      md += `⚠️ No insights generated for this question.\n\n`;
    }
    
    md += `\n`;
  }
  
  return md;
}

async function main() {
  try {
    logger.section('State-Level Insights - VERSION 3 (ULTRA-STRICT)');
    logger.info(`Input: ${config.paths.input}`);
    logger.info(`Output: ${options.outputFile}`);
    logger.info(`Provider: ${config.api.provider}`);
    
    if (config.api.provider === 'gemini') {
      logger.info(`Model: ${config.api.gemini.model}`);
      logger.info(`API Keys: ${config.api.gemini.keys.length}`);
    } else if (config.api.provider === 'bedrock') {
      logger.info(`Model: ${config.api.bedrock.model}`);
      logger.info(`Region: ${config.api.bedrock.region}`);
    }
    
    logger.section('Loading Data');
    const data = await csvHandler.read(config.paths.input);
    logger.info(`Loaded ${data.length} rows`);
    
    const districts = [...new Set(data.map(row => row.District))].filter(d => d);
    logger.info(`Data contains ${districts.length} districts: ${districts.join(', ')}`);
    
    const questionsConfigPath = config.paths.questionsConfig || options.questionsConfig;
    const questionsConfig = require(path.resolve(questionsConfigPath));
    
    logger.info(`Using questions config: ${questionsConfigPath}`);
    
    const questions = [];
    for (const q of questionsConfig.questions || []) {
      const shortName = q.section || (q.id ? q.id.toUpperCase() : q.question_text.substring(0, 50));
      questions.push({
        id: q.id,
        shortName: shortName,
        column: q.csv_column,
        question_text: q.question_text,
        response_fields: q.response_fields,
        section: q.section
      });
    }
    
    logger.info(`Processing ${questions.length} questions`);
    
    logger.section('Processing with ULTRA-STRICT Duplicate Detection');
    logger.info('V3: Post-processing filter + concept-based similarity');
    
    const results = {
      totalResponses: data.length,
      districts: districts,
      questions: []
    };
    
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
      
      if (i < questions.length - 1) {
        logger.info('Waiting 7 seconds before next question...');
        await new Promise(resolve => setTimeout(resolve, 7000));
      }
    }
    
    logger.section('Generating Report');
    const markdown = generateMarkdown(results);
    
    const outputDir = path.dirname(options.outputFile);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(options.outputFile, markdown, 'utf8');
    
    logger.info(`Report saved: ${options.outputFile}`);
    
    logger.section('Summary');
    logger.info(`Total districts: ${districts.length}`);
    logger.info(`Total responses: ${results.totalResponses}`);
    logger.info(`Questions processed: ${results.questions.length}`);
    
    const apiStats = apiManager.getStats();
    const costInfo = apiManager.calculateCost();
    
    logger.info('\nAPI Statistics:');
    logger.info(`  Provider: ${apiStats.provider}`);
    logger.info(`  Total Requests: ${apiStats.totalRequests}`);
    logger.info(`  Success Rate: ${apiStats.successRate}`);
    
    logger.info('\n💰 Token Usage & Cost:');
    logger.info(`  Model: ${costInfo.model}`);
    logger.info(`  Input Tokens: ${costInfo.inputTokens.toLocaleString()}`);
    logger.info(`  Output Tokens: ${costInfo.outputTokens.toLocaleString()}`);
    logger.info(`  Total Cost: $${costInfo.totalCostUSD.toFixed(4)}`);
    
    logger.info('\n✓ V3 ULTRA-STRICT analysis complete!');
    
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();