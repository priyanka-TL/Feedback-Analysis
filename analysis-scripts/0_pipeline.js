#!/usr/bin/env node

/**
 * Master Pipeline Script
 * 
 * Runs the complete feedback analysis pipeline in sequence:
 * 1. Filter and clean data
 * 2. Improve grammar
 * 3. Categorize responses
 * 
 * Usage:
 *   node pipeline.js [options]
 * 
 * Options:
 *   --input <path>       Input CSV file (required)
 *   --output <path>      Final output CSV file (default: pipeline_output.csv)
 *   --skip-filter        Skip filtering step
 *   --skip-grammar       Skip grammar improvement step
 *   --skip-categorize    Skip categorization step
 *   --keep-intermediate  Keep intermediate files
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  inputFile: null,
  outputFile: 'pipeline_output.csv',
  skipFilter: false,
  skipGrammar: false,
  skipCategorize: false,
  keepIntermediate: false
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--input':
      options.inputFile = args[++i];
      break;
    case '--output':
      options.outputFile = args[++i];
      break;
    case '--skip-filter':
      options.skipFilter = true;
      break;
    case '--skip-grammar':
      options.skipGrammar = true;
      break;
    case '--skip-categorize':
      options.skipCategorize = true;
      break;
    case '--keep-intermediate':
      options.keepIntermediate = true;
      break;
    case '--help':
      console.log(`
Master Pipeline Script - Complete feedback analysis pipeline

Usage:
  node pipeline.js --input <file> [options]

Options:
  --input <path>       Input CSV file (required)
  --output <path>      Final output CSV file (default: pipeline_output.csv)
  --skip-filter        Skip filtering step
  --skip-grammar       Skip grammar improvement step
  --skip-categorize    Skip categorization step
  --keep-intermediate  Keep intermediate files
  --help               Show this help message

Examples:
  node pipeline.js --input raw_data.csv
  node pipeline.js --input data.csv --output final.csv
  node pipeline.js --input data.csv --skip-filter
      `);
      process.exit(0);
  }
}

// Validate input
if (!options.inputFile) {
  console.error('Error: --input parameter is required');
  process.exit(1);
}

if (!fs.existsSync(options.inputFile)) {
  console.error(`Error: Input file not found: ${options.inputFile}`);
  process.exit(1);
}

// Define pipeline steps
const steps = [];

if (!options.skipFilter) {
  steps.push({
    name: 'Filter & Clean',
    script: '4_filter-csv.js',
    input: options.inputFile,
    output: 'pipeline_step1_filtered.csv'
  });
}

if (!options.skipGrammar) {
  steps.push({
    name: 'Grammar Improvement',
    script: '1_improve-grammar.js',
    input: steps.length > 0 ? steps[steps.length - 1].output : options.inputFile,
    output: 'pipeline_step2_improved.csv'
  });
}

if (!options.skipCategorize) {
  steps.push({
    name: 'Categorization',
    script: '3_categorize.js',
    input: steps.length > 0 ? steps[steps.length - 1].output : options.inputFile,
    output: options.outputFile
  });
}

if (steps.length === 0) {
  console.error('Error: All steps are skipped. Nothing to do.');
  process.exit(1);
}

// Update last step output to final output
if (steps.length > 0) {
  steps[steps.length - 1].output = options.outputFile;
}

/**
 * Run a script as a child process
 */
function runScript(script, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: node ${script} ${args.join(' ')}`);
    console.log('='.repeat(60) + '\n');

    const child = spawn('node', [script, ...args], {
      stdio: 'inherit',
      cwd: __dirname
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Script exited with code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Clean up intermediate files
 */
function cleanup() {
  if (options.keepIntermediate) {
    console.log('\nKeeping intermediate files');
    return;
  }

  console.log('\nCleaning up intermediate files...');
  
  const intermediateFiles = [
    'pipeline_step1_filtered.csv',
    'pipeline_step2_improved.csv',
    'pipeline_step1_filtered_report.md',
    'pipeline_step2_improved_report.md'
  ];

  intermediateFiles.forEach(file => {
    if (fs.existsSync(file) && file !== options.outputFile) {
      fs.unlinkSync(file);
      console.log(`  Removed: ${file}`);
    }
  });
}

/**
 * Main execution
 */
async function main() {
  const startTime = Date.now();

  console.log('\n' + '='.repeat(60));
  console.log('FEEDBACK ANALYSIS PIPELINE');
  console.log('='.repeat(60));
  console.log(`Input: ${options.inputFile}`);
  console.log(`Output: ${options.outputFile}`);
  console.log(`Steps: ${steps.map(s => s.name).join(' → ')}`);
  console.log('='.repeat(60));

  try {
    // Run each step
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      console.log(`\n[Step ${i + 1}/${steps.length}] ${step.name}`);
      
      const scriptArgs = [
        '--input', step.input,
        '--output', step.output
      ];

      await runScript(step.script, scriptArgs);
      
      console.log(`\n✓ Step ${i + 1} completed: ${step.output}`);
    }

    // Clean up intermediate files
    cleanup();

    // Final summary
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    console.log('\n' + '='.repeat(60));
    console.log('PIPELINE COMPLETED SUCCESSFULLY ✓');
    console.log('='.repeat(60));
    console.log(`Total Time: ${duration}s`);
    console.log(`Final Output: ${options.outputFile}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('PIPELINE FAILED ✗');
    console.error('='.repeat(60));
    console.error(`Error: ${error.message}`);
    console.error('='.repeat(60) + '\n');
    process.exit(1);
  }
}

// Run the pipeline
main();
