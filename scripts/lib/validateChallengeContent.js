// Validates authored MCQ Challenge content (data/mcq-challenges-g1to12.json
// and similar datasets) before it's ever written to Supabase. Returns a list
// of human-readable error strings — empty means the dataset is clean.
//
// This is intentionally standalone (no Supabase dependency) so it can run in
// CI/tests without any network/DB access, and be reused by the seed script
// itself as a pre-flight check before writing anything.

const ALLOWED_DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const ALLOWED_CATEGORIES = [
  'Think & Solve',
  'Logic & Reasoning',
  'Pattern Challenge',
  'Real-World Application',
  'Olympiad Challenge',
  'Advanced Practice',
];
const VALID_GRADES = Array.from({ length: 12 }, (_, i) => `Grade ${i + 1}`);

function normaliseQuestionText(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateChallenge(challenge, index, seenIds, seenQuestionTexts) {
  const errors = [];
  const where = `challenge[${index}]${challenge && challenge.id ? ` (${challenge.id})` : ''}`;

  const requiredStringFields = ['id', 'title', 'grade', 'curriculum', 'subject', 'topic', 'difficulty', 'type', 'category'];
  for (const field of requiredStringFields) {
    if (!challenge || typeof challenge[field] !== 'string' || !challenge[field].trim()) {
      errors.push(`${where}: missing or empty required field "${field}"`);
    }
  }
  if (!challenge) return errors;

  if (challenge.id) {
    if (seenIds.has(challenge.id)) errors.push(`${where}: duplicate challenge id "${challenge.id}"`);
    seenIds.add(challenge.id);
    if (challenge.id.length > 60) errors.push(`${where}: id exceeds 60 chars`);
    if (!/^[a-z0-9_]+$/.test(challenge.id)) errors.push(`${where}: id must be lowercase snake_case (a-z, 0-9, _ only)`);
  }

  if (challenge.grade && !VALID_GRADES.includes(challenge.grade)) {
    errors.push(`${where}: invalid grade "${challenge.grade}" (expected one of ${VALID_GRADES.join(', ')})`);
  }
  if (challenge.difficulty && !ALLOWED_DIFFICULTIES.includes(challenge.difficulty)) {
    errors.push(`${where}: invalid difficulty "${challenge.difficulty}" (expected one of ${ALLOWED_DIFFICULTIES.join(', ')})`);
  }
  if (challenge.category && !ALLOWED_CATEGORIES.includes(challenge.category)) {
    errors.push(`${where}: invalid category "${challenge.category}" (expected one of ${ALLOWED_CATEGORIES.join(', ')})`);
  }
  if (typeof challenge.xp_reward !== 'number' || challenge.xp_reward <= 0) {
    errors.push(`${where}: xp_reward must be a positive number`);
  }
  if (typeof challenge.time_limit_minutes !== 'number' || challenge.time_limit_minutes <= 0) {
    errors.push(`${where}: time_limit_minutes must be a positive number`);
  }

  const questions = Array.isArray(challenge.questions) ? challenge.questions : null;
  if (!questions) {
    errors.push(`${where}: missing "questions" array`);
    return errors;
  }
  if (typeof challenge.question_count !== 'number' || challenge.question_count !== questions.length) {
    errors.push(`${where}: question_count (${challenge.question_count}) does not match the actual number of questions (${questions.length})`);
  }

  questions.forEach((q, qi) => {
    const qWhere = `${where}.questions[${qi}]`;
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      errors.push(`${qWhere}: missing or empty "question" text`);
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      errors.push(`${qWhere}: must have exactly 4 options (found ${q && Array.isArray(q.options) ? q.options.length : 'none'})`);
    } else {
      const uniqOptions = new Set(q.options.map((o) => String(o).trim().toLowerCase()));
      if (uniqOptions.size !== q.options.length) errors.push(`${qWhere}: options contain a duplicate value`);
      if (q.options.some((o) => typeof o !== 'string' || !o.trim())) errors.push(`${qWhere}: an option is empty`);
    }
    if (typeof q.correct !== 'number' || !Array.isArray(q.options) || q.correct < 0 || q.correct >= (q.options ? q.options.length : 0)) {
      errors.push(`${qWhere}: "correct" must be a valid index into "options" (0-based)`);
    }
    if (!q || typeof q.explanation !== 'string' || !q.explanation.trim()) {
      errors.push(`${qWhere}: missing or empty "explanation"`);
    } else if (q.explanation.trim().length < 10) {
      errors.push(`${qWhere}: explanation looks too short to actually explain the reasoning ("${q.explanation}")`);
    }
    if (q && q.question) {
      const norm = normaliseQuestionText(q.question);
      if (seenQuestionTexts.has(norm)) {
        errors.push(`${qWhere}: duplicate/near-duplicate question text (also appears at "${seenQuestionTexts.get(norm)}")`);
      } else {
        seenQuestionTexts.set(norm, qWhere);
      }
    }
  });

  return errors;
}

// Validates an array of challenge objects (each with an embedded `questions`
// array, as authored in data/mcq-challenges-g1to12.json). Returns
// { valid: boolean, errors: string[], summary: {...} }.
function validateChallengeContent(challenges) {
  const errors = [];
  if (!Array.isArray(challenges)) {
    return { valid: false, errors: ['Top-level content must be a JSON array of challenges'], summary: null };
  }

  const seenIds = new Set();
  const seenQuestionTexts = new Map();
  challenges.forEach((c, i) => {
    errors.push(...validateChallenge(c, i, seenIds, seenQuestionTexts));
  });

  const byGrade = {};
  challenges.forEach((c) => {
    if (!c || !c.grade) return;
    byGrade[c.grade] = (byGrade[c.grade] || 0) + 1;
  });

  const summary = {
    totalChallenges: challenges.length,
    totalQuestions: challenges.reduce((sum, c) => sum + (Array.isArray(c && c.questions) ? c.questions.length : 0), 0),
    byGrade,
  };

  return { valid: errors.length === 0, errors, summary };
}

module.exports = { validateChallengeContent, ALLOWED_DIFFICULTIES, ALLOWED_CATEGORIES, VALID_GRADES };
