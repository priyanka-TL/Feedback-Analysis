#!/usr/bin/env node

/**
 * CSV Filter Script
 * 
 * Filters and fixes CSV data by:
 * - Fixing empty response categorizations
 * - Correcting common typos
 * - Removing or flagging invalid rows
 * - Normalizing category values
 * 
 * Usage:
 *   node filter-csv.js [options]
 * 
 * Options:
 *   --config <path>       Path to config file (default: ./config.js)
 *   --input <path>        Input CSV file (default: from config.js)
 *   --output <path>       Output CSV file (default: from config.js)
 *   --mapping <path>      Path to question-category mapping file (optional)
 *   --fix-typos           Fix common typos (default: true)
 *   --fix-empty           Fix empty response categorizations (default: true)
 *   --normalize           Normalize category values (default: true)
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  configPath: './config.js',
  inputFile: null,
  outputFile: null,
  mappingFile: null,
  fixTypos: true,
  fixEmpty: true,
  normalize: true
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
    case '--mapping':
      options.mappingFile = args[++i];
      break;
    case '--fix-typos':
      options.fixTypos = args[++i] !== 'false';
      break;
    case '--fix-empty':
      options.fixEmpty = args[++i] !== 'false';
      break;
    case '--normalize':
      options.normalize = args[++i] !== 'false';
      break;
    case '--help':
      console.log(`
CSV Filter Script - Clean and fix CSV data

Usage:
  node filter-csv.js [options]

Options:
  --config <path>       Path to config file (default: ./config.js)
  --input <path>        Input CSV file (default: from config.js)
  --output <path>       Output CSV file (default: from config.js)
  --mapping <path>      Path to question-category mapping file (optional)
  --fix-typos           Fix common typos (default: true)
  --fix-empty           Fix empty response categorizations (default: true)
  --normalize           Normalize category values (default: true)
  --help                Show this help message

Examples:
  node filter-csv.js --input data.csv --output clean.csv
  node filter-csv.js --fix-empty true --fix-typos true
  node filter-csv.js --mapping question-mapping.json
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
if (options.outputFile) {
  config.paths.output = options.outputFile;
}

// Load utilities
const Logger = require('./utils/logger');
const CSVHandler = require('./utils/csv-handler');
const Validator = require('./utils/validator');

// Initialize utilities
const logger = new Logger(config.logging);
const csvHandler = new CSVHandler(logger);
const validator = new Validator(config, logger);

/**
 * Default question-category mapping
 * Maps question columns to their category columns
 */
const DEFAULT_MAPPING = {
  'Q1': 'Q1_Category',
  'Q2': 'Q2_Category',
  'Q3': 'Q3_Category',
  'Q4': 'Q4_Category',
  'Q5': 'Q5_Category',
  'Q6': 'Q6_Category',
  'Q7': 'Q7_Category',
  'Q8': 'Q8_Category'
};

/**
 * Load question-category mapping
 */
function loadMapping() {
  if (options.mappingFile) {
    try {
      const mappingPath = path.resolve(options.mappingFile);
      const mappingData = fs.readFileSync(mappingPath, 'utf8');
      const mapping = JSON.parse(mappingData);
      
      logger.info(`Loaded mapping for ${Object.keys(mapping).length} questions`);
      return mapping;
    } catch (error) {
      logger.warn(`Failed to load mapping file: ${error.message}`);
      logger.info('Using default mapping');
    }
  }
  
  return DEFAULT_MAPPING;
}

/**
 * Fix typos in text
 */
function fixTypos(text) {
  if (!text || !options.fixTypos) return text;

  let fixed = validator.fixCommonTypos(text);

  // Specific typo fix: NO RESPOSNE → NO RESPONSE
  if (fixed && fixed.trim() === 'NO RESPOSNE') {
    fixed = 'NO RESPONSE';
  }

  return fixed;
}

/**
 * Normalize category value
 */
function normalizeCategory(category) {
  if (!category || !options.normalize) return category;

  // Trim whitespace
  let normalized = category.trim();

  // Fix case inconsistencies
  const standardCategories = [
    'NO RESPONSE',
    'NEEDS CATEGORIZATION',
    'ERROR',
    'UNCATEGORIZED'
  ];

  const upper = normalized.toUpperCase();
  for (const std of standardCategories) {
    if (upper === std) {
      return std;
    }
  }

  return normalized;
}

/**
 * Process a single row
 */
function processRow(row, mapping, stats, rowIndex) {
  let modified = false;

  for (const [questionCol, categoryCol] of Object.entries(mapping)) {
    // Skip if columns don't exist
    if (!(questionCol in row) || !(categoryCol in row)) {
      continue;
    }

    const originalResponse = row[questionCol];
    const originalCategory = row[categoryCol];

    // Fix specific typo: NO RESPOSNE → NO RESPONSE
    if (originalCategory && originalCategory.trim() === 'NO RESPOSNE') {
      row[categoryCol] = 'NO RESPONSE';
      stats.typoFixes++;

      // Track this specific typo fix
      const key = `${categoryCol}: "NO RESPOSNE" → "NO RESPONSE"`;
      stats.typoFixDetails[key] = (stats.typoFixDetails[key] || 0) + 1;

      logger.debug(`Row ${rowIndex + 2}: Fixed typo in ${categoryCol}: "NO RESPOSNE" → "NO RESPONSE"`);
      modified = true;
    }

    // Fix typos in response
    if (originalResponse) {
      const fixedResponse = fixTypos(originalResponse);
      if (fixedResponse !== originalResponse) {
        row[questionCol] = fixedResponse;
        stats.typosFixed++;
        modified = true;
      }
    }

    // Fix empty response categorization
    if (options.fixEmpty) {
      const response = row[questionCol];
      const category = row[categoryCol];

      // If response is empty but category is not NO RESPONSE
      if (validator.isEmpty(response)) {
        if (category && category.trim() !== '' && category.trim() !== 'NO RESPONSE') {
          const oldValue = category;

          // Track statistics for changes
          const changeKey = `${categoryCol}: "${oldValue}" → "NO RESPONSE"`;
          stats.changeDetails[changeKey] = (stats.changeDetails[changeKey] || 0) + 1;

          // Fix the category
          row[categoryCol] = 'NO RESPONSE';
          stats.emptyResponseFixes++;
          modified = true;

          logger.debug(`Row ${rowIndex + 2}: Fixed ${categoryCol} from "${oldValue}" to "NO RESPONSE"`);
        }
      }
    }

    // Normalize category
    if (row[categoryCol]) {
      const normalizedCategory = normalizeCategory(row[categoryCol]);
      if (normalizedCategory !== row[categoryCol]) {
        row[categoryCol] = normalizedCategory;
        stats.categoriesNormalized++;
        modified = true;
      }
    }
  }

  if (modified) {
    stats.rowsModified++;
  }

  return row;
}

/**
 * Generate statistics report
 */
function generateReport(data, mapping, stats) {
  const report = {
    totalRows: data.length,
    ...stats,
    questions: {},
    columnNoResponseCount: {}
  };

  // Get all category columns
  const categoryColumns = Object.values(mapping);

  // Count NO RESPONSE per column
  categoryColumns.forEach(catCol => {
    if (catCol in data[0]) {
      report.columnNoResponseCount[catCol] = data.filter(
        row => row[catCol] && row[catCol].trim() === 'NO RESPONSE'
      ).length;
    }
  });

  // Analyze each question
  for (const [questionCol, categoryCol] of Object.entries(mapping)) {
    if (!(questionCol in data[0]) || !(categoryCol in data[0])) {
      continue;
    }

    const questionStats = {
      totalResponses: 0,
      emptyResponses: 0,
      categorized: 0,
      needsCategorization: 0,
      noResponse: 0,
      categories: {}
    };

    data.forEach(row => {
      const response = row[questionCol];
      const category = row[categoryCol];

      if (validator.isEmpty(response)) {
        questionStats.emptyResponses++;
      } else {
        questionStats.totalResponses++;
      }

      if (category) {
        if (category === 'NEEDS CATEGORIZATION') {
          questionStats.needsCategorization++;
        } else if (category === 'NO RESPONSE') {
          questionStats.noResponse++;
        } else {
          questionStats.categorized++;
          questionStats.categories[category] = (questionStats.categories[category] || 0) + 1;
        }
      }
    });

    report.questions[questionCol] = questionStats;
  }

  return report;
}

/**
 * Save report to file
 */
function saveReport(report, reportPath) {
  const reportText = `# CSV Filter Report

## Summary
- Total Rows: ${report.totalRows}
- Rows Modified: ${report.rowsModified}
- Typo Fixes (NO RESPOSNE): ${report.typoFixes || 0}
- Response Typos Fixed: ${report.typosFixed || 0}
- Empty Response Fixes: ${report.emptyResponseFixes || 0}
- Categories Normalized: ${report.categoriesNormalized || 0}
- Total Changes: ${(report.typoFixes || 0) + (report.emptyResponseFixes || 0)}

${report.typoFixDetails && Object.keys(report.typoFixDetails).length > 0 ? `
## Typo Fix Details
${Object.entries(report.typoFixDetails).sort((a, b) => b[1] - a[1]).map(([key, count]) => `- ${count}x ${key}`).join('\n')}
` : ''}

${report.changeDetails && Object.keys(report.changeDetails).length > 0 ? `
## Empty Response Fix Details
${Object.entries(report.changeDetails).sort((a, b) => b[1] - a[1]).map(([key, count]) => `- ${count}x ${key}`).join('\n')}
` : ''}

## Column-wise NO RESPONSE Count (After Fixes)
${Object.entries(report.columnNoResponseCount).sort((a, b) => b[1] - a[1]).map(([col, count]) => `- ${col}: ${count}`).join('\n')}

## Question Statistics

${Object.entries(report.questions).map(([question, stats]) => `
### ${question}
- Total Responses: ${stats.totalResponses}
- Empty Responses: ${stats.emptyResponses}
- NO RESPONSE: ${stats.noResponse}
- Categorized: ${stats.categorized}
- Needs Categorization: ${stats.needsCategorization}

${Object.keys(stats.categories).length > 0 ? `Categories Distribution:
${Object.entries(stats.categories).sort((a, b) => b[1] - a[1]).map(([cat, count]) => `- ${cat}: ${count}`).join('\n')}` : ''}
`).join('\n')}
`;

  fs.writeFileSync(reportPath, reportText, 'utf8');
  logger.info(`Report saved to: ${reportPath}`);
}

/**
 * Main execution function
 */
async function main() {
  try {
    logger.section('CSV Filter Script');
    logger.info(`Input: ${config.paths.input}`);
    logger.info(`Output: ${config.paths.output}`);
    logger.info(`Fix Typos: ${options.fixTypos}`);
    logger.info(`Fix Empty: ${options.fixEmpty}`);
    logger.info(`Normalize: ${options.normalize}`);

    // Load question-category mapping
    logger.section('Loading Configuration');
    const mapping = loadMapping();

    // Load input data
    logger.section('Loading Input Data');
    const data = await csvHandler.read(config.paths.input);
    
    if (data.length === 0) {
      throw new Error('No data found in input file');
    }

    // Get available columns
    const availableQuestions = Object.keys(mapping).filter(q => q in data[0]);
    const availableCategories = Object.values(mapping).filter(c => c in data[0]);
    
    logger.info(`Found ${availableQuestions.length} question columns`);
    logger.info(`Found ${availableCategories.length} category columns`);

    // Process rows
    logger.section('Processing Rows');

    const stats = {
      rowsModified: 0,
      typosFixed: 0,
      typoFixes: 0,
      emptyResponseFixes: 0,
      categoriesNormalized: 0,
      typoFixDetails: {},
      changeDetails: {}
    };

    data.forEach((row, index) => {
      processRow(row, mapping, stats, index);

      if ((index + 1) % 100 === 0) {
        logger.progress(index + 1, data.length, `Modified: ${stats.rowsModified}`);
      }
    });

    logger.progress(data.length, data.length, 'Complete');

    // Generate report
    logger.section('Generating Report');
    const report = generateReport(data, mapping, stats);
    
    const reportPath = config.paths.output.replace('.csv', '_report.md');
    saveReport(report, reportPath);

    // Save filtered data
    logger.section('Saving Results');
    await csvHandler.write(config.paths.output, data);

    // Log summary
    logger.section('Summary');
    logger.info('='.repeat(60));
    logger.info(`Total Rows: ${report.totalRows}`);
    logger.info(`Rows Modified: ${stats.rowsModified}`);
    logger.info('');
    logger.info(`Typo Fixes (NO RESPOSNE → NO RESPONSE): ${stats.typoFixes}`);
    logger.info(`Empty Response Fixes: ${stats.emptyResponseFixes}`);
    logger.info(`Categories Normalized: ${stats.categoriesNormalized}`);
    logger.info(`Total Changes: ${stats.typoFixes + stats.emptyResponseFixes}`);

    // Show detailed breakdown if there are changes
    if (Object.keys(stats.changeDetails).length > 0) {
      logger.info('');
      logger.info('-'.repeat(60));
      logger.info('BREAKDOWN OF EMPTY RESPONSE FIXES:');
      logger.info('-'.repeat(60));
      Object.entries(stats.changeDetails)
        .sort((a, b) => b[1] - a[1])
        .forEach(([key, count]) => {
          logger.info(`  ${count}x ${key}`);
        });
    }

    if (Object.keys(stats.typoFixDetails).length > 0) {
      logger.info('');
      logger.info('-'.repeat(60));
      logger.info('TYPO FIX DETAILS:');
      logger.info('-'.repeat(60));
      Object.entries(stats.typoFixDetails)
        .sort((a, b) => b[1] - a[1])
        .forEach(([key, count]) => {
          logger.info(`  ${count}x ${key}`);
        });
    }

    // Show column-wise NO RESPONSE counts
    logger.info('');
    logger.info('-'.repeat(60));
    logger.info('TOTAL "NO RESPONSE" COUNT PER COLUMN (AFTER FIXES):');
    logger.info('-'.repeat(60));
    Object.entries(report.columnNoResponseCount)
      .sort((a, b) => b[1] - a[1])
      .forEach(([column, count]) => {
        logger.info(`  ${column}: ${count}`);
      });

    logger.info('='.repeat(60));
    logger.info('\nCSV filtering complete! ✓');

  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
