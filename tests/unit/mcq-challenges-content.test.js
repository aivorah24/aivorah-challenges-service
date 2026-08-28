// Validates the real authored NCERT Challenge dataset (data/mcq-challenges-g1to12.json)
// — the 60 predefined challenges (5 per grade, Grade 1-12) seeded via
// scripts/seed-mcq-challenges-g1to12.js. This is a real regression test: if
// anyone edits the dataset and breaks a rule (wrong option count, duplicate
// question, invalid grade, etc.), this test fails before it ever reaches Supabase.

const fs = require('fs');
const path = require('path');
const { validateChallengeContent, ALLOWED_DIFFICULTIES, ALLOWED_CATEGORIES, VALID_GRADES } = require('../../scripts/lib/validateChallengeContent');

const DATA_PATH = path.join(__dirname, '../../data/mcq-challenges-g1to12.json');

describe('mcq-challenges-g1to12.json — real content validation', () => {
  let content;

  beforeAll(() => {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    content = JSON.parse(raw);
  });

  test('the dataset passes full structural + content validation with zero errors', () => {
    const { valid, errors } = validateChallengeContent(content);
    if (!valid) {
      throw new Error(`Content validation failed:\n${errors.join('\n')}`);
    }
    expect(valid).toBe(true);
  });

  test('has exactly 60 challenges — 5 for each of Grade 1 through Grade 12', () => {
    expect(content).toHaveLength(60);
    const byGrade = {};
    content.forEach((c) => { byGrade[c.grade] = (byGrade[c.grade] || 0) + 1; });
    VALID_GRADES.forEach((grade) => {
      expect(byGrade[grade]).toBe(5);
    });
  });

  test('every question has exactly 4 options and exactly 1 valid correct-answer index', () => {
    content.forEach((c) => {
      c.questions.forEach((q) => {
        expect(q.options).toHaveLength(4);
        expect(q.correct).toBeGreaterThanOrEqual(0);
        expect(q.correct).toBeLessThan(4);
      });
    });
  });

  test('every challenge id is globally unique', () => {
    const ids = content.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('no duplicate/near-duplicate question text exists anywhere in the dataset', () => {
    const seen = new Set();
    const dupes = [];
    content.forEach((c) => {
      c.questions.forEach((q) => {
        const norm = String(q.question).trim().toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(norm)) dupes.push(q.question);
        seen.add(norm);
      });
    });
    expect(dupes).toEqual([]);
  });

  test('every challenge uses an allowed difficulty and category', () => {
    content.forEach((c) => {
      expect(ALLOWED_DIFFICULTIES).toContain(c.difficulty);
      expect(ALLOWED_CATEGORIES).toContain(c.category);
    });
  });

  test('question_count matches the actual number of authored questions for every challenge', () => {
    content.forEach((c) => {
      expect(c.questions).toHaveLength(c.question_count);
    });
  });

  test('every explanation is non-trivial (explains the reasoning, not just restates the answer)', () => {
    content.forEach((c) => {
      c.questions.forEach((q) => {
        expect(q.explanation.trim().length).toBeGreaterThanOrEqual(10);
      });
    });
  });

  test('question counts scale with grade band as specified (1-2: 5, 3-5: 5-6, 6-8: 6-7, 9-10: 7-8, 11-12: 8)', () => {
    const expectedRange = {
      'Grade 1': [5, 5], 'Grade 2': [5, 5],
      'Grade 3': [5, 6], 'Grade 4': [5, 6], 'Grade 5': [5, 6],
      'Grade 6': [6, 7], 'Grade 7': [6, 7], 'Grade 8': [6, 7],
      'Grade 9': [7, 8], 'Grade 10': [7, 8],
      'Grade 11': [8, 8], 'Grade 12': [8, 8],
    };
    content.forEach((c) => {
      const [min, max] = expectedRange[c.grade];
      expect(c.question_count).toBeGreaterThanOrEqual(min);
      expect(c.question_count).toBeLessThanOrEqual(max);
    });
  });
});
