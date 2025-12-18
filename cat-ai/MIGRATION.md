# Migration Guide: Old Script → New Script

## Overview of Changes

The refactored script transforms a **single-question hardcoded system** into a **flexible multi-question configuration-driven system** while maintaining all core functionality.

---

## High-Level Comparison

| Aspect | Old Script | New Script |
|--------|-----------|------------|
| **Questions Handled** | 1 (Q1 only) | 8+ (unlimited) |
| **Configuration** | Hardcoded in script | External JSON config |
| **Response Schema** | Single fixed schema | Dynamic per-question schemas |
| **Output Columns** | Fixed 6 columns | Dynamic based on questions |
| **Category Tracking** | Global set | Per-question tracking |
| **Progress Stats** | Overall only | Overall + per-question |
| **Extensibility** | Requires code changes | Just edit JSON |
| **Code Lines** | ~500 | ~700 (but more generic) |

---

## Detailed Changes

### 1. Configuration Architecture

#### Old Approach ❌
```javascript
// Everything hardcoded in the script
const CONFIG = {
  QUESTION_COLUMN: "Q1. In the last 6 to 12 months...",
  // Single question definition
};

const CATEGORIZATION_CRITERIA = `
CATEGORY 1 DEFINITIONS (Choose ONE):
...
`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    category_1: { type: "string", ... },
    category_2: { type: "string", ... },
  },
};
```

**Problems:**
- Adding new questions requires editing code
- Schema is fixed for all questions
- Hard to maintain or version control question definitions
- No reusability across different datasets

#### New Approach ✅
```javascript
// Load from external config
const QUESTIONS_CONFIG = loadQuestionsConfig();

// Schemas built dynamically
function buildResponseSchema(question) {
  // Dynamically constructs schema based on question config
}
```

**Benefits:**
- Add questions by editing JSON only
- Each question has custom schema
- Easy to version control question definitions
- Reusable across different projects

---

### 2. Response Schema Flexibility

#### Old Approach ❌
**Single fixed schema:**
```javascript
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    category_1: { type: "string" },
    category_2: { type: "string", enum: ["PBL", "Non-PBL", "Not Identified"] },
    reasoning: { type: "string" },
  },
};
```

**Limitation:** All questions must fit this exact structure

#### New Approach ✅
**Dynamic schemas per question:**

```javascript
// Q1: Dual categories
{
  "response_fields": [
    { "name": "category_1", "type": "string" },
    { "name": "category_2", "type": "enum", "enum": ["PBL", "Non-PBL"] }
  ]
}

// Q2: Multiple categories
{
  "response_fields": [
    { "name": "categories", "type": "array" }
  ]
}

// Q3: Single category enum
{
  "response_fields": [
    { "name": "category", "type": "enum", "enum": ["Steps Mentioned", "Steps Not Mentioned"] }
  ]
}
```

**Benefit:** Each question can have completely different structure

---

### 3. Processing Loop

#### Old Approach ❌
```javascript
for (let i = startFrom; i < endRow; i++) {
  const row = inputRows[i];
  const responseText = preprocessResponse(row[CONFIG.QUESTION_COLUMN]);
  
  // Process ONE question only
  const result = await client.categorizeResponse(responseText, rowId);
  
  // Add to output with fixed columns
  outputRow.category_1_result = result.category_1;
  outputRow.category_2_result = result.category_2;
  // ...
}
```

**Limitation:** Only processes one question per row

#### New Approach ✅
```javascript
for (let i = startFrom; i < endRow; i++) {
  const row = inputRows[i];
  
  // Process EACH question for this row
  for (const question of QUESTIONS_CONFIG.questions) {
    const responseText = preprocessResponse(row[question.csv_column]);
    
    const result = await client.categorizeResponse(
      question,
      responseText,
      rowId
    );
    
    // Add to output with dynamic columns
    const formatted = formatResultForCSV(question, result);
    outputRow[`${question.id}_category`] = formatted.category;
    outputRow[`${question.id}_reasoning`] = formatted.reasoning;
    // ...
  }
}
```

**Benefit:** Nested loop handles all questions for all rows

---

### 4. Output Column Generation

#### Old Approach ❌
**Fixed output columns:**
```javascript
const newHeaders = [
  ...allHeaders,
  "category_1_result",
  "category_2_result",
  "new_category_suggested",
  "categorization_reasoning",
  "processing_status",
  "error_message",
];
```

**Result:** Same 6 columns for every run

#### New Approach ✅
**Dynamic output columns:**
```javascript
const newHeaders = [...allHeaders];

// Generate columns based on questions config
QUESTIONS_CONFIG.questions.forEach((q) => {
  if (q.response_fields.some((f) => f.name === "category_1")) {
    newHeaders.push(`${q.id}_category_1`);
    newHeaders.push(`${q.id}_category_2`);
  } else if (q.response_fields.some((f) => f.name === "category")) {
    newHeaders.push(`${q.id}_category`);
  } else if (q.response_fields.some((f) => f.name === "categories")) {
    newHeaders.push(`${q.id}_categories`);
  }
  
  newHeaders.push(`${q.id}_reasoning`);
  newHeaders.push(`${q.id}_processing_status`);
  newHeaders.push(`${q.id}_error_message`);
  // ...
});
```

**Result:** 
- Q1: 6 columns (`q1_category_1`, `q1_category_2`, ...)
- Q2: 4 columns (`q2_categories`, `q2_reasoning`, ...)
- Q3: 4 columns (`q3_category`, `q3_reasoning`, ...)
- Total: ~40 output columns for 8 questions

---

### 5. State Management & Progress Tracking

#### Old Approach ❌
```javascript
class ProcessingState {
  constructor() {
    this.processedRows = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.discoveredCategories = new Set();  // Global
  }
}
```

**Stats Output:**
```
Total Rows Processed: 100
Successful: 98
Errors: 2
Discovered Categories: None
```

#### New Approach ✅
```javascript
class ProcessingState {
  constructor() {
    this.processedRows = 0;
    this.successCount = 0;    // Total across all questions
    this.errorCount = 0;      // Total across all questions
    this.questionStats = {};  // Per-question tracking
    this.discoveredCategories = {};  // Per-question tracking
    
    QUESTIONS_CONFIG.questions.forEach((q) => {
      this.questionStats[q.id] = {
        successCount: 0,
        errorCount: 0,
      };
      this.discoveredCategories[q.id] = new Set();
    });
  }
}
```

**Stats Output:**
```
Total Rows Processed: 100
Total Successful Categorizations: 782
Total Errors: 18

Per-Question Statistics:
------------------------------------------------------------
q1:
  Success: 98
  Errors: 2
q2:
  Success: 97
  Errors: 3
  Discovered Categories: Media Influence, Online Resources
q3:
  Success: 100
  Errors: 0
...
```

**Benefit:** Detailed insights per question

---

### 6. Prompt Building

#### Old Approach ❌
```javascript
buildPrompt(responseText) {
  return `You are an expert education researcher...
  
QUESTION ASKED TO TEACHER:
"In the last 6 to 12 months, what do you think are some important changes..."

TEACHER'S RESPONSE:
"${responseText}"

${CATEGORIZATION_CRITERIA}

INSTRUCTIONS:
1. Focus on substantive content
2. Assign ONE category from Category 1
...
`;
}
```

**Limitation:** Same question and criteria for all calls

#### New Approach ✅
```javascript
buildPrompt(question, responseText) {
  const multiCategoryNote = question.allow_multiple_categories
    ? "This question allows multiple categories. Select all that apply."
    : "This question requires selecting a SINGLE category.";
    
  return `You are an expert education researcher...
  
QUESTION ASKED TO TEACHER:
"${question.question_text}"

TEACHER'S RESPONSE:
"${responseText}"

${question.categorization_criteria}

${multiCategoryNote}

INSTRUCTIONS:
...
`;
}
```

**Benefit:** Customized prompt per question with appropriate instructions

---

### 7. Model Caching

#### Old Approach ❌
```javascript
class GeminiClient {
  constructor(state) {
    this.model = this.genAI.getGenerativeModel({
      model: CONFIG.MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,  // Single schema
      },
    });
  }
}
```

**Problem:** Can't change schema without recreating client

#### New Approach ✅
```javascript
class GeminiClient {
  constructor(state) {
    this.modelCache = {};  // Cache models per question
  }
  
  getModelForQuestion(question) {
    if (this.modelCache[question.id]) {
      return this.modelCache[question.id];
    }
    
    const schema = buildResponseSchema(question);
    const model = this.genAI.getGenerativeModel({
      model: CONFIG.MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,  // Question-specific schema
      },
    });
    
    this.modelCache[question.id] = model;
    return model;
  }
}
```

**Benefit:** Each question gets its own model instance with correct schema

---

## Code Structure Comparison

### Old File Structure
```
categorize.js (500 lines)
├── Configuration (hardcoded)
├── Response Schema (fixed)
├── Categorization Criteria (hardcoded)
├── State Management
├── Gemini Client
└── Main Processing Loop
```

### New File Structure
```
categorize-multi-question.js (700 lines)
├── Configuration (minimal)
├── Dynamic Schema Builder
├── State Management (enhanced)
├── Gemini Client (with model cache)
└── Main Processing Loop (nested)

questions-config.json (200 lines)
└── All question definitions
```

---

## Migration Checklist

### If You Already Processed Some Rows

✅ **You can continue!** The new script can work alongside old results:

1. **Back up old output:**
   ```bash
   cp output.csv output-q1-only-backup.csv
   ```

2. **Two options:**

   **Option A: Keep old Q1 results, add new questions**
   - Copy `q1_*` columns from old output to new input
   - Configure new script to skip Q1 or overwrite
   
   **Option B: Reprocess everything**
   - Start fresh with all questions
   - More consistent but takes longer

3. **Update column mapping:**
   ```json
   {
     "id": "q1",
     "csv_column": "Q1. In the last 6 to 12 months...",  // Must match CSV exactly
     // ...
   }
   ```

4. **Run new script:**
   ```bash
   node categorize-multi-question.js
   ```

### If Starting Fresh

✅ **Easy!** Just follow the Quick Start guide:

1. Install: `npm install`
2. Add API keys
3. Verify CSV columns match config
4. Run: `node categorize-multi-question.js`

---

## Performance Comparison

### Old Script (1 question per row)
```
100 rows × 1 question = 100 API calls
Time: ~8-10 minutes
Output: 6 new columns
```

### New Script (8 questions per row)
```
100 rows × 8 questions = 800 API calls
Time: ~60-80 minutes
Output: ~40 new columns
```

**Time Scaling:** Linear with number of questions and rows

**Optimization Tips:**
- Use multiple API keys (faster rotation)
- Reduce `REQUEST_DELAY` (if rate limits allow)
- Process in batches (run multiple instances with different row ranges)

---

## Backward Compatibility

### Can I still use the old script?

✅ **Yes!** The old script still works for Q1-only processing.

### Can I mix old and new results?

✅ **Yes!** Output columns don't conflict:
- Old: `category_1_result`, `category_2_result`
- New: `q1_category_1`, `q1_category_2`

### Should I migrate?

**Migrate if:**
- ✅ You need to process multiple questions
- ✅ You want better progress tracking
- ✅ You need flexibility for future questions
- ✅ You want config-driven approach

**Keep old script if:**
- ❌ You only need Q1
- ❌ You've already processed everything
- ❌ You don't need extensibility

---

## Testing the Migration

### Step 1: Test with Small Dataset
```javascript
const CONFIG = {
  START_ROW: 0,
  MAX_ROWS: 5,  // Just 5 rows
  // ...
```

### Step 2: Verify Output Structure
```bash
head -1 output.csv
```

Check that you see columns like:
- `q1_category_1`, `q1_category_2`, `q1_reasoning`
- `q2_categories`, `q2_reasoning`
- `q3_category`, `q3_reasoning`
- etc.

### Step 3: Compare Results for Q1

If you have old Q1 results, compare a few rows manually:

**Old:**
```
category_1_result: "Student"
category_2_result: "PBL"
```

**New:**
```
q1_category_1: "Student"
q1_category_2: "PBL"
```

Should be identical or very similar (AI may vary slightly)

### Step 4: Full Run

Once verified, process all rows:
```javascript
const CONFIG = {
  MAX_ROWS: null,  // All rows
  // ...
```

---

## Summary

### What Stayed the Same ✅
- API key rotation logic
- Retry mechanism
- Progress saving
- Rate limit handling
- Text preprocessing
- Logging system
- CSV reading/writing

### What Changed 🔄
- Multiple questions per row (not just Q1)
- Config-driven question definitions
- Dynamic response schemas
- Per-question statistics
- Flexible output columns
- Question-specific prompts

### What's Better ✨
- **Extensibility**: Add questions without coding
- **Clarity**: Question logic separated from code
- **Tracking**: Detailed per-question stats
- **Flexibility**: Different schemas per question
- **Reusability**: Config can be shared/versioned

---

## Need Help?

1. **Review** `README.md` for comprehensive documentation
2. **Check** `QUICKSTART.md` for quick setup
3. **Examine** `questions-config.json` for examples
4. **Test** with small dataset first (`MAX_ROWS: 5`)
5. **Monitor** `categorization.log` for issues

Happy categorizing! 🎉
