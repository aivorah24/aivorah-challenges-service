const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const {
  getChallenges,
  getChallengeById,
  getChallengeQuestions,
  attachImageUrl,
  computeLevel,
  isPastDue,
  notifyChallengeAssigned,
} = require('../services/challenges');
const { challengeAssignedEvent, createNotificationEvent, clearNotificationsForEntity } = require('../services/notify');

function uuidv4() { return require('crypto').randomUUID(); }

async function respondAlreadyAssigned(res, challengeId, studentId) {
  const { data: current, error } = await supabase
    .from('challenge_assignments')
    .select('*')
    .eq('challenge_id', challengeId)
    .eq('student_id', studentId)
    .maybeSingle();
  if (error || !current) return res.status(409).json({ error: 'Assignment changed concurrently, please retry.' });
  return res.json({ ...current, assignmentId: current.id, alreadyAssigned: true });
}

// Verifies parentEmail actually has a parent_children link to studentId
// (same table/columns aivorah-students-service's GET /parent/:email/children
// and teacher.js's linking logic use: parent_email, child_id). Returns false
// on any lookup error too - fail closed, not open, for an ownership check.
async function isParentLinkedToStudent(parentEmail, studentId) {
  if (!parentEmail || !studentId) return false;
  const { data, error } = await supabase
    .from('parent_children')
    .select('child_id')
    .eq('parent_email', parentEmail.toLowerCase().trim())
    .eq('child_id', studentId)
    .maybeSingle();
  return !error && !!data;
}

// ── GET /challenges?grade=Grade3&curriculum=NCERT&studentId=xxx&parentEmail=xxx ──
//
// Ownership check, added 2026-09-02, corrected same day: the original
// version 403'd any studentId-scoped request that lacked parentEmail,
// which wrongly assumed only the parent screen ever sends studentId here.
// It does not - src/screens/student/challenges/hooks/useChallengesList.ts
// imports this same service's URL (aliased locally as SERVER_URL, hence
// missed by an initial grep for the literal name) and calls this route with
// studentId and no parentEmail, so that broke every real student's
// Challenges screen in production. There's no session/auth layer on this
// service at all, so parentEmail is a self-reported claim, not a verified
// identity - the only thing this check can honestly gate is "if you claim
// to be a parent, you must actually be linked to this child." A caller
// that sends no parentEmail is making no ownership claim to police, so it
// gets the same unrestricted merge every non-parent caller always got.
router.get('/', async (req, res) => {
  const { grade, curriculum = 'NCERT', studentId, parentEmail } = req.query;
  let challenges;
  try { challenges = await getChallenges(grade, curriculum); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  if (!studentId) return res.json(challenges.map(attachImageUrl));

  if (parentEmail && !(await isParentLinkedToStudent(parentEmail, studentId))) {
    return res.status(403).json({ error: 'Not authorized for this student' });
  }

  const { data: assignments } = await supabase
    .from('challenge_assignments')
    .select('*')
    .eq('student_id', studentId);

  const asgMap = {};
  (assignments ?? []).forEach(a => { asgMap[a.challenge_id] = a; });

  const result = challenges.map(c => {
    const a = asgMap[c.id];
    return {
      ...attachImageUrl(c),
      assignmentId:   a?.id             ?? null,
      status:         a?.status         ?? 'available',
      score:          a?.score          ?? null,
      xpAwarded:      a?.xp_awarded     ?? null,
      dueDate:        a?.due_date       ?? null,
      closed:         a?.due_date ? isPastDue(a.due_date) : false,
      assignedByRole: a?.assigned_by_role ?? null,
    };
  });
  res.json(result);
});

// ── GET /challenges/assigned?studentId=xxx ───────────────────────

router.get('/assigned', async (req, res) => {
  const { studentId } = req.query;
  if (!studentId) return res.status(400).json({ error: 'studentId required' });

  const { data: assignments } = await supabase
    .from('challenge_assignments')
    .select('*')
    .eq('student_id', studentId);

  let challenges;
  try { challenges = await getChallenges(); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  const result = (assignments ?? []).map(a => {
    const ch = challenges.find(c => c.id === a.challenge_id);
    if (!ch) return null;
    return { ...attachImageUrl(ch), assignmentId: a.id, status: a.status, score: a.score, xpAwarded: a.xp_awarded, dueDate: a.due_date, closed: isPastDue(a.due_date), assignedByRole: a.assigned_by_role };
  }).filter(Boolean);

  res.json(result);
});

// ── GET /challenges/assigned-by?assignedById=email ───────────────
// Lets the teacher screen show which students already have each challenge.
router.get('/assigned-by', async (req, res) => {
  const assignedById = (req.query.assignedById || '').trim();
  if (!assignedById) return res.status(400).json({ error: 'assignedById required' });

  const { data, error } = await supabase
    .from('challenge_assignments')
    .select('challenge_id, student_id, status, due_date')
    .eq('assigned_by_id', assignedById);
  if (error) return res.status(500).json({ error: error.message });

  res.json((data ?? []).map(a => ({
    challengeId: a.challenge_id, studentId: a.student_id, status: a.status, dueDate: a.due_date,
  })));
});

// ── GET /challenges/new-count?studentId=xxx&since=ISO_DATE ──────
router.get('/new-count', async (req, res) => {
  const { studentId, since } = req.query;
  if (!studentId) return res.status(400).json({ error: 'studentId required' });

  // Resolve email → UUID if needed
  let resolvedId = studentId;
  if (studentId.includes('@')) {
    const { data: userRow } = await supabase.from('users').select('id').eq('email', studentId.toLowerCase().trim()).maybeSingle();
    if (!userRow?.id) return res.json({ count: 0 });
    resolvedId = userRow.id;
  }

  let query = supabase
    .from('challenge_assignments')
    .select('id')
    .eq('student_id', resolvedId)
    .neq('status', 'completed');

  if (since) query = query.gt('created_at', since);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: (data || []).length });
});

// ── POST /challenges/assign ──────────────────────────────────────

router.post('/assign', async (req, res) => {
  const { challengeId, studentId, assignedById, assignedByRole = 'teacher', dueDate } = req.body;
  if (!challengeId || !studentId) return res.status(400).json({ error: 'challengeId and studentId required' });

  // Ownership check (parent role only, added 2026-09-02, same gap/fix as
  // GET / above). assignedById already carries the parent's email for
  // parent-role assigns (see aivorah-frontend's parentChallengesService.ts)
  // - teacher/student assigns are untouched, no assignedById-as-email
  // assumption holds for those roles.
  if (assignedByRole === 'parent' && !(await isParentLinkedToStudent(assignedById, studentId))) {
    return res.status(403).json({ error: 'Not authorized for this student' });
  }

  const challengeCheck = await getChallengeById(challengeId);
  if (!challengeCheck) return res.status(404).json({ error: 'Challenge not found' });

  // Grade guard: a challenge may only be assigned to a student in the SAME grade.
  // Prevents a Grade 4 challenge landing on a Grade 6 student (client filter bypass).
  if (challengeCheck.grade) {
    const normGrade = (g) => String(g || '').toLowerCase().replace(/grade/g, '').replace(/\s+/g, '').trim();
    const { data: stu } = await supabase
      .from('users')
      .select('grade')
      .eq('id', studentId)
      .maybeSingle();
    if (stu && stu.grade && normGrade(stu.grade) !== normGrade(challengeCheck.grade)) {
      return res.status(400).json({
        error: `This challenge is for ${challengeCheck.grade}, but the student is in ${stu.grade}.`,
      });
    }
  }

  // Return existing if already assigned AND still pending — this is the
  // idempotent "already assigned" case, not a re-assignment.
  const { data: existing } = await supabase
    .from('challenge_assignments')
    .select('*')
    .eq('challenge_id', challengeId)
    .eq('student_id', studentId)
    .single();
  if (existing && existing.status !== 'completed') {
    // alreadyAssigned tells the client this was a no-op (no new notification
    // was sent) so it can show "Already assigned" instead of implying a
    // fresh assignment just went out.
    return res.json({ ...existing, assignmentId: existing.id, alreadyAssigned: true });
  }

  let data, error;
  if (existing && existing.status === 'completed') {
    // Re-assigning a challenge the student already completed (e.g. a retry) used
    // to just return the old completed row untouched — no new due date, no
    // schedule entry, no notification, so it silently looked like nothing
    // happened. Reset it instead so it shows up as newly assigned again.
    ({ data, error } = await supabase
      .from('challenge_assignments')
      .update({
        assigned_by_id:   assignedById || '',
        assigned_by_role: assignedByRole,
        due_date:         dueDate || null,
        status:           'assigned',
        score:            null,
        xp_awarded:       null,
        completed_at:     null,
        assigned_at:      new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('status', 'completed') // a concurrent re-assign that already won matches nothing
      .select()
      .maybeSingle());
    if (!error && !data) return respondAlreadyAssigned(res, challengeId, studentId);
  } else {
    ({ data, error } = await supabase
      .from('challenge_assignments')
      .insert({
        id:               uuidv4(),
        challenge_id:     challengeId,
        student_id:       studentId,
        assigned_by_id:   assignedById || '',
        assigned_by_role: assignedByRole,
        due_date:         dueDate || null,
        status:           'assigned',
      })
      .select()
      .single());
  }

  // Double submit: the other request inserted first (unique challenge_id + student_id).
  if (error && error.code === '23505') return respondAlreadyAssigned(res, challengeId, studentId);
  if (error) return res.status(500).json({ error: error.message });

  await createNotificationEvent(challengeAssignedEvent({
    challenge: challengeCheck, assignment: data, actorEmail: assignedById, actorRole: assignedByRole,
  }));
  // Legacy push + parent system message keep running until V2 delivery ships.
  notifyChallengeAssigned({ challenge: challengeCheck, studentId, assignmentId: data.id, dueDate }).catch(() => {});

  // Auto-add to schedule if dueDate provided
  if (dueDate) {
    const schRes = await supabase.from('schedule_events').select('id').eq('assignment_id', data.id).maybeSingle();
    const existingSch = schRes?.data;
    if (!existingSch) {
      const extractTime = (ds) => (ds && typeof ds === 'string' && ds.includes('T')) ? ds.split('T')[1].substring(0, 5) : '23:59';
      const { error: scheduleError } = await supabase.from('schedule_events').insert({
        id:            uuidv4(),
        title:         `${challengeCheck.title} — Challenge due`,
        event_date:    dueDate.includes('T') ? dueDate.split('T')[0] : dueDate,
        start_time:    extractTime(null),
        end_time:      extractTime(dueDate),
        type:          'challenge',
        note:          `${challengeCheck.category} • ${challengeCheck.subject}${challengeCheck.grade ? ' • ' + challengeCheck.grade : ''}`,
        student_id:    studentId,
        created_by:    assignedByRole,
        tag:           challengeCheck.subject || null,
        assignment_id: data.id,
        challenge_id:  challengeId,
      });
      if (scheduleError) console.error('[challenges/assign] schedule_events insert failed:', scheduleError.message);
    }
  }

  res.json({ ...data, assignmentId: data.id });
});

// ── POST /challenges/unassign ────────────────────────────────────

router.post('/unassign', async (req, res) => {
  const { challengeId, studentId } = req.body;
  if (!challengeId || !studentId) return res.status(400).json({ error: 'challengeId and studentId required' });

  // Remove schedule event linked to this challenge assignment
  const { data: existing } = await supabase
    .from('challenge_assignments')
    .select('id')
    .eq('challenge_id', challengeId)
    .eq('student_id', studentId)
    .single();
  if (existing) {
    await supabase.from('schedule_events').delete().eq('assignment_id', existing.id);
    await clearNotificationsForEntity({ entityId: existing.id, reason: 'unassigned' });
  }

  await supabase
    .from('challenge_assignments')
    .delete()
    .eq('challenge_id', challengeId)
    .eq('student_id', studentId);

  res.json({ ok: true });
});

// ── POST /challenges/:assignmentId/complete ──────────────────────

router.post('/:assignmentId/complete', async (req, res) => {
  const { assignmentId } = req.params;
  const { studentId, score = 0 } = req.body;
  if (!studentId) return res.status(400).json({ error: 'studentId required' });

  const { data: assignment } = await supabase
    .from('challenge_assignments')
    .select('*')
    .eq('id', assignmentId)
    .single();

  if (!assignment)                          return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.student_id !== studentId)  return res.status(403).json({ error: 'Forbidden' });
  if (assignment.status === 'completed')    return res.json({ ...assignment, xpAwarded: assignment.xp_awarded });
  if (isPastDue(assignment.due_date))       return res.status(403).json({ error: 'This challenge closed on its due date and no longer accepts submissions.' });

  const challenge  = await getChallengeById(assignment.challenge_id);
  const xpAwarded  = Math.round((challenge?.xpReward ?? 100) * (score / 100));

  const { data: updated } = await supabase
    .from('challenge_assignments')
    .update({ status: 'completed', score: Math.round(score), xp_awarded: xpAwarded, completed_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .select()
    .single();

  await clearNotificationsForEntity({ entityId: assignmentId, studentId, reason: 'completed' });

  // Update student_stats XP in Supabase
  try {
    const { data: stats } = await supabase.from('student_stats').select('*').eq('student_id', studentId).single();
    if (stats) {
      const newXP = (stats.xp_points || 0) + xpAwarded;
      await supabase.from('student_stats').update({
        xp_points:            newXP,
        today_xp:             (stats.today_xp || 0) + xpAwarded,
        challenges_completed: (stats.challenges_completed || 0) + 1,
        level:                computeLevel(newXP),
        last_active_date:     new Date().toISOString().split('T')[0],
        updated_at:           new Date().toISOString(),
      }).eq('student_id', studentId);
    }
  } catch (e) { console.error('XP award error:', e.message); }

  res.json({ ...(updated ?? assignment), xpAwarded });
});

// ── GET /challenges/leaderboard?grade=xxx&limit=10 ──────────────

router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { grade } = req.query;

    const { data: assignments } = await supabase
      .from('challenge_assignments')
      .select('student_id, xp_awarded, score')
      .eq('status', 'completed');

    if (!assignments || assignments.length === 0) return res.json([]);

    const xpMap = {}, scoreMap = {}, countMap = {};
    assignments.forEach(a => {
      xpMap[a.student_id]    = (xpMap[a.student_id]    || 0) + (a.xp_awarded || 0);
      scoreMap[a.student_id] = (scoreMap[a.student_id] || 0) + (a.score      || 0);
      countMap[a.student_id] = (countMap[a.student_id] || 0) + 1;
    });

    const studentIds = Object.keys(xpMap);
    let query = supabase.from('users').select('id, name, grade').in('id', studentIds);
    if (grade) query = query.eq('grade', grade);
    const { data: users } = await query;
    const userMap = {};
    (users ?? []).forEach(u => { userMap[u.id] = u; });

    const allRanked = studentIds
      .map(id => ({
        id,
        name:     userMap[id]?.name  || 'Student',
        grade:    userMap[id]?.grade || 'Grade 3',
        xp:       xpMap[id],
        avgScore: countMap[id] > 0 ? Math.round(scoreMap[id] / countMap[id]) : 0,
        count:    countMap[id],
      }))
      .sort((a, b) => b.xp - a.xp);

    const totalStudents = allRanked.length;
    const ranked = allRanked
      .slice(0, limit)
      .map((s, i) => ({ ...s, rank: i + 1, totalStudents }));

    res.json({ leaderboard: ranked, totalStudents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /challenges/:id/questions ────────────────────────────────
// Predefined MCQs for a curated challenge — pure DB read, no AI-generation
// fallback (curated NCERT challenges must serve instantly). Returns [] if
// this challenge has no seeded questions yet; the frontend falls back to
// its existing live-generation path in that case.

router.get('/:id/questions', async (req, res) => {
  try {
    const questions = await getChallengeQuestions(req.params.id);
    res.json(questions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
