
# Feedback Analysis

This repository contains tools and scripts for analyzing feedback data, including grammar improvement, category identification, CSV filtering, key metrics extraction, and data extraction.

## 1. Grammar Improvement (`grammar-improve`)
1. Update the `questionColumns` variable in the script as needed.
2. Run the script.
3. Check the generated output CSV file.

## 2. Question Comparison
- Use the web tool: [Question Comparison Tool](https://data-relationship-analyzer.vercel.app/main.html)

## 3. Category Identification (`cat-ai`)
1. Define all questions in `questions-config.json`.
2. Add your input file.
3. Run `categorize-multi-question.js` to categorize questions.

## 4. CSV Filter Empty Script (Optional)
1. Add the input file (from `cat-ai`).
2. Define `QUESTION_CATEGORY_MAP` in the script.
3. Run the script to filter empty rows.

## 5. Key Metrics (`key-metrics`)
1. Run the script to generate the output document.

## 6. Data Extraction (`data-extract`)
1. Define the `QUESTIONS` variable in the script.
2. Run the script to extract data.


