/**
 * Seeds the 60 predefined NCERT Challenge quizzes (Grade 1-12, 5 per grade)
 * into THIS service's own Supabase project — `challenges` + `challenge_questions`
 * tables, read by GET /challenges and the new GET /challenges/:id/questions.
 *
 * These are curated, pre-authored MCQs — no AI-generation dependency, no
 * monolith involvement. Content lives in data/mcq-challenges-g1to12.json.
 *
 * Usage:
 *   node scripts/seed-mcq-challenges-g1to12.js                 # dry run — validates + prints a summary, writes nothing
 *   node scripts/seed-mcq-challenges-g1to12.js --validate-only  # validation only, no DB connection needed
 *   node scripts/seed-mcq-challenges-g1to12.js --commit         # validates, then upserts into Supabase
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { validateChallengeContent } = require('./lib/validateChallengeContent');

const DATA_PATH = path.join(__dirname, '../data/mcq-challenges-g1to12.json');

function loadContent() {
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}

function toChallengeRow(c) {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    grade: c.grade,
    curriculum: c.curriculum,
    subject: c.subject,
    topic: c.topic,
    difficulty: c.difficulty,
    xp_reward: c.xp_reward,
    question_count: c.question_count,
    time_limit_minutes: c.time_limit_minutes,
    type: c.type,
    category: c.category,
    is_published: c.is_published !== false,
    thumbnail_url: c.thumbnail_url || null,
  };
}

function toQuestionRows(c) {
  return c.questions.map((q, i) => ({
    challenge_id: c.id,
    question: q.question,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
    sort_order: i,
    question_type: q.question_type || 'mcq',
    accept_answers: q.accept_answers || null,
  }));
}

async function main() {
  const commit = process.argv.includes('--commit');
  const validateOnly = process.argv.includes('--validate-only');

  const content = loadContent();
  const { valid, errors, summary } = validateChallengeContent(content);

  console.log(`Loaded ${summary.totalChallenges} challenges, ${summary.totalQuestions} questions from ${path.relative(process.cwd(), DATA_PATH)}`);
  console.log('By grade:', JSON.stringify(summary.byGrade, null, 2));

  if (!valid) {
    console.error(`\n❌ Validation FAILED — ${errors.length} error(s):\n`);
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log('✅ Content validation passed — 4 options, 1 correct answer, no duplicates, valid grade/subject/difficulty/category on every entry.');

  if (validateOnly) {
    console.log('\n--validate-only: stopping here, no DB connection made.');
    process.exit(0);
  }

  const challengeRows = content.map(toChallengeRow);
  const questionRows = content.flatMap(toQuestionRows);

  if (!commit) {
    console.log(`\nDRY RUN — would upsert ${challengeRows.length} challenges + ${questionRows.length} questions.`);
    console.log('Sample challenge row:', JSON.stringify(challengeRows[0], null, 2));
    console.log('Sample question row:', JSON.stringify(questionRows[0], null, 2));
    console.log('\nPass --commit to actually write to Supabase (targets whatever SUPABASE_URL is set in .env).');
    process.exit(0);
  }

  // Only require supabase (and its env vars) when we're actually about to write.
  const supabase = require('../services/supabase');
  console.log(`\nCommitting to Supabase project: ${(process.env.SUPABASE_URL || '(unset)').replace(/^https:\/\//, '')}`);

  for (let i = 0; i < challengeRows.length; i += 50) {
    const batch = challengeRows.slice(i, i + 50);
    const { error } = await supabase.from('challenges').upsert(batch, { onConflict: 'id' });
    if (error) { console.error('❌ challenges upsert error:', error.message); process.exit(1); }
  }
  console.log(`✅ Upserted ${challengeRows.length} challenges.`);

  // challenge_questions has no natural unique key to upsert on cleanly across
  // re-runs, so replace this seed's questions wholesale: delete any existing
  // rows for these challenge_ids, then insert fresh. Safe to re-run.
  const challengeIds = content.map((c) => c.id);
  const { error: delError } = await supabase.from('challenge_questions').delete().in('challenge_id', challengeIds);
  if (delError) { console.error('❌ challenge_questions delete error:', delError.message); process.exit(1); }

  for (let i = 0; i < questionRows.length; i += 50) {
    const batch = questionRows.slice(i, i + 50);
    const { error } = await supabase.from('challenge_questions').insert(batch);
    if (error) { console.error('❌ challenge_questions insert error:', error.message); process.exit(1); }
  }
  console.log(`✅ Inserted ${questionRows.length} questions.`);
  console.log('\n🎉 Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err.message);
  process.exit(1);
});
