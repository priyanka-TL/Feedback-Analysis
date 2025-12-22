const fs = require("fs");
const Papa = require("papaparse");
const _ = require("lodash");

// Configuration
const INPUT_FILE = "input.csv";
const OUTPUT_JSON = "teacher_feedback_analysis.json";
const OUTPUT_MD = "teacher_feedback_analysis_report.md";

// Column for the boolean summary at the end
const Q2Q4_COL = "Q2-Q4 Related"; // expects TRUE/FALSE (case-insensitive)
const COLUMN_DELIM_OVERRIDE = {
  q1_category_1: ",", // this column uses commas
  // others default to ';'
};
// Question definitions with full text
// const QUESTIONS = {
//   q1_category_1: {
//     shortCode: "Q1a",
//     question:
//       "In the last 6 to 12 months, what is one improvement that you have led in your school? This can be in students, teachers, parents or the school in general",
//     subtext: "Primary Category",
//     section: "Recent Changes",
//   },
//   q1_category_2: {
//     shortCode: "Q1b",
//     question:
//       "In the last 6 to 12 months, what is one improvement that you have led in your school? This can be in students, teachers, parents or the school in general",
//     subtext: "Secondary Category",
//     section: "Recent Changes",
//   },
//   q2_category: {
//     shortCode: "Q2",
//     question:
//       "Can you tell us about one change in your school that is close to you? How did you make it happen?",
//     section: "Personal Change Initiative",
//   },
//   q3_categories: {
//     shortCode: "Q3",
//     question: "How did you get the idea to make this change?",
//     section: "Change Inspiration",
//   },
//   q4_category: {
//     shortCode: "Q4",
//     question: "In the next 3–6 months, what is your plan for this change?",
//     section: "Future Plans",
//   },
//   q5_categories: {
//     shortCode: "Q5",
//     question: "What helped you make this change in your school?",
//     section: "Enabling Factors",
//   },
//   q6_categories: {
//     shortCode: "Q6",
//     question:
//       "What are some challenges you face while making changes in schools?",
//     section: "Challenges",
//   },
//   q7_categories: {
//     shortCode: "Q7",
//     question:
//       "What are some other changes you are planning in your school in next 3-6 months?",
//     section: "Planned Changes",
//   },
//   q8_categories: {
//     shortCode: "Q8",
//     question: "What support do you need to make changes in school?",
//     section: "Support Needs",
//   },
// };

const QUESTIONS = {
  q1_category_1: {
    shortCode: "Q1a",
    question:
      "In the last 6 to 12 months, what is one improvement that you have led in your school? This can be in students, teachers, parents or the school in general",
    subtext: "Primary Category",
    section: "Recent Changes",
  },
  q1_category_2: {
    shortCode: "Q1b",
    question:
      "In the last 6 to 12 months, what is one improvement that you have led in your school? This can be in students, teachers, parents or the school in general",
    subtext: "Secondary Category",
    section: "Recent Changes",
  },
  q2_categories: {
    shortCode: "Q2",
    question:
      "How did you get the idea for this improvement?",
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
    question:
      "What are some challenges you face while implementing improvements in your school?",
    section: "Challenges",
  },
  q7_categories: {
    shortCode: "Q7",
    question:
      "What are some other improvements you are planning in your school in the next 3-6 months?",
    section: "Planned Changes",
  },
  q8_categories: {
    shortCode: "Q8",
    question: "What support do you need to implement these improvements in your school?",
    section: "Support Needs",
  },
};

const CATEGORY_COLUMNS = Object.keys(QUESTIONS);

// split only when not inside parentheses
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

function detectColumnDelimiter(rows, column) {
  if (Object.prototype.hasOwnProperty.call(COLUMN_DELIM_OVERRIDE, column)) {
    return COLUMN_DELIM_OVERRIDE[column];
  }
  // fallback detection: prefer ';' if present anywhere, else ',' if present
  let hasSemi = false,
    hasComma = false;
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
  return null; // no delimiter in this column
}
function parseCategories(value, delimiter) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();

  const noRespSet = new Set([
    "no response",
    "no resposne",
    "no resp",
    "n/a",
    "na",
    "nil",
    "-",
    "—",
    "none",
    "NO RESPONSE",
    "NO RESPOSNE",
  ]);

  if (!raw) return ["No Response"];
  if (noRespSet.has(lower)) return ["No Response"];

  const parts =
    delimiter === ";"
      ? raw.split(/\s*;\s*/)
      : delimiter === ","
      ? smartSplit(raw, ",")
      : [raw];

  // normalize each category
  return parts
    .map((s) =>
      s
        .replace(/\([^)]*\)/g, "") // remove parentheses and content
        .trim()
    )
    .filter(Boolean);
}

// --- update countCategories to pass delimiter ---
function countCategories(rows, column, delimiter) {
  const counts = {};
  rows.forEach((row) => {
    parseCategories(row[column], delimiter).forEach((cat) => {
      counts[cat] = (counts[cat] || 0) + 1;
    });
  });
  return counts;
}

/** Count categories for a given dataset */
function countCategories(rows, column, delimiter) {
  const counts = {};
  rows.forEach((row) => {
    parseCategories(row[column], delimiter).forEach((cat) => {
      counts[cat] = (counts[cat] || 0) + 1;
    });
  });
  return counts;
}

/** Normalize boolean cell for Q2-Q4 Related */
function parseBoolCell(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "0"].includes(s)) return false;
  return null;
}

/** District totals helper */
function computeDistrictTotals(byDistrict) {
  const totals = {};
  Object.keys(byDistrict).forEach((d) => {
    totals[d] = byDistrict[d].length;
  });
  return totals;
}

/** Build unified per-question aggregation: state + per-district matrix with district percentages */
function buildAggregates(data) {
  const byDistrict = _.groupBy(data, (r) => r.District || "Unknown");
  const districts = Object.keys(byDistrict).sort();
  const stateName =
    [...new Set(data.map((r) => r.State).filter(Boolean))][0] || "State";
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

    // Union of all categories appearing anywhere
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
      shortCode: QUESTIONS[col].shortCode,
      question: QUESTIONS[col].question,
      subtext: QUESTIONS[col].subtext || null,
      section: QUESTIONS[col].section,
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
      districts: [
        ...new Set(data.map((r) => r.District).filter(Boolean)),
      ].sort(),
      stateName,
    },
    questions,
    byDistrict,
    districtTotals,
    districts,
    stateName,
  };
}

/** Build district-wise TRUE/FALSE table for Q2-Q4 Related */
// function buildQ2Q4Summary(data) {
//   const byDistrict = _.groupBy(data, (r) => r.District || "Unknown");
//   const districts = Object.keys(byDistrict).sort();
//   const rows = districts.map((d) => {
//     const list = byDistrict[d];
//     let t = 0,
//       f = 0,
//       n = 0;
//     list.forEach((r) => {
//       const val = parseBoolCell(r[Q2Q4_COL]);
//       if (val === true) t += 1;
//       else if (val === false) f += 1;
//       else n += 1; // null/invalid
//     });
//     const total = list.length;
//     const tp = total ? ((t / total) * 100).toFixed(1) : "0.0";
//     const fp = total ? ((f / total) * 100).toFixed(1) : "0.0";
//     const np = total ? ((n / total) * 100).toFixed(1) : "0.0";
//     return {
//       district: d,
//       trueCount: t,
//       truePct: tp,
//       falseCount: f,
//       falsePct: fp,
//       nullCount: n,
//       nullPct: np,
//       total,
//     };
//   });
//   return { districts, rows };
// }

/** Generate single-file markdown with:
 * - per-question table: Category | <State> | <Districts...>
 *   - State cell => "count (state%)"
 *   - District cell => "count (district%)"
 * - final section: Q2-Q4 Related by district
 */
function generateMarkdownSingle(results, q2q4) {
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
    "Enabling Factors",
    "Challenges",
    "Future Plans",
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
        md += `| ${r.category} | ${stateCell} | ${districtCells.join(
          " | "
        )} |\n`;
      });

      if (q.rows.length === 0) {
        const emptyDistricts = q.districts.map(() => "0 (0.0%)");
        md += `| _No categorized responses_ | 0 (0.0%) | ${emptyDistricts.join(
          " | "
        )} |\n`;
      }
      md += `\n`;
    });
  });

  // // Q2-Q4 Related summary
  // md += `---\n\n`;
  // md += `## Q2–Q4 Related: District-wise TRUE/FALSE Summary\n\n`;
  // md += `_Column: "${Q2Q4_COL}" — cells parsed as TRUE/FALSE. Unparseable values counted as "Unknown"._\n\n`;

  // // Table header
  // md += `| District | TRUE | FALSE | Unknown | Total |\n`;
  // md += `|:--|--:|--:|--:|--:|\n`;
  // q2q4.rows.forEach((r) => {
  //   const t = `${r.trueCount} (${r.truePct}%)`;
  //   const f = `${r.falseCount} (${r.falsePct}%)`;
  //   const n = `${r.nullCount} (${r.nullPct}%)`;
  //   md += `| ${r.district} | ${t} | ${f} | ${n} | ${r.total} |\n`;
  // });
  // md += `\n`;

  // // Appendix
  // md += `---\n\n`;
  // md += `## Appendix\n\n`;
  // md += `- State column shows count with percentage of all responses.\n`;
  // md += `- District columns show count with percentage of that district's responses.\n`;
  // md += `- "${Q2Q4_COL}" summary parses common boolean variants: TRUE/FALSE, Yes/No, 1/0.\n\n`;

  return md;
}

/** Main */
async function main() {
  try {
    console.log("Reading CSV...");
    const csv = fs.readFileSync(INPUT_FILE, "utf8");

    console.log("Parsing CSV...");
    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    if (parsed.errors.length)
      console.warn("Parse warnings:", parsed.errors.slice(0, 3));

    const data = parsed.data;
    console.log(`Rows: ${data.length}`);

    console.log("Aggregating (state + districts)...");
    const results = buildAggregates(data);

    // console.log(`Building "${Q2Q4_COL}" district summary...`);
    // const q2q4 = buildQ2Q4Summary(data);
    const q2q4 = {}; // OMIT Q2-Q4 SUMMARY

    console.log("Writing JSON...");
    fs.writeFileSync(
      OUTPUT_JSON,
      JSON.stringify({ ...results, q2q4 }, null, 2)
    );

    console.log("Writing Markdown (single file)...");
    const md = generateMarkdownSingle(results, q2q4);
    fs.writeFileSync(OUTPUT_MD, md);

    console.log("Done.");
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
