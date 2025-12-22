const fs = require("fs");
const Papa = require("papaparse");

// Configuration
const INPUT_FILE = "input.csv";
const OUTPUT_FILE = "output_fixed.csv";

// Define the mapping of question columns to their category columns
// const QUESTION_CATEGORY_MAP = {
//   "Q1. In the last 6 to 12 months, what do you think are some important changes in your school? These can be in students, teachers, parents or the school in general.":
//     ["q1_category_1", "q1_category_2"],
//   "Q2: Can you tell us about one change in your school that is close to you? How did you make it happen?":
//     ["q2_category"],
//   "Q3. How did you get the idea to make this change?": ["q3_categories"],
//   "Q4: In the next 3–6 months, what is your plan for this change?": [
//     "q4_category",
//   ],
//   "Q5: What helped you make this change in your school?": ["q5_categories"],
//   "Q6: What are some challenges you face while making  changes in schools?": [
//     "q6_categories",
//   ],
//   "Q7: What are some other changes you are planning in your school in next 3-6 months?":
//     ["q7_categories"],
//   "Q8: What support do you need to make changes in school?": ["q8_categories"],
// };

const QUESTION_CATEGORY_MAP = {
  "Q1: In the last 6 to 12 months, what is one improvement that you have led in your school? This can be in students, teachers, parents or the school in general":
    ["q1_category_1", "q1_category_2"],
  "Q2: How did you get the idea for this improvement?":
    ["q2_categories"],
  "Q3. What did you do to implement this improvement?": ["q3_category"],
  "Q4: What helped you implement this improvement in your school?": [
    "q4_categories",
  ],
  "Q5: In the next 3-6 months, do you plan to do anything more for the improvement you led?": ["q5_category"],
  "Q6: What are some challenges you face while implementing improvements in your school?": [
    "q6_categories",
  ],
  "Q7: What are some other improvements you are planning in your school in the next 3-6 months?":
    ["q7_categories"],
  "Q8: What support do you need to implement these improvements in your school?": ["q8_categories"],
};

function isEmptyResponse(value) {
  if (value === null || value === undefined) return true;
  const trimmed = String(value).trim();
  return trimmed === "";
}

function fixCategories(data) {
  let fixedCount = 0;
  let typoFixCount = 0;
  const changeStats = {};
  const columnNoResponseCount = {};

  data.forEach((row, index) => {
    Object.entries(QUESTION_CATEGORY_MAP).forEach(
      ([questionCol, categoryColumns]) => {
        const responseValue = row[questionCol];

        categoryColumns.forEach((catCol) => {
          // Fix typo: NO RESPOSNE -> NO RESPONSE
          if (row[catCol] && row[catCol].trim() === "NO RESPOSNE") {
            row[catCol] = "NO RESPONSE";
            typoFixCount++;
            console.log(
              `Row ${
                index + 2
              }: Fixed typo in ${catCol}: "NO RESPOSNE" → "NO RESPONSE"`
            );
          }

          // Fix empty responses that were miscategorized
          if (isEmptyResponse(responseValue)) {
            if (
              row[catCol] &&
              row[catCol].trim() !== "" &&
              row[catCol].trim() !== "NO RESPONSE"
            ) {
              const oldValue = row[catCol];

              // Track statistics for changes
              const key = `${catCol}: "${oldValue}" → "NO RESPONSE"`;
              changeStats[key] = (changeStats[key] || 0) + 1;

              // Fix the category
              row[catCol] = "NO RESPONSE";
              fixedCount++;

              console.log(
                `Row ${
                  index + 2
                }: Fixed ${catCol} from "${oldValue}" to "NO RESPONSE"`
              );
            }
          }
        });
      }
    );
  });

  // Count total NO RESPONSE in each column after fixes
  Object.values(QUESTION_CATEGORY_MAP)
    .flat()
    .forEach((catCol) => {
      columnNoResponseCount[catCol] = data.filter(
        (row) => row[catCol] && row[catCol].trim() === "NO RESPONSE"
      ).length;
    });

  return { fixedCount, typoFixCount, changeStats, columnNoResponseCount };
}

// Main execution
console.log("Reading CSV file...");
const fileContent = fs.readFileSync(INPUT_FILE, "utf8");

console.log("Parsing CSV...");
const parsed = Papa.parse(fileContent, {
  header: true,
  skipEmptyLines: false,
  encoding: "utf8",
});

if (parsed.errors.length > 0) {
  console.error("Parsing errors:", parsed.errors);
}

console.log(`Total rows: ${parsed.data.length}`);
console.log("\nFixing categories...\n");

const { fixedCount, typoFixCount, changeStats, columnNoResponseCount } =
  fixCategories(parsed.data);

console.log("\n" + "=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));

console.log(`\n📝 Typo fixes (NO RESPOSNE → NO RESPONSE): ${typoFixCount}`);
console.log(`🔧 Empty response fixes: ${fixedCount}`);
console.log(`📊 Total changes: ${fixedCount + typoFixCount}`);

if (Object.keys(changeStats).length > 0) {
  console.log("\n" + "-".repeat(60));
  console.log("BREAKDOWN OF EMPTY RESPONSE FIXES:");
  console.log("-".repeat(60));
  Object.entries(changeStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([key, count]) => {
      console.log(`  ${count}x ${key}`);
    });
}

console.log("\n" + "-".repeat(60));
console.log('TOTAL "NO RESPONSE" COUNT PER COLUMN (AFTER FIXES):');
console.log("-".repeat(60));
Object.entries(columnNoResponseCount)
  .sort((a, b) => b[1] - a[1])
  .forEach(([column, count]) => {
    console.log(`  ${column}: ${count}`);
  });
console.log("=".repeat(60));

console.log("\nWriting fixed CSV...");
const csv = Papa.unparse(parsed.data, {
  quotes: true,
  header: true,
});

fs.writeFileSync(OUTPUT_FILE, csv, "utf8");
console.log(`\nFixed CSV saved to: ${OUTPUT_FILE}`);
console.log("Done!");
