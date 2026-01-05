#!/usr/bin/env node

/**
 * 6_generate-summary-report.js
 * 
 * Generates state and district summary reports in table format.
 * Creates comprehensive Markdown reports with category counts and percentages.
 * 
 * Output:
 * - reports/summary_report.md (state + district tables)
 * - reports/summary_analysis.json (JSON data)
 */

const fs = require("fs");
const Papa = require("papaparse");
const _ = require("lodash");
const path = require("path");

// ==================== CONFIGURATION ====================
const SUMMARY_CONFIG = {
  // Input/Output files
  // inputFile: "./input.csv",
  inputFile: "Final_Report/singleQ_output.csv",
  outputJSON: "Final_Report/summary_analysisQ.json",
  outputMD: "Final_Report/summary_reportQ.md",

  // Questions configuration file (REQUIRED)
  // This file defines all questions, categories, and sections
  // Update this file when questions change - DO NOT hardcode questions in this script
  // questionsConfigFile: "./questions-config.json",
  questionsConfigFile: './questions-config-single.json',

  // Column delimiter overrides (column_name: delimiter)
  // By default, the script auto-detects delimiters (';' or ',')
  // Use this to force specific delimiters for certain columns
  columnDelimOverride: {
    q1_category_1: ",",  // Force comma delimiter for this column
    // Add more overrides as needed
  },

  // Optional: Column for boolean summary (set to null if not needed)
  // This tracks TRUE/FALSE responses for a specific CSV column
  // Example: "Q2-Q4 Related" to track responses related to questions 2-4
  booleanSummaryColumn: "Q1-Q5 Related",

  // Q1-Q5 Correlation Configuration
  // Track correlation between Q1 (improvements led) and Q5 (plans for those improvements)
  // Set to false to disable Q1-Q5 correlation matrix analysis
  enableQ1Q5Correlation: false,
  q1Q5CorrelationConfig: {
    q1Column: "q1_category_1",  // Primary category from Q1
    q5Column: "q5_category",    // Plan category from Q5
    title: "Q1–Q5 Correlation: Improvement Plans",
    description: "Analyzes whether teachers have plans for the improvements they led (Q1) in the next 3–6 months (Q5)",
    q1Label: "Q1: Improvement Led",
    q5Label: "Q5: Future Plan",
  },
};

let CATEGORY_COLUMNS = [];

// ==================== CONFIG LOADER ====================

/**
 * Load questions configuration from JSON file
 * Maps questions-config.json format to summary report format
 */
function loadQuestionsConfig() {
  const configPath = SUMMARY_CONFIG.questionsConfigFile;

  if (!fs.existsSync(configPath)) {
    console.error(`\n❌ ERROR: Questions config file not found!`);
    console.error(`   Expected location: ${configPath}`);
    console.error(`\n   To fix this:`);
    console.error(`   1. Make sure ${configPath} exists`);
    console.error(`   2. Or update SUMMARY_CONFIG.questionsConfigFile in the script\n`);
    throw new Error(`Required questions config file not found: ${configPath}`);
  }

  try {
    const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));

    if (!configData.questions || !Array.isArray(configData.questions)) {
      throw new Error("Invalid config format: 'questions' array not found");
    }

    const questions = {};

    configData.questions.forEach((q) => {
      // Map response fields to column names
      q.response_fields.forEach((field) => {
        if (field.name === "reasoning") return; // Skip reasoning field

        const columnName = `${q.id}_${field.name}`;
        const shortCode = q.id.toUpperCase();

        questions[columnName] = {
          shortCode: field.type === "enum" || field.allow_multiple_categories === false
            ? shortCode
            : `${shortCode} (${field.name})`,
          question: q.question_text,
          subtext: field.subtext || field.description || null,
          section: q.section || determineSectionFromQuestion(q.question_text),
        };
      });
    });

    if (Object.keys(questions).length === 0) {
      throw new Error("No valid questions found in config file");
    }

    return questions;
  } catch (err) {
    console.error(`\n❌ ERROR: Failed to load questions config!`);
    console.error(`   File: ${configPath}`);
    console.error(`   Error: ${err.message}\n`);
    throw err;
  }
}

/**
 * Determine section name from question text
 */
function determineSectionFromQuestion(questionText) {
  const lower = questionText.toLowerCase();

  if (lower.includes("improvement") && lower.includes("led")) return "Recent Changes";
  if (lower.includes("how did you get the idea")) return "Change Inspiration";
  if (lower.includes("what did you do")) return "Implementation Steps";
  if (lower.includes("what helped")) return "Enabling Factors";
  if (lower.includes("plan to do anything more")) return "Plans for Current Improvement";
  if (lower.includes("challenges")) return "Challenges";
  if (lower.includes("planning") && lower.includes("next")) return "Planned Changes";
  if (lower.includes("support do you need")) return "Support Needs";

  return "Other";
}

// ==================== UTILITY FUNCTIONS ====================

/** Smart split - split only when not inside parentheses */
function smartSplit(str, delim) {
  if (!delim) return [str];
  const out = [];
  let buf = "",
    depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    if (ch === delim && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length) out.push(buf.trim());
  return out;
}

/** Detect column delimiter */
function detectColumnDelimiter(rows, column) {
  if (Object.prototype.hasOwnProperty.call(SUMMARY_CONFIG.columnDelimOverride, column)) {
    return SUMMARY_CONFIG.columnDelimOverride[column];
  }
  
  let hasSemi = false, hasComma = false;
  for (const r of rows) {
    const v = r[column];
    if (!v || !String(v).trim()) continue;
    const s = String(v);
    if (s.includes(";")) {
      hasSemi = true;
      break;
    }
    if (s.includes(",")) hasComma = true;
  }
  if (hasSemi) return ";";
  if (hasComma) return ",";
  return null;
}

/** Parse categories from cell value */
function parseCategories(value, delimiter) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();

  const noRespSet = new Set([
    "no response", "no resposne", "no resp", "n/a", "na", "nil", "-", "—", 
    "none", "NO RESPONSE", "NO RESPOSNE",
  ]);

  if (!raw) return ["No Response"];
  if (noRespSet.has(lower)) return ["No Response"];

  const parts =
    delimiter === ";"
      ? raw.split(/\s*;\s*/)
      : delimiter === ","
      ? smartSplit(raw, ",")
      : [raw];

  return parts
    .map((s) =>
      s
        .replace(/\([^)]*\)/g, "") // remove parentheses content
        .trim()
    )
    .filter(Boolean);
}

/** Count categories for a dataset */
function countCategories(rows, column, delimiter) {
  const counts = {};
  rows.forEach((row) => {
    parseCategories(row[column], delimiter).forEach((cat) => {
      counts[cat] = (counts[cat] || 0) + 1;
    });
  });
  return counts;
}

/** Compute district totals */
function computeDistrictTotals(byDistrict) {
  const totals = {};
  Object.keys(byDistrict).forEach((d) => {
    totals[d] = byDistrict[d].length;
  });
  return totals;
}

/** Normalize boolean cell for boolean summary columns */
function parseBoolCell(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "0"].includes(s)) return false;
  return null;
}

/** Build district-wise TRUE/FALSE table for boolean summary column */
function buildBooleanSummary(data, columnName) {
  if (!columnName || !data.length) return null;

  const byDistrict = _.groupBy(data, (r) => r.District || "Unknown");
  const districts = Object.keys(byDistrict).sort();

  const rows = districts.map((d) => {
    const list = byDistrict[d];
    let t = 0, f = 0, n = 0;

    list.forEach((r) => {
      const val = parseBoolCell(r[columnName]);
      if (val === true) t += 1;
      else if (val === false) f += 1;
      else n += 1;
    });

    const total = list.length;
    const tp = total ? ((t / total) * 100).toFixed(1) : "0.0";
    const fp = total ? ((f / total) * 100).toFixed(1) : "0.0";
    const np = total ? ((n / total) * 100).toFixed(1) : "0.0";

    return {
      district: d,
      trueCount: t,
      truePct: tp,
      falseCount: f,
      falsePct: fp,
      nullCount: n,
      nullPct: np,
      total,
    };
  });

  return { columnName, districts, rows };
}

/** Build Q1-Q5 correlation matrix: District-wise breakdown of Q5 plans per Q1 improvement category */
function buildQ1Q5Correlation(data) {
  if (!SUMMARY_CONFIG.enableQ1Q5Correlation) return null;

  const config = SUMMARY_CONFIG.q1Q5CorrelationConfig;
  const q1Col = config.q1Column;
  const q5Col = config.q5Column;

  if (!data.length) return null;

  const byDistrict = _.groupBy(data, (r) => r.District || "Unknown");
  const districts = Object.keys(byDistrict).sort();
  const stateName = [...new Set(data.map((r) => r.State).filter(Boolean))][0] || "State";

  // Detect delimiters
  const q1Delim = detectColumnDelimiter(data, q1Col);
  const q5Delim = detectColumnDelimiter(data, q5Col);

  // Get all Q1 categories across all data
  const allQ1Categories = new Set();
  data.forEach((row) => {
    parseCategories(row[q1Col], q1Delim).forEach((cat) => {
      if (cat !== "No Response" && cat !== "ERROR") {
        allQ1Categories.add(cat);
      }
    });
  });

  // Get all Q5 categories
  const allQ5Categories = new Set();
  data.forEach((row) => {
    const q5Val = String(row[q5Col] || "").trim();
    if (q5Val && q5Val !== "No Response" && q5Val !== "ERROR") {
      allQ5Categories.add(q5Val);
    }
  });

  const sortedQ1Cats = [...allQ1Categories].sort();
  const sortedQ5Cats = [...allQ5Categories].sort();

  // Build state-level correlation matrix
  const stateMatrix = {};
  sortedQ1Cats.forEach((q1Cat) => {
    stateMatrix[q1Cat] = {};
    sortedQ5Cats.forEach((q5Cat) => {
      stateMatrix[q1Cat][q5Cat] = 0;
    });
  });

  // Count state-level correlations
  data.forEach((row) => {
    const q1Cats = parseCategories(row[q1Col], q1Delim).filter(
      (c) => c !== "No Response" && c !== "ERROR"
    );
    const q5Val = String(row[q5Col] || "").trim();

    if (q5Val && q5Val !== "No Response" && q5Val !== "ERROR") {
      q1Cats.forEach((q1Cat) => {
        if (stateMatrix[q1Cat] && stateMatrix[q1Cat][q5Val] !== undefined) {
          stateMatrix[q1Cat][q5Val]++;
        }
      });
    }
  });

  // Build district-level correlation matrices
  const districtMatrices = {};
  districts.forEach((district) => {
    const districtData = byDistrict[district];
    const matrix = {};

    sortedQ1Cats.forEach((q1Cat) => {
      matrix[q1Cat] = {};
      sortedQ5Cats.forEach((q5Cat) => {
        matrix[q1Cat][q5Cat] = 0;
      });
    });

    districtData.forEach((row) => {
      const q1Cats = parseCategories(row[q1Col], q1Delim).filter(
        (c) => c !== "No Response" && c !== "ERROR"
      );
      const q5Val = String(row[q5Col] || "").trim();

      if (q5Val && q5Val !== "No Response" && q5Val !== "ERROR") {
        q1Cats.forEach((q1Cat) => {
          if (matrix[q1Cat] && matrix[q1Cat][q5Val] !== undefined) {
            matrix[q1Cat][q5Val]++;
          }
        });
      }
    });

    districtMatrices[district] = matrix;
  });

  return {
    title: config.title,
    description: config.description,
    q1Label: config.q1Label,
    q5Label: config.q5Label,
    stateName,
    districts,
    q1Categories: sortedQ1Cats,
    q5Categories: sortedQ5Cats,
    stateMatrix,
    districtMatrices,
    totalRecords: data.length,
  };
}

// ==================== AGGREGATION ====================

/** Build unified per-question aggregation */
function buildAggregates(data, questionsConfig) {
  const byDistrict = _.groupBy(data, (r) => r.District || "Unknown");
  const districts = Object.keys(byDistrict).sort();
  const stateName = [...new Set(data.map((r) => r.State).filter(Boolean))][0] || "State";
  const totalResponses = data.length;
  const districtTotals = computeDistrictTotals(byDistrict);

  const columnDelimiter = {};
  CATEGORY_COLUMNS.forEach((col) => {
    columnDelimiter[col] = detectColumnDelimiter(data, col);
  });

  const questions = {};

  CATEGORY_COLUMNS.forEach((col) => {
    const delim = columnDelimiter[col];
    const totalCounts = countCategories(data, col, delim);
    const perDistrictCounts = {};
    
    districts.forEach((d) => {
      perDistrictCounts[d] = countCategories(byDistrict[d], col, delim);
    });

    // Union of all categories
    const allCats = new Set(Object.keys(totalCounts));
    districts.forEach((d) =>
      Object.keys(perDistrictCounts[d]).forEach((c) => allCats.add(c))
    );

    // Sort by state total desc, then name
    const sortedCats = [...allCats].sort((a, b) => {
      const da = totalCounts[a] || 0;
      const db = totalCounts[b] || 0;
      if (db !== da) return db - da;
      return a.localeCompare(b);
    });

    const rows = sortedCats.map((category) => {
      const stateCount = totalCounts[category] || 0;
      const statePct = totalResponses
        ? ((stateCount / totalResponses) * 100).toFixed(1)
        : "0.0";

      const districtCells = districts.map((d) => {
        const c = perDistrictCounts[d][category] || 0;
        const denom = districtTotals[d] || 0;
        const pct = denom ? ((c / denom) * 100).toFixed(1) : "0.0";
        return { count: c, pct };
      });

      return { category, stateCount, statePct, districtCells };
    });

    questions[col] = {
      shortCode: questionsConfig[col].shortCode,
      question: questionsConfig[col].question,
      subtext: questionsConfig[col].subtext || null,
      section: questionsConfig[col].section,
      totalResponses,
      districts,
      districtTotals,
      stateName,
      rows,
    };
  });

  return {
    metadata: {
      title: "Teacher Feedback Analysis: School Change Initiative",
      subtitle: "State and District Summary in One View",
      generatedOn: new Date().toISOString(),
      generatedDate: new Date().toLocaleDateString("en-IN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      totalRecords: totalResponses,
      totalDistricts: new Set(data.map((r) => r.District).filter(Boolean)).size,
      districts: [...new Set(data.map((r) => r.District).filter(Boolean))].sort(),
      stateName,
    },
    questions,
    byDistrict,
    districtTotals,
    districts,
    stateName,
  };
}

// ==================== MARKDOWN GENERATION ====================

/** Generate single-file markdown with state + district tables */
function generateMarkdownSingle(results, booleanSummary = null, q1q5Correlation = null) {
  const m = results.metadata;

  let md = "";
  md += `# ${m.title}\n\n`;
  md += `## ${m.subtitle}\n\n`;
  md += `**Report Date:** ${m.generatedDate}\n\n`;
  md += `**Coverage:** ${m.totalDistricts} Districts | ${m.totalRecords} Teacher Responses\n\n`;
  md += `**Districts:** ${m.districts.join(", ")}\n\n`;
  md += `---\n\n`;

  // Section ordering
  const sectionOrder = [
    "Recent Changes",
    "Personal Change Initiative",
    "Change Inspiration",
    "Implementation Steps",
    "Enabling Factors",
    "Plans for Current Improvement",
    "Challenges",
    "Planned Changes",
    "Support Needs",
    "Other",
  ];

  // Group questions by section
  const bySection = {};
  Object.entries(results.questions).forEach(([key, q]) => {
    if (!bySection[q.section]) bySection[q.section] = [];
    bySection[q.section].push({ key, ...q });
  });

  sectionOrder.forEach((section) => {
    if (!bySection[section]) return;
    md += `## ${section}\n\n`;

    bySection[section].forEach((q) => {
      md += `**${q.shortCode}: ${q.question}**`;
      if (q.subtext) md += ` _(${q.subtext})_`;
      md += `\n\n`;

      const header = ["Category", q.stateName, ...q.districts];
      const align = [":-", ":-:", ...q.districts.map(() => ":-:")];

      md += `| ${header.join(" | ")} |\n`;
      md += `| ${align.join(" | ")} |\n`;

      q.rows.forEach((r) => {
        const stateCell = `${r.stateCount} (${r.statePct}%)`;
        const districtCells = r.districtCells.map(
          (cell) => `${cell.count} (${cell.pct}%)`
        );
        md += `| ${r.category} | ${stateCell} | ${districtCells.join(" | ")} |\n`;
      });

      if (q.rows.length === 0) {
        const emptyDistricts = q.districts.map(() => "0 (0.0%)");
        md += `| _No categorized responses_ | 0 (0.0%) | ${emptyDistricts.join(" | ")} |\n`;
      }
      md += `\n`;
    });
  });

  // Q1-Q5 Correlation section (if provided)
  if (q1q5Correlation) {
    md += `---\n\n`;
    md += `## ${q1q5Correlation.title}\n\n`;
    md += `_${q1q5Correlation.description}_\n\n`;

    const stateHeader = [q1q5Correlation.q1Label, ...q1q5Correlation.q5Categories, "Total"];
    const stateAlign = [":-", ...q1q5Correlation.q5Categories.map(() => ":-:"), ":-:"];

    md += `| ${stateHeader.join(" | ")} |\n`;
    md += `| ${stateAlign.join(" | ")} |\n`;

    q1q5Correlation.q1Categories.forEach((q1Cat) => {
      const row = [q1Cat];
      let rowTotal = 0;

      q1q5Correlation.q5Categories.forEach((q5Cat) => {
        const count = q1q5Correlation.stateMatrix[q1Cat][q5Cat] || 0;
        row.push(count);
        rowTotal += count;
      });

      row.push(rowTotal);
      md += `| ${row.join(" | ")} |\n`;
    });

    md += `\n`;
  }

  // Boolean summary section (if provided)
  if (booleanSummary && booleanSummary.rows.length > 0) {
    md += `---\n\n`;
    md += `## ${booleanSummary.columnName}: Summary\n\n`;
    md += `_Column: "${booleanSummary.columnName}" — cells parsed as TRUE/FALSE. Unparseable values counted as "Unknown"._\n\n`;

    // State-wise Summary
    md += `### State-wise Summary\n\n`;
    
    let stateTrueCount = 0, stateFalseCount = 0, stateNullCount = 0, stateTotal = 0;
    booleanSummary.rows.forEach((r) => {
      stateTrueCount += r.trueCount;
      stateFalseCount += r.falseCount;
      stateNullCount += r.nullCount;
      stateTotal += r.total;
    });

    const stateTruePct = stateTotal ? ((stateTrueCount / stateTotal) * 100).toFixed(1) : "0.0";
    const stateFalsePct = stateTotal ? ((stateFalseCount / stateTotal) * 100).toFixed(1) : "0.0";
    const stateNullPct = stateTotal ? ((stateNullCount / stateTotal) * 100).toFixed(1) : "0.0";

    md += `| TRUE | FALSE | Unknown | Total |\n`;
    md += `|--:|--:|--:|--:|\n`;
    md += `| ${stateTrueCount} (${stateTruePct}%) | ${stateFalseCount} (${stateFalsePct}%) | ${stateNullCount} (${stateNullPct}%) | ${stateTotal} |\n\n`;

    // District-wise Summary
    md += `### District-wise TRUE/FALSE Summary\n\n`;

    md += `| District | TRUE | FALSE | Unknown | Total |\n`;
    md += `|:--|--:|--:|--:|--:|\n`;

    booleanSummary.rows.forEach((r) => {
      const t = `${r.trueCount} (${r.truePct}%)`;
      const f = `${r.falseCount} (${r.falsePct}%)`;
      const n = `${r.nullCount} (${r.nullPct}%)`;
      md += `| ${r.district} | ${t} | ${f} | ${n} | ${r.total} |\n`;
    });

    md += `\n`;
  }

  md += `---\n\n`;
  md += `## Appendix\n\n`;
  md += `- State column shows count with percentage of all responses.\n`;
  md += `- District columns show count with percentage of that district's responses.\n`;
  md += `- Categories are sorted by state-level count (descending).\n`;
  if (q1q5Correlation) {
    md += `- Q1-Q5 Correlation shows cross-tabulation: rows are Q1 improvement categories, columns are Q5 plan categories.\n`;
  }
  if (booleanSummary) {
    md += `- "${booleanSummary.columnName}" summary shows state-level aggregation followed by district-wise breakdown.\n`;
    md += `- Boolean values parsed: TRUE/FALSE, Yes/No, 1/0.\n`;
  }
  md += `\n`;

  return md;
}

// ==================== EXECUTION TRACKING ====================

/**
 * Log execution metrics to cost.log file
 */
function logExecutionMetrics(metrics) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    script: "6_generate-summary-report.js",
    ...metrics
  };

  const logLine = JSON.stringify(logEntry) + '\n';
  const logPath = path.join(__dirname, 'cost.log');

  try {
    fs.appendFileSync(logPath, logLine);
  } catch (error) {
    console.warn(`⚠️  Failed to write to cost.log: ${error.message}`);
  }
}

// ==================== MAIN ====================

async function main() {
  const startTime = Date.now();
  let executionMetrics = {
    status: 'started',
    inputFile: SUMMARY_CONFIG.inputFile,
    outputFiles: [SUMMARY_CONFIG.outputJSON, SUMMARY_CONFIG.outputMD]
  };

  try {
    console.log("🚀 Starting Summary Report Generation...\n");

    // Load questions configuration
    console.log("⚙️  Loading questions configuration...");
    console.log(`   Config file: ${SUMMARY_CONFIG.questionsConfigFile}`);
    const questionsConfig = loadQuestionsConfig();
    CATEGORY_COLUMNS = Object.keys(questionsConfig);
    console.log(`✓ Loaded ${CATEGORY_COLUMNS.length} question columns`);
    console.log(`   Questions: ${Object.values(questionsConfig).map(q => q.shortCode).join(", ")}\n`);

    executionMetrics.questionsCount = CATEGORY_COLUMNS.length;

    console.log("📖 Reading CSV...");
    const csv = fs.readFileSync(SUMMARY_CONFIG.inputFile, "utf8");

    console.log("📊 Parsing CSV...");
    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });

    if (parsed.errors.length) {
      console.warn("⚠️  Parse warnings:", parsed.errors.slice(0, 3));
    }

    const data = parsed.data;
    console.log(`✓ Loaded ${data.length} rows\n`);

    executionMetrics.totalRows = data.length;
    executionMetrics.totalDistricts = new Set(data.map(r => r.District).filter(Boolean)).size;

    console.log("🔄 Aggregating data (state + districts)...");
    const results = buildAggregates(data, questionsConfig);

    // Build boolean summary if configured
    let booleanSummary = null;
    if (SUMMARY_CONFIG.booleanSummaryColumn) {
      console.log(`📊 Building boolean summary for "${SUMMARY_CONFIG.booleanSummaryColumn}"...`);
      booleanSummary = buildBooleanSummary(data, SUMMARY_CONFIG.booleanSummaryColumn);
      executionMetrics.booleanSummaryColumn = SUMMARY_CONFIG.booleanSummaryColumn;
    }

    // Build Q1-Q5 correlation if enabled
    let q1q5Correlation = null;
    if (SUMMARY_CONFIG.enableQ1Q5Correlation) {
      console.log("🔗 Building Q1-Q5 correlation matrix...");
      q1q5Correlation = buildQ1Q5Correlation(data);
      if (q1q5Correlation) {
        console.log(`✓ Generated correlation for ${q1q5Correlation.q1Categories.length} Q1 categories × ${q1q5Correlation.q5Categories.length} Q5 categories`);
        executionMetrics.correlationEnabled = true;
        executionMetrics.correlationCategories = {
          q1: q1q5Correlation.q1Categories.length,
          q5: q1q5Correlation.q5Categories.length
        };
      }
    }

    // Ensure reports directory exists
    const reportsDir = path.dirname(SUMMARY_CONFIG.outputJSON);
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    console.log("💾 Writing JSON...");
    const outputData = {
      ...results,
      ...(booleanSummary && { booleanSummary }),
      ...(q1q5Correlation && { q1q5Correlation }),
    };

    fs.writeFileSync(
      SUMMARY_CONFIG.outputJSON,
      JSON.stringify(outputData, null, 2)
    );
    console.log(`✓ Saved: ${SUMMARY_CONFIG.outputJSON}`);

    const jsonSize = fs.statSync(SUMMARY_CONFIG.outputJSON).size;
    executionMetrics.outputJsonSize = `${(jsonSize / 1024).toFixed(2)} KB`;

    console.log("📝 Writing Markdown report...");
    const md = generateMarkdownSingle(results, booleanSummary, q1q5Correlation);
    fs.writeFileSync(SUMMARY_CONFIG.outputMD, md);
    console.log(`✓ Saved: ${SUMMARY_CONFIG.outputMD}`);

    const mdSize = fs.statSync(SUMMARY_CONFIG.outputMD).size;
    executionMetrics.outputMdSize = `${(mdSize / 1024).toFixed(2)} KB`;

    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    executionMetrics.status = 'success';
    executionMetrics.executionTimeSeconds = parseFloat(executionTime);
    executionMetrics.tokensUsed = 0; // No API calls in this script
    executionMetrics.estimatedCost = 0; // No cost
    executionMetrics.apiCalls = 0;

    // Log execution metrics
    logExecutionMetrics(executionMetrics);

    console.log("\n✅ Summary Report Generation Complete!");
    console.log(`📊 Reports saved to: ${reportsDir}/`);
    console.log(`   - ${path.basename(SUMMARY_CONFIG.outputMD)} (${executionMetrics.outputMdSize})`);
    console.log(`   - ${path.basename(SUMMARY_CONFIG.outputJSON)} (${executionMetrics.outputJsonSize})`);
    console.log(`⏱️  Execution time: ${executionTime}s`);
    console.log(`💾 Metrics logged to: cost.log`);

  } catch (err) {
    const endTime = Date.now();
    const executionTime = ((endTime - startTime) / 1000).toFixed(2);

    executionMetrics.status = 'error';
    executionMetrics.error = err.message;
    executionMetrics.executionTimeSeconds = parseFloat(executionTime);

    // Log error metrics
    logExecutionMetrics(executionMetrics);

    console.error("❌ Error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// ==================== ENTRY POINT ====================

if (require.main === module) {
  main();
}

module.exports = {
  main,
  SUMMARY_CONFIG,
  buildAggregates,
  generateMarkdownSingle,
  loadQuestionsConfig,
  buildQ1Q5Correlation,
};
