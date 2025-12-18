# Multi-Question CSV Categorization Script

## Overview

This refactored script processes **multiple questions** from a single CSV file, categorizing responses using the Google Gemini API. It's designed to be **config-driven** while remaining simple enough for one-time use.

## Key Features

- ✅ **Multi-question support**: Process 5-6+ questions in one run
- ✅ **Config-driven**: Define all questions in `questions-config.json`
- ✅ **Flexible categorization**: Single or multiple categories per question
- ✅ **Progress tracking**: Per-question and overall stats
- ✅ **Resume capability**: Pick up where you left off after interruptions
- ✅ **Dynamic schemas**: Each question can have different response structures
- ✅ **Rate limiting handling**: Automatic API key rotation and retry logic

---

## Files

1. **`categorize-multi-question.js`** - Main refactored script
2. **`questions-config.json`** - Configuration file defining all questions
3. **`input.csv`** - Your source data (all questions in different columns)
4. **`output.csv`** - Generated results (created by script)
5. **`progress.json`** - Auto-generated progress tracker
6. **`categorization.log`** - Detailed execution logs

---

## Setup

### 1. Install Dependencies

```bash
npm install @google/generative-ai csv-parser csv-writer
```

Or if you have a `package.json`:

```bash
npm install
```

### 2. Add Your API Keys

Open `categorize-multi-question.js` and add your Gemini API keys:

```javascript
const CONFIG = {
  GEMINI_API_KEYS: [
    "YOUR_API_KEY_1",
    "YOUR_API_KEY_2", // Optional: add more for rotation
    "YOUR_API_KEY_3",
  ],
  // ... rest of config
};
```

### 3. Verify Your CSV Structure

Make sure your `input.csv` has:
- An `id` column (or update `CONFIG.ID_COLUMN`)
- All question columns matching the `csv_column` values in `questions-config.json`

Example CSV structure:
```
id,Q1. In the last 6 to 12 months...,Q2. How did you get the idea...,Q3. Can you tell us...
1,"PBL implementation","From training","I conducted workshops"
2,"Student improvements","Self observation","By organizing meetings"
```

---

## Configuration

### Main Script Config (`categorize-multi-question.js`)

```javascript
const CONFIG = {
  // File paths
  INPUT_CSV: "./input.csv",
  OUTPUT_CSV: "./output.csv",
  QUESTIONS_CONFIG: "./questions-config.json",
  
  // Processing settings
  START_ROW: 0,           // Start from row N (0-indexed)
  MAX_ROWS: 10,           // Process N rows (null = all rows)
  BATCH_SIZE: 10,         // Save progress every N rows
  
  // API settings
  MODEL_NAME: "gemini-2.0-flash-exp",
  MAX_RETRIES: 3,
  REQUEST_DELAY: 1000,    // ms between API calls
  
  // Column mapping
  ID_COLUMN: "id",
};
```

### Questions Config (`questions-config.json`)

Each question is defined with:

```json
{
  "id": "q1",                              // Unique identifier
  "csv_column": "Q1. In the last...",      // Exact CSV column name
  "question_text": "In the last...",       // Question text for prompt
  "allow_multiple_categories": false,      // Single or multiple?
  "allow_new_categories": true,            // Allow AI to suggest new ones?
  "response_fields": [...],                // Define response structure
  "categorization_criteria": "..."         // Categorization guidelines
}
```

#### Response Field Types

**1. Single String Field:**
```json
{
  "name": "reasoning",
  "type": "string",
  "description": "Brief explanation"
}
```

**2. Enum (Predefined List):**
```json
{
  "name": "category",
  "type": "enum",
  "description": "Choose one",
  "enum": ["Option A", "Option B", "Option C"]
}
```

**3. Array (Multiple Categories):**
```json
{
  "name": "categories",
  "type": "array",
  "description": "List of categories"
}
```

---

## Usage

### Basic Usage

Process all rows with all questions:

```bash
node categorize-multi-question.js
```

### Process Specific Rows

Edit the config in the script:

```javascript
const CONFIG = {
  START_ROW: 0,      // Start from row 0
  MAX_ROWS: 100,     // Process 100 rows
  // ...
};
```

Then run:

```bash
node categorize-multi-question.js
```

### Resume After Interruption

The script automatically saves progress. Just run it again:

```bash
node categorize-multi-question.js
```

It will read `progress.json` and continue from the last completed row.

---

## Output Structure

The output CSV will contain:
- All original columns from input CSV
- For each question, new columns with prefix `{question_id}_`:

**For Single Category Questions (Q1, Q3, Q4):**
- `q1_category_1` or `q3_category`
- `q1_category_2` (if applicable)
- `q1_reasoning`
- `q1_new_category_suggested` (if allowed)
- `q1_processing_status` (SUCCESS/ERROR)
- `q1_error_message`

**For Multiple Category Questions (Q2, Q5, Q6, Q7, Q8):**
- `q2_categories` (semicolon-separated)
- `q2_reasoning`
- `q2_new_category_suggested` (if allowed)
- `q2_processing_status` (SUCCESS/ERROR)
- `q2_error_message`

---

## Adding New Questions

### Step 1: Add to `questions-config.json`

```json
{
  "id": "q9",
  "csv_column": "Q9. Your new question text?",
  "question_text": "Your new question text?",
  "allow_multiple_categories": true,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "categories",
      "type": "array",
      "description": "List of themes"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Brief explanation"
    }
  ],
  "categorization_criteria": "CATEGORY DEFINITIONS:\n\n**Theme A**\nDefinition: ...\nKeywords: ...\n\n**Theme B**\nDefinition: ...\nKeywords: ..."
}
```

### Step 2: Verify CSV Column

Make sure your CSV has a column named exactly `"Q9. Your new question text?"`

### Step 3: Run the Script

```bash
node categorize-multi-question.js
```

The script will automatically:
- Load your new question
- Create appropriate output columns
- Process all rows for this question

---

## Migration from Old Script

### What Changed?

| Old Script | New Script |
|------------|------------|
| Single question hardcoded | Multiple questions from config |
| One set of output columns | Dynamic columns per question |
| Single response schema | Per-question schemas |
| Global category tracking | Per-question category tracking |
| Simple progress | Detailed per-question stats |

### Key Differences in Code

**Old Way:**
```javascript
const CATEGORIZATION_CRITERIA = `...`;
const RESPONSE_SCHEMA = {...};
```

**New Way:**
```javascript
// Everything in questions-config.json
loadQuestionsConfig();
const schema = buildResponseSchema(question);
```

### Migrating Existing Work

If you already processed some rows with the old script:

1. **Rename old output**: `mv output.csv output-q1-only.csv`
2. **Update config**: Set `START_ROW` to continue from where you left off
3. **Run new script**: It will add new question columns

---

## Question Types & Examples

### Type 1: Single Category (Q1, Q3, Q4)

**Example - Q3:**
```json
{
  "response_fields": [
    {
      "name": "category",
      "type": "enum",
      "enum": ["Steps Mentioned", "Steps Not Mentioned"]
    }
  ]
}
```

**Output:**
```
q3_category: "Steps Mentioned"
```

### Type 2: Multiple Categories (Q2, Q5, Q6, Q7, Q8)

**Example - Q2:**
```json
{
  "allow_multiple_categories": true,
  "response_fields": [
    {
      "name": "categories",
      "type": "array"
    }
  ]
}
```

**Output:**
```
q2_categories: "Trainings & peer learning; Self-observation and self-motivation"
```

### Type 3: Dual Categories (Q1 only)

**Example - Q1:**
```json
{
  "response_fields": [
    {
      "name": "category_1",
      "type": "string"
    },
    {
      "name": "category_2",
      "type": "enum",
      "enum": ["PBL", "Non-PBL", "Not Identified"]
    }
  ]
}
```

**Output:**
```
q1_category_1: "Student"
q1_category_2: "PBL"
```

---

## Troubleshooting

### "Missing columns in CSV" Error

**Problem:** Script can't find question columns in CSV

**Solution:** 
1. Check exact column names in your CSV
2. Update `csv_column` in `questions-config.json` to match exactly
3. Verify column names don't have extra spaces or characters

### Rate Limit Errors

**Problem:** "Rate limit exceeded on all API keys"

**Solution:**
1. Add more API keys to `CONFIG.GEMINI_API_KEYS`
2. Increase `REQUEST_DELAY` (e.g., to 2000ms)
3. Process in smaller batches (`MAX_ROWS: 50`)

### Empty/Invalid Responses

**Problem:** Some rows show "ERROR" status

**Solution:**
1. Check `{question_id}_error_message` column for details
2. Verify response text isn't empty after preprocessing
3. Check if categorization criteria is clear enough

### Progress Not Resuming

**Problem:** Script restarts from beginning

**Solution:**
1. Check if `progress.json` exists
2. Don't delete `progress.json` between runs
3. Verify `START_ROW` isn't hardcoded to 0

---

## Performance Optimization

### For Large Datasets (1000+ rows)

1. **Use multiple API keys:**
   ```javascript
   GEMINI_API_KEYS: [
     "key1", "key2", "key3", "key4", "key5"
   ]
   ```

2. **Adjust batch size:**
   ```javascript
   BATCH_SIZE: 50  // Save more frequently
   ```

3. **Reduce delay for faster processing:**
   ```javascript
   REQUEST_DELAY: 500  // Be careful of rate limits
   ```

### Monitoring Progress

Watch the log file in real-time:
```bash
tail -f categorization.log
```

Or check progress file:
```bash
cat progress.json
```

---

## Advanced Configuration

### Custom Category Discovery

Enable/disable per question:
```json
{
  "allow_new_categories": true,  // AI can suggest new ones
  "allow_new_categories": false  // Strict predefined list
}
```

### Complex Response Schemas

For questions needing nested objects:
```json
{
  "name": "detailed_analysis",
  "type": "object",
  "properties": {
    "primary_theme": { "type": "string" },
    "confidence": { "type": "number" }
  }
}
```

---

## Example Run Output

```
=============================================================
Starting Multi-Question CSV Categorization Process
=============================================================
Loaded 8 questions from config
Read 500 rows from CSV
Processing rows 0 to 499 (500 rows)
Processing 8 questions per row

Processing row 1/500 (ID: resp_001)
------------------------------------------------------------
  [q1] Processing...
  [q1] ✓ Categorized: Student | PBL
  [q2] Processing...
  [q2] ✓ Categorized: Trainings & peer learning; System directives
  [q3] Processing...
  [q3] ✓ Categorized: Steps Mentioned
  ...
Row 1 completed: 8 successes, 0 errors

...

=============================================================
Processing Complete!
=============================================================
Total Rows Processed: 500
Total Successful Categorizations: 3,987
Total Errors: 13
API Key Switches: 5
Processing Rate: 12.45 rows/minute
Total Time: 40m 11s

Per-Question Statistics:
------------------------------------------------------------
q1:
  Success: 498
  Errors: 2
  Discovered Categories: None

q2:
  Success: 497
  Errors: 3
  Discovered Categories: Media Influence, Online Resources

...

Output saved to: ./output.csv
```

---

## Support

### Common Issues

1. **API Key Issues**: Make sure keys are valid and have quota
2. **CSV Format**: Use UTF-8 encoding, avoid special characters in column names
3. **Memory Issues**: Process in smaller batches if dataset is very large

### Need Help?

1. Check `categorization.log` for detailed error messages
2. Review `progress.json` for processing state
3. Verify `questions-config.json` is valid JSON

---

## Future Enhancements

Potential improvements for production use:
- Database integration instead of CSV
- Web UI for monitoring progress
- Parallel processing of multiple rows
- More sophisticated error recovery
- Export to multiple formats (JSON, Excel)

For now, this script balances **flexibility** with **simplicity** for one-time processing tasks.
