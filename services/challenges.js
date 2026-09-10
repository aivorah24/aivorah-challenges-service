const fs       = require('fs');
const path     = require('path');
const supabase = require('./supabase');
const { sendPush } = require('./push');

const CLOUDINARY_URLS = path.join(__dirname, '../data/cloudinary_urls.json');

function readCloudinaryUrls() { try { return JSON.parse(fs.readFileSync(CLOUDINARY_URLS, 'utf8')); } catch { return {}; } }

// Map snake_case DB row → camelCase challenge object
function rowToChallenge(row) {
  return {
    id:               row.id,
    title:            row.title,
    description:      row.description,
    subject:          row.subject,
    topic:            row.topic || '',
    grade:            row.grade,
    curriculum:       row.curriculum,
    category:         row.category,
    difficulty:       row.difficulty,
    xpReward:         row.xp_reward,
    questionCount:    row.question_count,
    timeLimitMinutes: row.time_limit_minutes,
    type:             row.type || '',
    tags:             row.tags,
    isPublished:      row.is_published,
    created_at:       row.created_at,
    thumbnailUrl:     row.thumbnail_url || null,
  };
}

// Fetch all challenges with an optional grade filter. Every row in this
// table is seeded common content (curriculum: "CBSE") - there is no
// teacher-created/curriculum-specific challenge path - so filtering by the
// caller's own curriculum (IB PYP, NCERT, ...) only ever excluded every
// seeded challenge. Grade still filters normally.
async function getChallenges(grade, curriculum) {
  let query = supabase.from('challenges').select('*').eq('is_published', true);
  if (grade) query = query.eq('grade', grade);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(rowToChallenge);
}

// Fetch a single challenge by id
async function getChallengeById(id) {
  const { data, error } = await supabase.from('challenges').select('*').eq('id', id).single();
  if (error || !data) return null;
  return rowToChallenge(data);
}

// Map snake_case DB row → camelCase question object
function rowToQuestion(row) {
  return {
    question:     row.question,
    options:      row.options || [],
    correct:      row.correct,
    explanation:  row.explanation || '',
    questionType: row.question_type || 'mcq',
    acceptAnswers: row.accept_answers || null,
  };
}

// Fetch the predefined MCQs for a challenge, in authoring order. Pure DB
// read — no AI-generation fallback here by design (see BUGS_AND_FIXES.md /
// the Challenges content-population plan): curated NCERT challenges must
// serve instantly with zero generation latency. Returns [] if none are
// seeded yet for this challenge, letting the caller decide the fallback.
async function getChallengeQuestions(challengeId) {
  const { data, error } = await supabase
    .from('challenge_questions')
    .select('*')
    .eq('challenge_id', challengeId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToQuestion);
}

function attachImageUrl(challenge) {
  const urlMap = readCloudinaryUrls();
  // Try exact key first
  const key = `challenges/${challenge.id}.png`;
  if (urlMap[key]) return { ...challenge, imageUrl: urlMap[key] };

  // Check if local file exists
  const localPath = path.join(__dirname, `../data/images/challenges/${challenge.id}.png`);
  if (fs.existsSync(localPath)) {
    return { ...challenge, imageUrl: `/data/images/challenges/${challenge.id}.png` };
  }

  return { ...challenge, imageUrl: null };
}

function computeLevel(xp) {
  let level = 1, threshold = 500, total = 0;
  while (xp >= total + threshold) { total += threshold; threshold += 250; level++; }
  return level;
}

// A due_date is a plain 'YYYY-MM-DD' date with no time — the schedule always
// shows deadlines as closing at 23:59 that day, so "closed" means past that.
function isPastDue(dueDate) {
  if (!dueDate) return false;
  return new Date() > new Date(`${dueDate}T23:59:59`);
}

// Push-notify the targeted student + their parent on mobile, and create a
// system message for parents (the bell reads "New Challenge assigned:"
// messages for parents — without this they never see a notification even
// with "Challenge Updates" enabled). Both are best-effort/non-blocking.
async function notifyChallengeAssigned({ challenge, studentId, assignmentId, dueDate }) {
  try {
    const { data: stu } = await supabase.from('users').select('email').eq('id', studentId).maybeSingle();
    const { data: links } = await supabase.from('parent_children').select('parent_email').eq('child_id', studentId);
    const emails = [stu?.email, ...((links ?? []).map(l => l.parent_email))].filter(Boolean);
    if (emails.length) {
      await sendPush(emails, {
        title: `New challenge: ${challenge.title}`,
        body: dueDate ? `Due ${new Date(dueDate).toLocaleDateString()}` : 'Tap to view',
        data: { type: 'challenge', challengeId: challenge.id, assignmentId },
        prefKey: 'challengeUpdates',
      });
    }
  } catch (_) { /* push is best-effort */ }

  try {
    const { data: parents } = await supabase
      .from('parent_children')
      .select('parent_email')
      .eq('child_id', studentId);
    if (parents && parents.length > 0) {
      const { data: student } = await supabase
        .from('users').select('name').eq('id', studentId).maybeSingle();
      const studentName = student?.name || 'your child';
      const dueDateStr = dueDate ? new Date(dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'TBD';
      const msgContent = 'New Challenge assigned: "' + (challenge.title || 'Challenge') + '"'
        + (challenge.subject ? ' (' + challenge.subject + ')' : '')
        + ' has been assigned to ' + studentName + '. Due: ' + dueDateStr + '.';
      for (const { parent_email } of parents) {
        await supabase.from('messages').insert({
          sender_email:   'system@aivorah.com',
          sender_name:    'Aivorah',
          sender_role:    'teacher',
          recipient_email: parent_email,
          recipient_name:  parent_email,
          content:        msgContent,
        });
      }
    }
  } catch (e) {
    console.warn('[challenges] Parent notification failed (non-fatal):', e.message);
  }
}

module.exports = {
  getChallenges,
  getChallengeById,
  getChallengeQuestions,
  attachImageUrl,
  computeLevel,
  isPastDue,
  notifyChallengeAssigned,
};
