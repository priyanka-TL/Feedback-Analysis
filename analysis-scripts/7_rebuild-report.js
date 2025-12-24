#!/usr/bin/env node

/**
 * 7_rebuild-report.js
 * 
 * Rebuilds the district analysis report from existing debug files.
 * No API calls - instant regeneration from previously processed data.
 * 
 * Use this when:
 * - Report file was deleted/corrupted
 * - You want to change report formatting
 * - You want to regenerate without API costs
 * - Recovery from partial processing
 */

const fs = require("fs").promises;
const path = require("path");

// Import utilities
const logger = require("./utils/logger");

// ==================== CONFIGURATION ====================
const REBUILD_CONFIG = {
  progressFile: "./report_progress.json",
  debugDir: "./debug",
  outputFile: "./reports/analysis_report.md",
  
  // Question mappings - must match 5_generate-district-report.js
  questionMappings: {
    "Q1": {
      column: "Q1: In the last 6 to 12 months, what is one improvement that you have led in your school?",
      analysisType: "List of improvements",
      shortName: "Changes in Last 6-12 Months",
    },
    "Q2": {
      column: "Q2: How did you get the idea for this improvement?",
      analysisType: "List of reasons/motivations behind improvements",
      shortName: "Ideas and Motivations",
    },
    "Q3": {
      column: "Q3. What did you do to implement this improvement?",
      analysisType: "Steps taken to implement the improvement",
      shortName: "Implementation Steps",
    },
    "Q4": {
      column: "Q4: What helped you implement this improvement in your school?",
      analysisType: "List of things that helped",
      shortName: "Enabling Factors",
    },
    "Q5": {
      column: "Q5: In the next 3-6 months, do you plan to do anything more for the improvement you led?",
      analysisType: "List of plans for improvements",
      shortName: "Plans for Current Improvement",
    },
    "Q6": {
      column: "Q6: What are some challenges you face while implementing improvements in your school?",
      analysisType: "List of challenges",
      shortName: "Challenges Faced",
    },
    "Q7": {
      column: "Q7: What are some other improvements you are planning in your school in the next 3-6 months?",
      analysisType: "List of planned improvements",
      shortName: "Other New Improvements Planned",
    },
    "Q8": {
      column: "Q8: What support do you need to implement these improvements in your school?",
      analysisType: "List of support required",
      shortName: "Support Needed",
    },
  },
};

// ==================== UTILITY FUNCTIONS ====================

/** Sanitize question short name for filename */
function getSanitizedShortName(shortName) {
  return shortName.replace(/[^a-z0-9]/gi, "_").slice(0, 50);
}

/** Read progress file if exists */
async function readProgress() {
  try {
    const raw = await fs.readFile(REBUILD_CONFIG.progressFile, "utf8");
    const progress = JSON.parse(raw);
    await logger.info("Progress file loaded", {
      file: REBUILD_CONFIG.progressFile,
      districts: progress.stats?.districts,
    });
    return progress;
  } catch (e) {
    await logger.warn("No progress file found, will scan debug folder");
    return null;
  }
}

/** Scan debug folder and collect all analysis files */
async function collectDebugFiles() {
  const districts = {};
  const debugRoot = REBUILD_CONFIG.debugDir;
  
  try {
    const districtDirs = await fs.readdir(debugRoot);
    
    for (const districtName of districtDirs) {
      const districtPath = path.join(debugRoot, districtName);
      const stat = await fs.stat(districtPath);
      
      if (!stat.isDirectory()) continue;
      
      districts[districtName] = {};
      const files = await fs.readdir(districtPath);
      
      for (const filename of files) {
        // Filename pattern: <shortName_sanitized>_batch_<n>.md
        const match = filename.match(/^(.*)_batch_(\d+)\.md$/i);
        if (!match) continue;
        
        const shortSanitized = match[1];
        const batchIndex = parseInt(match[2], 10) - 1; // Convert to 0-based index
        
        // Create key: "sanitizedName::batchIndex"
        const key = `${shortSanitized}::${batchIndex}`;
        districts[districtName][key] = path.join(districtPath, filename);
      }
    }
    
    await logger.info("Debug files collected", {
      districts: Object.keys(districts).length,
      totalFiles: Object.values(districts).reduce((sum, d) => sum + Object.keys(d).length, 0),
    });
    
    return districts;
  } catch (e) {
    await logger.error("Error scanning debug directory", {
      error: e.message,
      debugDir: debugRoot,
    });
    throw new Error(`Cannot access debug directory: ${debugRoot}. Have you run 5_generate-district-report.js first?`);
  }
}

// ==================== REPORT GENERATION ====================

/** Create report header */
function startReportHeader(globalMeta) {
  const lines = [];
  lines.push("# School Improvement Analysis Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Rebuilt From:** Debug files in ${REBUILD_CONFIG.debugDir}/`);
  lines.push(`**Total Districts:** ${globalMeta.totalDistricts}`);
  
  if (globalMeta.totalResponses > 0) {
    lines.push(`**Total Responses:** ${globalMeta.totalResponses}`);
  }
  
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines;
}

/** Format district section */
function appendDistrictSection(lines, district, districtSummary) {
  lines.push(`## District: ${district}`);
  
  if (districtSummary.totalResponses > 0) {
    lines.push(`**Total Responses:** ${districtSummary.totalResponses}`);
  }
  
  lines.push("");

  for (const q of districtSummary.questions) {
    lines.push(`### ${q.shortName}`);
    lines.push(`**Column:** ${q.column}`);
    lines.push(`**Analysis Type:** ${q.analysisType}`);
    
    if (q.totalAnalyzed > 0) {
      lines.push(`**Responses Analyzed:** ${q.totalAnalyzed} ✓`);
    }
    
    if (q.totalBatches > 1) {
      lines.push(`**Batches:** ${q.totalBatches}`);
    }
    
    lines.push("");
    
    // Add analysis content
    if (q.analysis.length > 0) {
      lines.push(q.analysis.join("\n\n"));
    } else {
      lines.push("*No analysis available*");
    }
    
    lines.push("");
    lines.push("---");
    lines.push("");
  }
}

/** Add footer with rebuild info */
function appendFooter(lines, stats) {
  lines.push("## Rebuild Information");
  lines.push("");
  lines.push(`- **Rebuilt on:** ${new Date().toISOString()}`);
  lines.push(`- **Source:** Debug files from ${REBUILD_CONFIG.debugDir}/`);
  lines.push(`- **Districts processed:** ${stats.districtsProcessed}`);
  lines.push(`- **Questions found:** ${stats.questionsFound}`);
  lines.push(`- **Total batches:** ${stats.totalBatches}`);
  lines.push(`- **Missing files:** ${stats.missingFiles}`);
  lines.push("");
  lines.push("_This report was rebuilt from existing analysis files. No new API calls were made._");
  lines.push("");
}

// ==================== MAIN PROCESSING ====================

async function main() {
  console.log("🔄 Starting Report Rebuild...\n");
  
  await logger.init();
  
  // Read progress (optional, for metadata)
  const progress = await readProgress();
  
  // Collect all debug files
  const debugIndex = await collectDebugFiles();
  
  if (Object.keys(debugIndex).length === 0) {
    throw new Error("No debug files found! Run 5_generate-district-report.js first to generate analysis.");
  }
  
  // Build global metadata
  const globalMeta = {
    totalDistricts: progress?.stats?.districts || Object.keys(debugIndex).length,
    totalResponses: progress?.stats?.totalResponses || 0,
  };
  
  const report = startReportHeader(globalMeta);
  
  const stats = {
    districtsProcessed: 0,
    questionsFound: 0,
    totalBatches: 0,
    missingFiles: 0,
  };
  
  // Process each district
  const districts = Object.keys(debugIndex).sort();
  
  for (const district of districts) {
    await logger.info(`📍 Rebuilding district: ${district}`);
    
    const filesIndex = debugIndex[district];
    const districtSummary = {
      totalResponses: 0,
      questions: [],
    };
    
    // Process each question in order
    for (const [questionKey, questionConfig] of Object.entries(REBUILD_CONFIG.questionMappings)) {
      const shortName = questionConfig.shortName;
      const sanitized = getSanitizedShortName(shortName);
      
      // Find all batches for this question
      const batches = Object.entries(filesIndex).filter(([key]) =>
        key.startsWith(sanitized + "::")
      );
      
      if (batches.length === 0) {
        // No files found for this question
        districtSummary.questions.push({
          shortName,
          column: questionConfig.column,
          analysisType: questionConfig.analysisType,
          totalAnalyzed: 0,
          totalBatches: 0,
          analysis: ["*No saved analysis found*"],
        });
        stats.missingFiles++;
        continue;
      }
      
      // Sort batches by index
      batches.sort((a, b) => {
        const aIndex = parseInt(a[0].split("::")[1], 10);
        const bIndex = parseInt(b[0].split("::")[1], 10);
        return aIndex - bIndex;
      });
      
      const analyses = [];
      let totalAnalyzed = 0;
      
      // Read each batch file
      for (const [key, filePath] of batches) {
        try {
          const text = await fs.readFile(filePath, "utf8");
          analyses.push(text);
          
          // Try to extract response count from text
          const match = text.match(/Processed:\s*(\d+)/i);
          if (match) {
            totalAnalyzed += parseInt(match[1], 10);
          }
          
          stats.totalBatches++;
        } catch (e) {
          await logger.error(`Error reading file: ${filePath}`, { error: e.message });
          analyses.push(`*Error reading batch file: ${e.message}*`);
        }
      }
      
      districtSummary.questions.push({
        shortName,
        column: questionConfig.column,
        analysisType: questionConfig.analysisType,
        totalAnalyzed,
        totalBatches: batches.length,
        analysis: analyses,
      });
      
      districtSummary.totalResponses += totalAnalyzed;
      stats.questionsFound++;
    }
    
    appendDistrictSection(report, district, districtSummary);
    stats.districtsProcessed++;
  }
  
  // Add footer
  appendFooter(report, stats);
  
  // Write final report
  await fs.mkdir(path.dirname(REBUILD_CONFIG.outputFile), { recursive: true });
  await fs.writeFile(REBUILD_CONFIG.outputFile, report.join("\n"));
  
  console.log("\n✅ Report Rebuild Complete!");
  console.log(`📊 Report saved to: ${REBUILD_CONFIG.outputFile}`);
  console.log(`\n📈 Statistics:`);
  console.log(`   - Districts: ${stats.districtsProcessed}`);
  console.log(`   - Questions: ${stats.questionsFound}`);
  console.log(`   - Batches: ${stats.totalBatches}`);
  
  if (stats.missingFiles > 0) {
    console.log(`   ⚠️  Missing files: ${stats.missingFiles}`);
  }
  
  await logger.info("=== Report Rebuild Complete ===", stats);
}

// ==================== ENTRY POINT ====================

if (require.main === module) {
  main().catch(async (e) => {
    await logger.error("💥 Fatal error during rebuild", {
      message: e.message,
      stack: e.stack,
    });
    console.error("\n❌ Error:", e.message);
    console.error("\n💡 Tip: Make sure you've run 5_generate-district-report.js first to create debug files.");
    process.exit(1);
  });
}

module.exports = { main, REBUILD_CONFIG };
