# Feedback Analysis Toolkit

A professional, production-ready toolkit for analyzing teacher feedback using AI-powered categorization, grammar improvement, and data cleaning.

## 🎯 Features

- ✨ **AI-Powered Categorization** - Automatically categorize responses using Gemini AI with custom frameworks
- 📝 **Grammar Improvement** - Enhance clarity and readability while preserving meaning
- 🧹 **Data Cleaning** - Fix typos, normalize categories, handle empty responses
- ⚙️ **Fully Configurable** - Config files + environment variables
- 🔄 **Resume Capability** - Built-in progress tracking with resume support
- 🔑 **API Key Rotation** - Automatic rotation across multiple API keys
- 📊 **Comprehensive Logging** - Detailed logs with progress tracking and statistics
- 🚀 **Pipeline Automation** - End-to-end processing with one command

---

## 📦 Quick Start (5 Minutes)

### Step 1: Installation
```bash
./setup.sh
# Or manually: npm install && cp .env.example .env
```

### Step 2: Configure API Keys
```bash
nano .env
```
Add your Gemini API key(s):
```env
API_KEYS=your_api_key_here
# Multiple keys: API_KEYS=key1,key2,key3
```

### Step 3: Prepare Questions Config
```bash
cp questions-config.example.json questions-config.json
# Customize for your specific questions
```

### Step 4: Test with Small Sample
```bash
echo "MAX_ROWS=5" >> .env
node 3_categorize.js --input data.csv --output test.csv
```

### Step 5: Run Full Pipeline
```bash
# Remove MAX_ROWS from .env, then:
node 0_pipeline.js --input data.csv --output final.csv
```

---

## 📚 Available Scripts

### **0_pipeline.js** - Complete Automated Pipeline
Runs all processing steps in sequence:
```bash
node 0_pipeline.js --input raw_data.csv --output final.csv

# Options:
#   --skip-filter       Skip data filtering step
#   --skip-grammar      Skip grammar improvement step
#   --skip-categorize   Skip categorization step
#   --keep-intermediate Keep intermediate files
```

### **1_improve-grammar.js** - Grammar Enhancement
Improves grammar, clarity, and expands acronyms:
```bash
node 1_improve-grammar.js --input data.csv --output improved.csv

# Options:
#   --resume    Resume from saved progress
#   --backup    Create backup (default: true)
```

### **3_categorize.js** - AI-Powered Categorization
Categorizes responses based on custom frameworks:
```bash
node 3_categorize.js --input data.csv --output categorized.csv

# Options:
#   --questions  Path to questions-config.json
#   --resume     Resume from saved progress
#   --clear      Start fresh, clear progress
```

### **4_filter-csv.js** - Data Cleaning
Cleans data, fixes typos, normalizes categories:
```bash
node 4_filter-csv.js --input data.csv --output clean.csv

# Options:
#   --fix-typos    Fix common typos (default: true)
#   --fix-empty    Fix empty categorizations (default: true)
#   --normalize    Normalize category values (default: true)
```

---

## ⚙️ Configuration

### Environment Variables (.env)

```env
# ===== API Configuration =====
API_KEYS=key1,key2,key3           # Comma-separated API keys (required)
MODEL_NAME=gemini-2.0-flash-exp   # Gemini model to use
TEMPERATURE=0.3                    # Model temperature (0-1)

# ===== Processing =====
BATCH_SIZE=10                      # Rows per batch
SAVE_PROGRESS_EVERY=10             # Save progress interval
MAX_ROWS=                          # Limit processing (optional)

# ===== File Paths =====
INPUT_CSV=./input.csv
OUTPUT_CSV=./output.csv
PROGRESS_FILE=./progress.json

# ===== Logging =====
LOG_LEVEL=info                     # debug, info, warn, error
COLORIZE_LOGS=true
```

### Questions Configuration (questions-config.json)

Define your categorization framework:

```json
{
  "q1": {
    "question_text": "What changes have you made?",
    "column_name": "Q1",
    "response_fields": {
      "category": {
        "type": "enum",
        "enum": ["TEACHING_METHODS", "INFRASTRUCTURE", "COMMUNITY"],
        "description": "Main category of the change"
      },
      "reasoning": {
        "type": "string",
        "description": "Explanation for categorization"
      }
    },
    "categorization_criteria": {
      "instructions": "Categorize based on the primary focus area.",
      "categories": [
        {
          "name": "TEACHING_METHODS",
          "definition": "Changes to teaching approaches or pedagogy",
          "keywords": ["teaching", "lesson", "pedagogy", "instruction"],
          "examples": ["Started group activities", "Project-based learning"]
        },
        {
          "name": "INFRASTRUCTURE",
          "definition": "Physical changes to facilities or resources",
          "keywords": ["building", "classroom", "facilities", "materials"],
          "examples": ["Built library", "Renovated classrooms"]
        }
      ]
    }
  }
}
```

**Key Configuration Elements:**
- **question_text**: The actual question asked
- **column_name**: CSV column with responses (must match your CSV)
- **response_fields**: Defines AI output structure
  - **type**: "enum" for categories, "string" for text, "array" for multiple values
  - **enum**: List of allowed category values
- **categorization_criteria**: Guides AI categorization
  - **instructions**: Overall guidance
  - **categories**: Array with name, definition, keywords, examples

---

## 📋 Common Workflows

### Workflow 1: Complete Pipeline
```bash
node 0_pipeline.js --input raw_data.csv --output final.csv
```
This automatically:
1. Filters and cleans data
2. Improves grammar and clarity
3. Categorizes all responses

### Workflow 2: Custom Order
```bash
# 1. Clean data first
node 4_filter-csv.js --input raw.csv --output clean.csv

# 2. Categorize responses
node 3_categorize.js --input clean.csv --output categorized.csv

# 3. Improve grammar (optional)
node 1_improve-grammar.js --input categorized.csv --output final.csv
```

### Workflow 3: Just Categorization
```bash
node 3_categorize.js --input data.csv --output categorized.csv
```

### Workflow 4: Resume Interrupted Process
```bash
# If script was interrupted, simply resume:
node 3_categorize.js --resume
```

### Workflow 5: Process Large Dataset
```bash
# Configure for large datasets in .env:
BATCH_SIZE=20
SAVE_PROGRESS_EVERY=20
API_KEYS=key1,key2,key3,key4

# Run with progress tracking:
node 3_categorize.js --input large_data.csv --output results.csv

# If interrupted, resume:
node 3_categorize.js --resume
```

---

## 🔧 Advanced Configuration

### Performance Tuning

**For Small Datasets (< 100 rows):**
```env
BATCH_SIZE=10
REQUEST_DELAY=500
MAX_RETRIES=3
```

**For Medium Datasets (100-1000 rows):**
```env
BATCH_SIZE=15
REQUEST_DELAY=1000
MAX_RETRIES=5
API_KEYS=key1,key2,key3
```

**For Large Datasets (1000+ rows):**
```env
BATCH_SIZE=20
REQUEST_DELAY=800
MAX_RETRIES=5
API_KEYS=key1,key2,key3,key4,key5
SAVE_PROGRESS_EVERY=20
```

### Acronym Expansion

Configure acronyms in `config.js`:
```javascript
acronyms: {
  'TLM': 'Teaching Learning Material',
  'PTM': 'Parent Teacher Meeting',
  'FLN': 'Foundational Literacy and Numeracy',
  'DIET': 'District Institute of Education and Training'
}
```

---

## 🐛 Troubleshooting

### "No API keys provided"
- Check `.env` file exists and has `API_KEYS=...`
- Ensure the key is valid

### "Questions config file not found"
```bash
cp questions-config.example.json questions-config.json
```

### "Column 'Q1' not found"
- Verify CSV has columns matching `column_name` in questions-config.json
- Update `column_name` to match your CSV headers

### Rate Limit Errors
- Add more API keys: `API_KEYS=key1,key2,key3`
- Increase delay: `REQUEST_DELAY=2000`
- Reduce batch size: `BATCH_SIZE=5`

### Process is Slow
- Add more API keys for parallel processing
- Reduce `REQUEST_DELAY` (watch for rate limits)
- Increase `BATCH_SIZE`

### Out of Memory
- Set `MAX_ROWS` to process in chunks
- Reduce `BATCH_SIZE`
- Increase `SAVE_PROGRESS_EVERY`

### Progress Not Resuming
- Check `progress.json` exists
- Verify same input/output paths
- Try clearing: `rm progress.json` and restart

---

## 📊 Monitoring and Logs

### Watch Logs in Real-Time
```bash
tail -f logs/$(date +%Y-%m-%d).log
```

### Check Progress
```bash
cat progress.json
```

### Check Statistics
All scripts output statistics on completion:
- Total rows processed
- Success/error counts
- Time elapsed
- API usage stats

---

## 🗂️ Project Structure

```
test-scripts/
├── 0_pipeline.js                  # Master pipeline
├── 1_improve-grammar.js           # Grammar improvement
├── 3_categorize.js                # AI categorization
├── 4_filter-csv.js                # Data cleaning
├── config.js                      # Central configuration
├── package.json                   # Dependencies
├── .env.example                   # Environment template
├── .env                           # Your configuration (create this)
├── questions-config.example.json  # Example config
├── questions-config.json          # Your config (create this)
├── question-columns.json          # Column mappings
├── question-category-mapping.json # Category mappings
├── setup.sh                       # Setup script
└── utils/                         # Utility modules
    ├── api-manager.js             # API management
    ├── csv-handler.js             # CSV operations
    ├── logger.js                  # Logging system
    ├── progress-tracker.js        # Progress tracking
    └── validator.js               # Validation functions
```

---

## 📝 CSV File Format

Your CSV should have:
- **First row**: Column headers
- **Question columns**: Q1, Q2, Q3, etc. (or custom names)
- **Optional columns**: District, Timestamp, ID, etc.

**Example:**
```csv
District,Timestamp,Q1,Q2,Q3
Gaya,2024-01-15,Started group learning,From training,Made a plan first
Vaishali,2024-01-16,Built new library,Own idea,Just started doing it
```

---

## 🚀 Quick Reference

```bash
# Setup
./setup.sh
nano .env  # Add API keys
cp questions-config.example.json questions-config.json

# Test
echo "MAX_ROWS=5" >> .env
node 3_categorize.js --input data.csv --output test.csv

# Full Run
node 0_pipeline.js --input data.csv --output final.csv

# Resume
node 3_categorize.js --resume

# Get Help
node 3_categorize.js --help
node 1_improve-grammar.js --help
node 4_filter-csv.js --help
node 0_pipeline.js --help
```

---

## 📦 Dependencies

- `@google/generative-ai` - Gemini API client
- `dotenv` - Environment variables
- `papaparse` - CSV parsing

Install with: `npm install`

---

## 🎓 Examples

See `questions-config.example.json` for detailed configuration examples with 3 complete question definitions.

---

## 📄 License

MIT

---

**Ready to analyze feedback! 🎉**

For questions or issues, check the logs in the `logs/` directory or review `progress.json` for processing state.
