# Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Step 1: Install Dependencies (1 min)

```bash
npm install
```

### Step 2: Add Your API Keys (1 min)

Open `categorize-multi-question.js` and replace the API keys:

```javascript
const CONFIG = {
  GEMINI_API_KEYS: [
    "YOUR_GEMINI_API_KEY_HERE",  // ← Add your key here
  ],
  // ...
```

### Step 3: Prepare Your CSV (1 min)

Make sure your `input.csv` has these columns:
- `id` (or whatever you set in `ID_COLUMN`)
- `Q1. In the last 6 to 12 months, what do you think are some important changes in your school? These can be in students, teachers, parents or the school in general.`
- `Q2. How did you get the idea to make this change?`
- `Q3. Can you tell us about one change in your school that is close to you? How did you make it happen?`
- `Q4. In the next 3–6 months, what is your plan for this change?`
- `Q5. What are some challenges you face while making changes in schools?`
- `Q6. What support do you need to make changes in school?`
- `Q7. What helped you make this change in your school?`
- `Q8. What are some other changes you are planning in your school in next 3-6 months?`

**Column names must match EXACTLY** what's in `questions-config.json`

### Step 4: Configure Processing (1 min)

For a test run, process just 10 rows:

```javascript
const CONFIG = {
  // ...
  START_ROW: 0,
  MAX_ROWS: 10,    // ← Start with 10 rows for testing
  BATCH_SIZE: 5,
  // ...
```

### Step 5: Run It! (30 seconds + processing time)

```bash
node categorize-multi-question.js
```

Watch the magic happen! ✨

---

## 📊 What You'll Get

After running, you'll have:

1. **`output.csv`** - Your categorized data with new columns:
   - `q1_category_1`, `q1_category_2`, `q1_reasoning`, ...
   - `q2_categories`, `q2_reasoning`, ...
   - `q3_category`, `q3_reasoning`, ...
   - etc. for all questions

2. **`progress.json`** - Progress tracker (in case of interruptions)

3. **`categorization.log`** - Detailed logs of everything

---

## 🎯 Common Scenarios

### Scenario 1: "I just want to test with a few rows"

```javascript
const CONFIG = {
  START_ROW: 0,
  MAX_ROWS: 5,  // Just 5 rows
  // ...
```

### Scenario 2: "I want to process all rows"

```javascript
const CONFIG = {
  START_ROW: 0,
  MAX_ROWS: null,  // null = all rows
  // ...
```

### Scenario 3: "I want to resume from row 100"

```javascript
const CONFIG = {
  START_ROW: 100,
  MAX_ROWS: 50,  // Process rows 100-149
  // ...
```

Or just run it again after interruption - it auto-resumes! 🎉

### Scenario 4: "My CSV columns have different names"

Edit `questions-config.json`:

```json
{
  "id": "q1",
  "csv_column": "Changes in School",  // ← Update this to match your CSV
  // ...
}
```

---

## 🐛 Troubleshooting

### "Cannot find module '@google/generative-ai'"

**Fix:** Run `npm install`

### "Missing columns in CSV"

**Fix:** Check that your CSV column names exactly match `questions-config.json`

```bash
# See what columns you have:
head -1 input.csv

# Compare with questions-config.json:
grep csv_column questions-config.json
```

### "Rate limit exceeded"

**Fix:** Add more API keys or increase delay:

```javascript
GEMINI_API_KEYS: [
  "key1",
  "key2",  // Add more keys
  "key3",
],
REQUEST_DELAY: 2000,  // Increase delay to 2 seconds
```

### "Empty response text after preprocessing"

**Fix:** Some rows might have empty responses. Check your CSV for empty cells in question columns.

---

## 💡 Pro Tips

1. **Start Small**: Always test with `MAX_ROWS: 10` first
2. **Monitor Progress**: Run `tail -f categorization.log` in another terminal
3. **Multiple Keys**: Get 3-4 API keys for faster processing with automatic rotation
4. **Save Often**: Keep `BATCH_SIZE` at 10 or lower for frequent progress saves
5. **Resume Friendly**: Don't delete `progress.json` if you need to resume

---

## 📝 Example Output

### Console Output:
```
=============================================================
Starting Multi-Question CSV Categorization Process
=============================================================
Loaded 8 questions from config
Read 100 rows from CSV
Processing rows 0 to 9 (10 rows)
Processing 8 questions per row

Processing row 1/10 (ID: resp_001)
------------------------------------------------------------
  [q1] Processing...
  [q1] ✓ Categorized: Student | PBL
  [q2] Processing...
  [q2] ✓ Categorized: Trainings & peer learning
  ...
Row 1 completed: 8 successes, 0 errors

...

Progress saved: 10 rows processed

=============================================================
Processing Complete!
=============================================================
Total Rows Processed: 10
Total Successful Categorizations: 80
Total Errors: 0
Processing Rate: 6.50 rows/minute
Total Time: 1m 32s

Output saved to: ./output.csv
```

### Sample Output Row:

| id | Original_Q1_Text | q1_category_1 | q1_category_2 | q1_reasoning | q2_categories |
|----|------------------|---------------|---------------|--------------|---------------|
| 1  | "We implemented PBL..." | Student | PBL | Response focuses on student outcomes related to PBL | Trainings & peer learning; System directives |

---

## 🎓 Understanding Question Types

### Type 1: Single Category
**Questions:** Q3, Q4
**Output:** One category per row
**Example:** `q3_category: "Steps Mentioned"`

### Type 2: Multiple Categories
**Questions:** Q2, Q5, Q6, Q7, Q8
**Output:** Semicolon-separated list
**Example:** `q2_categories: "Training; Self-observation"`

### Type 3: Dual Categories
**Questions:** Q1 only
**Output:** Two separate categories
**Example:** `q1_category_1: "Student"`, `q1_category_2: "PBL"`

---

## ✅ Checklist Before Running

- [ ] `npm install` completed
- [ ] API keys added to script
- [ ] `input.csv` exists and has all required columns
- [ ] Column names in CSV match `questions-config.json`
- [ ] `MAX_ROWS` set appropriately (small number for testing)
- [ ] Ready to monitor with `tail -f categorization.log`

All set? Run:
```bash
node categorize-multi-question.js
```

Good luck! 🎉
