// rebuild_report.js
const fs = require("fs").promises;
const path = require("path");
const { CONFIG } = require("./script"); // assumes process.js exports CONFIG
const logger = console;

async function readProgress() {
  try {
    const raw = await fs.readFile(CONFIG.progressFile, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function collectDebugFiles() {
  const districts = {};
  const debugRoot = CONFIG.debugDir;
  try {
    const districtDirs = await fs.readdir(debugRoot);
    for (const d of districtDirs) {
      const fullD = path.join(debugRoot, d);
      const stat = await fs.stat(fullD);
      if (!stat.isDirectory()) continue;
      districts[d] = {};
      const files = await fs.readdir(fullD);
      for (const f of files) {
        // try to map filename back to question short name and batch
        // filename pattern: <shortName_sanitized>_batch_<n>.md
        const m = f.match(/^(.*)_batch_(\d+)\.md$/i);
        if (!m) continue;
        const shortSanitized = m[1];
        const batchIndex = parseInt(m[2], 10) - 1;
        districts[d][`${shortSanitized}::${batchIndex}`] = path.join(fullD, f);
      }
    }
  } catch (e) {
    logger.error("No debug directory found or empty", e.message);
  }
  return districts;
}

function getSanitizedShortName(shortName) {
  return shortName.replace(/[^a-z0-9]/gi, "_").slice(0, 50);
}

function startReportHeader(globalMeta) {
  const lines = [];
  lines.push("# School Improvement Analysis Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total Districts: ${globalMeta.totalDistricts}`);
  lines.push(`Total Responses: ${globalMeta.totalResponses}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines;
}

function appendDistrictSection(lines, district, districtSummary) {
  lines.push(`## District: ${district}`);
  lines.push(`**Total Responses:** ${districtSummary.totalResponses}`);
  lines.push("");
  for (const q of districtSummary.questions) {
    lines.push(`### ${q.shortName}`);
    lines.push(`**Column:** ${q.column}`);
    lines.push(`**Analysis Type:** ${q.analysisType}`);
    lines.push(`**Responses Analyzed:** ${q.totalAnalyzed} ✓`);
    if (q.totalBatches > 1) {
      lines.push(`**Batches:** ${q.totalBatches}`);
    }
    lines.push("");
    lines.push(q.analysis.join("\n\n"));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
}

(async function main() {
  const rows = []; // not reading CSV here; we'll use progress + debug
  const progress = await readProgress();
  const debugIndex = await collectDebugFiles();

  // build globalMeta from progress if available
  const globalMeta = {
    totalDistricts: progress
      ? progress.stats.districts
      : Object.keys(debugIndex).length,
    totalResponses: progress ? progress.stats.totalResponses || 0 : 0,
  };

  const report = startReportHeader(globalMeta);

  // For each district folder found
  for (const district of Object.keys(debugIndex)) {
    const filesIndex = debugIndex[district];
    const districtSummary = {
      totalResponses: 0,
      questions: [],
    };

    // iterate question mappings in same order as CONFIG
    for (const [questionText, questionConfig] of Object.entries(
      CONFIG.questionMappings
    )) {
      const short = questionConfig.shortName;
      const sanitized = getSanitizedShortName(short);
      // find all batches for this ques
      const batches = Object.entries(filesIndex).filter(([k]) =>
        k.startsWith(sanitized + "::")
      );
      if (!batches.length) {
        // push placeholder
        districtSummary.questions.push({
          shortName: short,
          column: questionConfig.column,
          analysisType: questionConfig.analysisType,
          totalAnalyzed: 0,
          totalBatches: 0,
          analysis: ["*No saved analysis found*"],
        });
        continue;
      }

      // sort by batch index
      batches.sort((a, b) => {
        const ai = parseInt(a[0].split("::")[1], 10);
        const bi = parseInt(b[0].split("::")[1], 10);
        return ai - bi;
      });

      const analyses = [];
      let totalAnalyzed = 0;
      for (const [, filePath] of batches) {
        try {
          const text = await fs.readFile(filePath, "utf8");
          analyses.push(text);
          const m = text.match(/Processed:\s*(\d+)/i);
          if (m) totalAnalyzed += parseInt(m[1], 10);
        } catch (e) {
          analyses.push(`*Error reading ${filePath}: ${e.message}*`);
        }
      }

      districtSummary.questions.push({
        shortName: short,
        column: questionConfig.column,
        analysisType: questionConfig.analysisType,
        totalAnalyzed,
        totalBatches: batches.length,
        analysis: analyses,
      });

      districtSummary.totalResponses += totalAnalyzed;
    }

    appendDistrictSection(report, district, districtSummary);
  }

  // write final report
  await fs.mkdir(path.dirname(CONFIG.outputFile), { recursive: true });
  await fs.writeFile(CONFIG.outputFile, report.join("\n"));
  logger.log("Final report written to", CONFIG.outputFile);
})();
