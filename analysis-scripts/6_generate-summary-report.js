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
  inputFile: "./input.csv",
  outputJSON: "./reports/summary_analysis.json",
  outputMD: "./reports/summary_report.md",
  
  // Column delimiter overrides (column_name: delimiter)
  columnDelimOverride: {
    q1_category_1: ",",
    // Add more overrides as needed
  },

  // Question definitions with full text
  questions: {
    q1_category_1: {
      shortCode: "Q1a",
      question: "In the last 6 to 12 months, what is one improvement that you have led in your school?",
      subtext: "Primary Category",
      section: "Recent Changes",
    },
    q1_category_2: {
      shortCode: "Q1b",
      question: "In the last 6 to 12 months, what is one improvement that you have led in your school?",
      subtext: "Secondary Category",
      section: "Recent Changes",
    },
    q2_categories: {
      shortCode: "Q2",
      question: "How did you get the idea for this improvement?",
      section: "Change Inspiration",
    },
    q3_category: {
      shortCode: "Q3",
      question: "What did you do to implement this improvement?",
      section: "Implementation Steps",
    },
    q4_categories: {
      shortCode: "Q4",
      question: "What helped you implement this improvement in your school?",
      section: "Enabling Factors",
    },
    q5_category: {
      shortCode: "Q5",
      question: "In the next 3-6 months, do you plan to do anything more for the improvement you led?",
      section: "Plans for Current Improvement",
    },
    q6_categories: {
      shortCode: "Q6",
      question: "What are some challenges you face while implementing improvements in your school?",
      section: "Challenges",
    },
    q7_categories: {
      shortCode: "Q7",
      question: "What are some other improvements you are planning in your school in the next 3-6 months?",
      section: "Planned Changes",
    },
    q8_categories: {
      shortCode: "Q8",
      question: "What support do you need to implement these improvements in your school?",
      section: "Support Needs",
    },
  },
};

const CATEGORY_COLUMNS = Object.keys(SUMMARY_CONFIG.questions);

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

// ==================== AGGREGATION ====================

/** Build unified per-question aggregation */
function buildAggregates(data) {
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
      shortCode: SUMMARY_CONFIG.questions[col].shortCode,
      question: SUMMARY_CONFIG.questions[col].question,
      subtext: SUMMARY_CONFIG.questions[col].subtext || null,
      section: SUMMARY_CONFIG.questions[col].section,
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
function generateMarkdownSingle(results) {
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

  md += `---\n\n`;
  md += `## Report Notes\n\n`;
  md += `- **State column**: Count with percentage of all responses\n`;
  md += `- **District columns**: Count with percentage of that district's responses\n`;
  md += `- Categories are sorted by state-level count (descending)\n`;
  md += `- Generated on: ${m.generatedOn}\n\n`;

  return md;
}

// ==================== MAIN ====================

async function main() {
  try {
    console.log("🚀 Starting Summary Report Generation...\n");
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

    console.log("🔄 Aggregating data (state + districts)...");
    const results = buildAggregates(data);

    // Ensure reports directory exists
    const reportsDir = path.dirname(SUMMARY_CONFIG.outputJSON);
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    console.log("💾 Writing JSON...");
    fs.writeFileSync(
      SUMMARY_CONFIG.outputJSON,
      JSON.stringify(results, null, 2)
    );
    console.log(`✓ Saved: ${SUMMARY_CONFIG.outputJSON}`);

    console.log("📝 Writing Markdown report...");
    const md = generateMarkdownSingle(results);
    fs.writeFileSync(SUMMARY_CONFIG.outputMD, md);
    console.log(`✓ Saved: ${SUMMARY_CONFIG.outputMD}`);

    console.log("\n✅ Summary Report Generation Complete!");
    console.log(`📊 Reports saved to: ${reportsDir}/`);
    console.log(`   - ${path.basename(SUMMARY_CONFIG.outputMD)}`);
    console.log(`   - ${path.basename(SUMMARY_CONFIG.outputJSON)}`);

  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// ==================== ENTRY POINT ====================

if (require.main === module) {
  main();
}

module.exports = { main, SUMMARY_CONFIG, buildAggregates, generateMarkdownSingle };
