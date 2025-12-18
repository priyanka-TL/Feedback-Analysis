# Configuration Examples

This guide shows different patterns for configuring questions in `questions-config.json`.

---

## Pattern 1: Single Category with Enum (Strict List)

**Use when:** You have a predefined list of categories and want strict selection.

**Example:** Q3, Q4

```json
{
  "id": "q3",
  "csv_column": "Q3. Can you tell us about one change in your school that is close to you? How did you make it happen?",
  "question_text": "Can you tell us about one change in your school that is close to you? How did you make it happen?",
  "allow_multiple_categories": false,
  "allow_new_categories": false,
  "response_fields": [
    {
      "name": "category",
      "type": "enum",
      "description": "Either 'Steps Mentioned' or 'Steps Not Mentioned'",
      "enum": ["Steps Mentioned", "Steps Not Mentioned"]
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Brief explanation of the categorization"
    }
  ],
  "categorization_criteria": "CATEGORY DEFINITIONS (Choose ONE):\n\n**Steps Mentioned**\nDefinition: ...\n\n**Steps Not Mentioned**\nDefinition: ..."
}
```

**Output Columns:**
- `q3_category`
- `q3_reasoning`
- `q3_processing_status`
- `q3_error_message`

**Output Example:**
```
q3_category: "Steps Mentioned"
q3_reasoning: "Response describes specific actions taken to implement the change"
```

---

## Pattern 2: Multiple Categories (Flexible)

**Use when:** Responses can fit multiple categories simultaneously.

**Example:** Q2, Q5, Q6, Q7, Q8

```json
{
  "id": "q2",
  "csv_column": "Q2. How did you get the idea to make this change?",
  "question_text": "How did you get the idea to make this change?",
  "allow_multiple_categories": true,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "categories",
      "type": "array",
      "description": "List of categories from: Trainings & peer learning, Self-observation and self-motivation, System directives and resources (PBL specific), Suggested/Supported by Parents or Community, Other"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Brief explanation of the categorization"
    }
  ],
  "categorization_criteria": "CATEGORY DEFINITIONS (Can select MULTIPLE):\n\n**System directives and resources (PBL specific)**\nDefinition: ...\n\n**Trainings & peer learning**\nDefinition: ..."
}
```

**Output Columns:**
- `q2_categories` (semicolon-separated)
- `q2_reasoning`
- `q2_new_category_suggested`
- `q2_processing_status`
- `q2_error_message`

**Output Example:**
```
q2_categories: "Trainings & peer learning; Self-observation and self-motivation"
q2_reasoning: "Teacher mentioned both formal training and personal observation of students"
```

---

## Pattern 3: Dual Categories (Two Dimensions)

**Use when:** You need to categorize on two independent dimensions.

**Example:** Q1

```json
{
  "id": "q1",
  "csv_column": "Q1. In the last 6 to 12 months, what do you think are some important changes in your school?",
  "question_text": "In the last 6 to 12 months, what do you think are some important changes in your school?",
  "allow_multiple_categories": false,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "category_1",
      "type": "string",
      "description": "Single category from: Classroom, Student, Teacher, School, Parental Engagement, Not Identified"
    },
    {
      "name": "category_2",
      "type": "enum",
      "description": "Either PBL, Non-PBL or Not Identified",
      "enum": ["PBL", "Non-PBL", "Not Identified"]
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Brief explanation of the categorization"
    }
  ],
  "categorization_criteria": "CATEGORY 1 DEFINITIONS:\n\n**Classroom**\nDefinition: ...\n\nCATEGORY 2 DEFINITIONS:\n\n**PBL**\nDefinition: ..."
}
```

**Output Columns:**
- `q1_category_1`
- `q1_category_2`
- `q1_reasoning`
- `q1_new_category_suggested`
- `q1_processing_status`
- `q1_error_message`

**Output Example:**
```
q1_category_1: "Student"
q1_category_2: "PBL"
q1_reasoning: "Describes student learning improvements through project-based methods"
```

---

## Pattern 4: Open-Ended with Suggested Categories

**Use when:** You have suggested categories but want AI to discover new ones.

```json
{
  "id": "q_open",
  "csv_column": "Q_Open. What innovative practices have you tried?",
  "question_text": "What innovative practices have you tried?",
  "allow_multiple_categories": true,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "categories",
      "type": "array",
      "description": "List of innovative practices. Suggested: Technology Integration, Collaborative Learning, Assessment Innovation, Community Engagement"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Brief explanation"
    }
  ],
  "categorization_criteria": "SUGGESTED CATEGORIES (as guidance):\n\n- Technology Integration: ...\n- Collaborative Learning: ...\n- Assessment Innovation: ...\n- Community Engagement: ...\n\nYou may suggest new categories if the response doesn't fit these well."
}
```

**Benefit:** AI can discover patterns you didn't anticipate.

---

## Pattern 5: Yes/No/Maybe Binary Classification

**Use when:** Simple binary or ternary classification.

```json
{
  "id": "q_binary",
  "csv_column": "Q_Binary. Have you implemented the recommended practices?",
  "question_text": "Have you implemented the recommended practices?",
  "allow_multiple_categories": false,
  "allow_new_categories": false,
  "response_fields": [
    {
      "name": "category",
      "type": "enum",
      "description": "Implementation status",
      "enum": ["Fully Implemented", "Partially Implemented", "Not Implemented", "Not Applicable"]
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Evidence for classification"
    }
  ],
  "categorization_criteria": "CLASSIFICATION:\n\n**Fully Implemented**: Clear evidence of complete adoption\n**Partially Implemented**: Some elements adopted\n**Not Implemented**: No evidence of adoption\n**Not Applicable**: Question doesn't apply to this respondent"
}
```

---

## Pattern 6: Sentiment Analysis

**Use when:** You want to capture emotional tone or attitude.

```json
{
  "id": "q_sentiment",
  "csv_column": "Q_Sentiment. What are your thoughts on the new policy?",
  "question_text": "What are your thoughts on the new policy?",
  "allow_multiple_categories": false,
  "allow_new_categories": false,
  "response_fields": [
    {
      "name": "sentiment",
      "type": "enum",
      "description": "Overall sentiment",
      "enum": ["Very Positive", "Positive", "Neutral", "Negative", "Very Negative"]
    },
    {
      "name": "themes",
      "type": "array",
      "description": "Key themes mentioned"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Justification for sentiment classification"
    }
  ],
  "categorization_criteria": "SENTIMENT ANALYSIS:\n\nAssess the overall tone and identify key themes.\n\n**Very Positive**: Enthusiastic support, excitement\n**Positive**: General agreement, approval\n**Neutral**: Mixed or balanced view\n**Negative**: Disagreement, concerns\n**Very Negative**: Strong opposition, frustration"
}
```

---

## Pattern 7: Hierarchical Categories

**Use when:** Categories have parent-child relationships.

```json
{
  "id": "q_hierarchical",
  "csv_column": "Q_Hierarchical. What type of resource do you need?",
  "question_text": "What type of resource do you need?",
  "allow_multiple_categories": true,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "primary_category",
      "type": "enum",
      "description": "Main resource type",
      "enum": ["Human Resources", "Material Resources", "Financial Resources", "Infrastructure"]
    },
    {
      "name": "sub_categories",
      "type": "array",
      "description": "Specific items within the primary category"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Explanation"
    }
  ],
  "categorization_criteria": "PRIMARY CATEGORIES:\n\n**Human Resources**\nSub-categories: Teachers, Support Staff, Specialists, Volunteers\n\n**Material Resources**\nSub-categories: Books, Equipment, Supplies, Technology\n\n..."
}
```

**Output Example:**
```
primary_category: "Material Resources"
sub_categories: "Books; Technology; Supplies"
```

---

## Pattern 8: Frequency/Intensity Rating

**Use when:** You want to capture how often or how much.

```json
{
  "id": "q_frequency",
  "csv_column": "Q_Frequency. How often do you use technology in teaching?",
  "question_text": "How often do you use technology in teaching?",
  "allow_multiple_categories": false,
  "allow_new_categories": false,
  "response_fields": [
    {
      "name": "frequency",
      "type": "enum",
      "description": "Frequency of use",
      "enum": ["Daily", "Weekly", "Monthly", "Rarely", "Never"]
    },
    {
      "name": "technologies_used",
      "type": "array",
      "description": "List of technologies mentioned"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Evidence for frequency assessment"
    }
  ],
  "categorization_criteria": "FREQUENCY DEFINITIONS:\n\n**Daily**: Every day or almost every day\n**Weekly**: Multiple times per week\n**Monthly**: A few times per month\n**Rarely**: Once in a while\n**Never**: Not at all"
}
```

---

## Pattern 9: Multi-Dimensional with Confidence

**Use when:** You want nuanced classification with confidence levels.

```json
{
  "id": "q_confident",
  "csv_column": "Q_Confident. What is the main impact mentioned?",
  "question_text": "What is the main impact mentioned?",
  "allow_multiple_categories": false,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "primary_impact",
      "type": "string",
      "description": "Main impact category"
    },
    {
      "name": "confidence",
      "type": "enum",
      "description": "Confidence in classification",
      "enum": ["High", "Medium", "Low"]
    },
    {
      "name": "secondary_impacts",
      "type": "array",
      "description": "Other impacts mentioned"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Justification"
    }
  ],
  "categorization_criteria": "Identify the PRIMARY impact and assess your confidence:\n\n**High Confidence**: Impact is explicitly stated\n**Medium Confidence**: Impact is implied or inferred\n**Low Confidence**: Impact is ambiguous or unclear"
}
```

---

## Pattern 10: Extraction with Classification

**Use when:** You want to both extract specific information and classify it.

```json
{
  "id": "q_extract",
  "csv_column": "Q_Extract. What specific activities were mentioned?",
  "question_text": "What specific activities were mentioned?",
  "allow_multiple_categories": true,
  "allow_new_categories": false,
  "response_fields": [
    {
      "name": "activities",
      "type": "array",
      "description": "List of specific activities mentioned (extracted verbatim)"
    },
    {
      "name": "activity_types",
      "type": "array",
      "description": "Classification of activities",
      "enum": ["Academic", "Extracurricular", "Community", "Administrative"]
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "How activities were classified"
    }
  ],
  "categorization_criteria": "INSTRUCTIONS:\n1. Extract all specific activities mentioned\n2. Classify each into activity types\n\n**Academic**: Related to curriculum\n**Extracurricular**: Beyond regular classes\n**Community**: Involving parents/community\n**Administrative**: Management/organization"
}
```

**Output Example:**
```
activities: "Reading club; Math competition; Parent meeting"
activity_types: "Academic; Academic; Community"
```

---

## Customization Tips

### 1. Adjusting Strictness

**Very Strict** (no flexibility):
```json
{
  "allow_multiple_categories": false,
  "allow_new_categories": false,
  "response_fields": [
    {
      "type": "enum",
      "enum": ["Option A", "Option B", "Option C"]
    }
  ]
}
```

**Very Flexible** (maximum discovery):
```json
{
  "allow_multiple_categories": true,
  "allow_new_categories": true,
  "response_fields": [
    {
      "type": "array",
      "description": "Any relevant categories"
    }
  ]
}
```

### 2. Keywords vs. Definitions

**Keyword-heavy** (for pattern matching):
```json
{
  "categorization_criteria": "**Category A**\nKeywords: word1, word2, word3, word4, word5\n\n**Category B**\nKeywords: word6, word7, word8"
}
```

**Definition-heavy** (for semantic understanding):
```json
{
  "categorization_criteria": "**Category A**\nDefinition: This category applies when the response describes a situation where...\nExamples:\n- Example 1\n- Example 2"
}
```

**Balanced** (recommended):
```json
{
  "categorization_criteria": "**Category A**\nDefinition: Clear definition here\nKeywords: relevant, keywords, here\nExamples:\n- \"Example response 1\"\n- \"Example response 2\""
}
```

### 3. Handling Edge Cases

Add explicit guidance:
```json
{
  "categorization_criteria": "CATEGORIES:\n\n**Category A**: ...\n**Category B**: ...\n\nEDGE CASES:\n- If response mentions both A and B, choose whichever is emphasized more\n- If response is vague, choose 'Not Identified'\n- If response is off-topic, choose 'Not Applicable'"
}
```

---

## Testing Your Configuration

### Quick Test

1. Create a minimal config with just one question:
```json
{
  "questions": [
    {
      "id": "test",
      "csv_column": "Your_Column_Name",
      "question_text": "Your question?",
      "allow_multiple_categories": false,
      "allow_new_categories": false,
      "response_fields": [
        {
          "name": "category",
          "type": "enum",
          "enum": ["Cat A", "Cat B"]
        },
        {
          "name": "reasoning",
          "type": "string",
          "description": "Why"
        }
      ],
      "categorization_criteria": "**Cat A**: Definition\n**Cat B**: Definition"
    }
  ]
}
```

2. Run on 5 rows:
```javascript
MAX_ROWS: 5
```

3. Check output quality

4. Refine criteria if needed

5. Add more questions

---

## Common Mistakes

### ❌ Mistake 1: Column Name Mismatch
```json
{
  "csv_column": "Q1. Changes in school?"  // ← Wrong!
}
```
**Fix:** Use EXACT column name from CSV (check with `head -1 input.csv`)

### ❌ Mistake 2: Ambiguous Criteria
```json
{
  "categorization_criteria": "Category A: Good\nCategory B: Bad"
}
```
**Fix:** Be specific about what "good" and "bad" mean

### ❌ Mistake 3: Too Many Categories
```json
{
  "enum": ["Cat1", "Cat2", "Cat3", ..., "Cat15"]  // 15 categories!
}
```
**Fix:** Group into 3-5 main categories with sub-categories if needed

### ❌ Mistake 4: Missing Reasoning Field
```json
{
  "response_fields": [
    {
      "name": "category",
      "type": "enum",
      "enum": ["A", "B"]
    }
    // Missing reasoning field!
  ]
}
```
**Fix:** Always include a reasoning field for transparency

---

## Full Example: Complete Question Config

```json
{
  "id": "q_complete",
  "csv_column": "Q_Complete. What improvements have you seen in student learning?",
  "question_text": "What improvements have you seen in student learning?",
  "allow_multiple_categories": true,
  "allow_new_categories": true,
  "response_fields": [
    {
      "name": "categories",
      "type": "array",
      "description": "Learning improvement areas: Academic Performance, Engagement, Critical Thinking, Collaboration, Creativity"
    },
    {
      "name": "reasoning",
      "type": "string",
      "description": "Evidence from the response"
    }
  ],
  "categorization_criteria": "CATEGORY DEFINITIONS (Can select MULTIPLE):\n\n**Academic Performance**\nDefinition: Improvements in test scores, grades, or subject mastery\nKeywords: marks, scores, grades, performance, tests, exams, academic\nExamples:\n- \"Students' test scores have improved\"\n- \"Children are doing better in math\"\n\n**Engagement**\nDefinition: Increased participation, interest, or attendance\nKeywords: participation, interest, attention, attendance, engagement, involved\nExamples:\n- \"Students are more interested in learning\"\n- \"Attendance has improved\"\n\n**Critical Thinking**\nDefinition: Better questioning, analysis, or problem-solving\nKeywords: questions, analysis, thinking, problem-solving, reasoning\nExamples:\n- \"Students ask more questions\"\n- \"They can analyze problems better\"\n\n**Collaboration**\nDefinition: Improved teamwork or peer learning\nKeywords: teamwork, group work, collaboration, cooperation, peer learning\nExamples:\n- \"Children work better in groups\"\n- \"Students help each other\"\n\n**Creativity**\nDefinition: More creative expression or innovative thinking\nKeywords: creativity, innovation, ideas, imagination, creative\nExamples:\n- \"Students come up with creative solutions\"\n- \"Children express themselves more creatively\"\n\nEDGE CASES:\n- If multiple areas mentioned, select all that apply\n- If improvement is vague (\"things are better\"), use 'Not Identified'\n- If suggesting a new category, ensure it's distinct from the above"
}
```

---

## Next Steps

1. **Copy** the pattern that fits your question type
2. **Customize** the fields and criteria
3. **Test** on 5 rows
4. **Refine** based on results
5. **Scale** to full dataset

Happy configuring! 🎯
