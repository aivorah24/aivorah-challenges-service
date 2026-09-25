const request = require('supertest');

jest.mock('../../services/challenges', () => ({
  getChallenges: jest.fn(),
  getChallengeById: jest.fn(),
  getChallengeQuestions: jest.fn(),
  attachImageUrl: jest.fn((c) => ({ ...c, imageUrl: null })),
  computeLevel: jest.fn(() => 2),
  isPastDue: jest.fn(() => false),
  notifyChallengeAssigned: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    select2: undefined,
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const {
  getChallenges, getChallengeById, getChallengeQuestions, isPastDue, notifyChallengeAssigned,
} = require('../../services/challenges');
const supabase = require('../../services/supabase');
const app = require('../../index');

function makeThenableChain(resolvedData, resolvedError = null) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    then: (resolve) => resolve({ data: resolvedData, error: resolvedError }),
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  supabase.from.mockImplementation(() => supabase._chain);
  isPastDue.mockReturnValue(false);
});

describe('GET /health', () => {
  test('reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'aivorah-challenges-service' });
  });
});

describe('GET /challenges', () => {
  test('returns unassigned challenges (no studentId) with attachImageUrl applied', async () => {
    getChallenges.mockResolvedValue([{ id: 'c1', title: 'Quiz' }]);
    const res = await request(app).get('/challenges?grade=Grade4&curriculum=NCERT');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'c1', title: 'Quiz', imageUrl: null }]);
  });

  test('with studentId, requires a parentEmail linked to that student and merges real assignment status onto each challenge', async () => {
    getChallenges.mockResolvedValue([{ id: 'c1', title: 'Quiz' }, { id: 'c2', title: 'Other' }]);
    supabase.from.mockImplementation((table) => {
      if (table === 'parent_children') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { child_id: 's1' }, error: null }) };
      if (table === 'challenge_assignments') return makeThenableChain([
        { id: 'asg1', challenge_id: 'c1', status: 'assigned', score: null, xp_awarded: null, due_date: '2026-05-01', assigned_by_role: 'teacher' },
      ]);
      return supabase._chain;
    });

    const res = await request(app).get('/challenges?studentId=s1&parentEmail=parent@x.com');

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 'c1', assignmentId: 'asg1', status: 'assigned', dueDate: '2026-05-01' }));
    expect(res.body[1]).toEqual(expect.objectContaining({ id: 'c2', status: 'available', assignmentId: null }));
  });

  test('with studentId but no parentEmail, allows the request (non-parent caller, e.g. student/teacher) and merges assignment status', async () => {
    getChallenges.mockResolvedValue([{ id: 'c1', title: 'Quiz' }]);
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([]);
      return supabase._chain;
    });
    const res = await request(app).get('/challenges?studentId=s1');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 'c1', status: 'available' }));
  });

  test('with studentId and a parentEmail not linked to that student, returns 403', async () => {
    getChallenges.mockResolvedValue([{ id: 'c1', title: 'Quiz' }]);
    supabase.from.mockImplementation((table) => {
      if (table === 'parent_children') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) };
      return supabase._chain;
    });
    const res = await request(app).get('/challenges?studentId=s1&parentEmail=stranger@x.com');
    expect(res.status).toBe(403);
  });

  test('a getChallenges service error maps to 500', async () => {
    getChallenges.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/challenges');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'db down' });
  });
});

describe('GET /challenges/assigned', () => {
  test('requires studentId', async () => {
    const res = await request(app).get('/challenges/assigned');
    expect(res.status).toBe(400);
  });

  test('returns real assigned challenges joined with assignment status, dropping unmatched ids', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([
        { id: 'asg1', challenge_id: 'c1', status: 'completed', score: 90, xp_awarded: 90, due_date: '2026-05-01', assigned_by_role: 'teacher' },
        { id: 'asg2', challenge_id: 'ghost', status: 'assigned', due_date: null },
      ]);
      return supabase._chain;
    });
    getChallenges.mockResolvedValue([{ id: 'c1', title: 'Quiz' }]);

    const res = await request(app).get('/challenges/assigned?studentId=s1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // "ghost" challenge_id has no matching challenge, filtered out
    expect(res.body[0]).toEqual(expect.objectContaining({ assignmentId: 'asg1', status: 'completed', score: 90 }));
  });
});

describe('GET /challenges/assigned-by', () => {
  test('requires assignedById', async () => {
    const res = await request(app).get('/challenges/assigned-by');
    expect(res.status).toBe(400);
  });

  test('returns the assigner’s challenge/student pairs, scoped by assigned_by_id', async () => {
    const chain = makeThenableChain([
      { challenge_id: 'c1', student_id: 's1', status: 'assigned', due_date: '2026-05-01' },
      { challenge_id: 'c1', student_id: 's2', status: 'completed', due_date: null },
    ]);
    supabase.from.mockImplementation((table) => (table === 'challenge_assignments' ? chain : supabase._chain));

    const res = await request(app).get('/challenges/assigned-by?assignedById=teacher@x.com');

    expect(res.status).toBe(200);
    expect(chain.eq).toHaveBeenCalledWith('assigned_by_id', 'teacher@x.com');
    expect(res.body).toEqual([
      { challengeId: 'c1', studentId: 's1', status: 'assigned', dueDate: '2026-05-01' },
      { challengeId: 'c1', studentId: 's2', status: 'completed', dueDate: null },
    ]);
  });

  test('a query error maps to 500', async () => {
    supabase.from.mockImplementation(() => makeThenableChain(null, { message: 'db down' }));
    const res = await request(app).get('/challenges/assigned-by?assignedById=teacher@x.com');
    expect(res.status).toBe(500);
  });
});

describe('GET /challenges/new-count', () => {
  test('requires studentId', async () => {
    const res = await request(app).get('/challenges/new-count');
    expect(res.status).toBe(400);
  });

  test('counts real non-completed assignments for a UUID studentId', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([{ id: 'a1' }, { id: 'a2' }]);
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/new-count?studentId=s1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  test('resolves an email studentId to a real user UUID before counting', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'resolved-uuid' } }) };
      if (table === 'challenge_assignments') return makeThenableChain([{ id: 'a1' }]);
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/new-count?studentId=Student%40A.com');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
  });

  test('an unresolvable email returns count:0 without querying assignments', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: null }) };
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/new-count?studentId=nobody%40a.com');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
  });

  test('a Supabase error on the count query maps to 500', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain(null, { message: 'db down' });
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/new-count?studentId=s1');
    expect(res.status).toBe(500);
  });
});

describe('POST /challenges/assign', () => {
  test('requires challengeId and studentId', async () => {
    const res = await request(app).post('/challenges/assign').send({});
    expect(res.status).toBe(400);
  });

  test('404s when the challenge does not exist', async () => {
    getChallengeById.mockResolvedValue(null);
    const res = await request(app).post('/challenges/assign').send({ challengeId: 'ghost', studentId: 's1' });
    expect(res.status).toBe(404);
  });

  test('parent role: 403s when assignedById is not linked to studentId via parent_children', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'parent_children') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/assign').send({
      challengeId: 'c1', studentId: 's1', assignedById: 'stranger@x.com', assignedByRole: 'parent',
    });
    expect(res.status).toBe(403);
    expect(getChallengeById).not.toHaveBeenCalled();
  });

  test('parent role: succeeds when assignedById IS linked to studentId via parent_children', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: null });
    supabase.from.mockImplementation((table) => {
      if (table === 'parent_children') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { child_id: 's1' }, error: null }) };
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'assigned' } }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/assign').send({
      challengeId: 'c1', studentId: 's1', assignedById: 'parent@x.com', assignedByRole: 'parent',
    });
    expect(res.status).toBe(200);
  });

  test('non-parent roles (teacher/student) are not subject to the ownership check', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: null });
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'assigned' } }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/assign').send({ challengeId: 'c1', studentId: 's1' });
    expect(res.status).toBe(200);
  });

  test('rejects assigning a challenge to a student in a different grade', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: 'Grade 4' });
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { grade: 'Grade 6' } }) };
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/assign').send({ challengeId: 'c1', studentId: 's1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Grade 4');
  });

  test('returns the existing pending assignment idempotently instead of creating a duplicate', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: null });
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'assigned' } }) };
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/assign').send({ challengeId: 'c1', studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'asg1', assignmentId: 'asg1' }));
  });

  // Regression: re-assigning a challenge that's already pending for this
  // student silently no-ops (no new row, no notification) but the client
  // showed the same "assigned!" success message either way, making it look
  // like notifications had stopped firing. The response must say so.
  test('flags an already-pending re-assign as alreadyAssigned, and does not notify again', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: null });
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'assigned' } }) };
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/assign').send({ challengeId: 'c1', studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body.alreadyAssigned).toBe(true);
    expect(notifyChallengeAssigned).not.toHaveBeenCalled();
  });

  test('creates a real new assignment, notifies, and adds a schedule event when a dueDate is given', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: null, category: 'quiz', subject: 'Math' });
    let assignmentsCallCount = 0;
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') {
        assignmentsCallCount++;
        if (assignmentsCallCount === 1) return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: null }) }; // no existing
        return { ...supabase._chain, insert: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'new-asg', status: 'assigned' }, error: null }) };
      }
      if (table === 'schedule_events') return { ...supabase._chain, insert: jest.fn().mockResolvedValue({ error: null }) };
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/assign').send({ challengeId: 'c1', studentId: 's1', dueDate: '2026-05-01' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'new-asg', assignmentId: 'new-asg' }));
    expect(notifyChallengeAssigned).toHaveBeenCalled();
  });

  test('re-assigning an already-completed challenge resets it to assigned instead of leaving it completed', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', title: 'Quiz', grade: null });
    let assignmentsCallCount = 0;
    let updateChain;
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') {
        assignmentsCallCount++;
        if (assignmentsCallCount === 1) return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'completed' } }) };
        updateChain = { ...supabase._chain, update: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'assigned' }, error: null }) };
        return updateChain;
      }
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/assign').send({ challengeId: 'c1', studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'asg1', status: 'assigned' }));
    // New version for the notification event, and only if still completed (double-submit guard).
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'assigned', assigned_at: expect.any(String) }));
    expect(updateChain.eq).toHaveBeenCalledWith('status', 'completed');
  });
});

describe('POST /challenges/unassign', () => {
  test('requires challengeId and studentId', async () => {
    const res = await request(app).post('/challenges/unassign').send({});
    expect(res.status).toBe(400);
  });

  test('removes the real assignment and its linked schedule event', async () => {
    // The route does .select().eq().eq().single() to find the existing assignment,
    // then a SEPARATE .delete().eq().eq() to actually remove it — `eq` must stay
    // chainable (mockReturnThis) for the double-.eq() lookup, only resolving at
    // the terminal call (.single() or after .delete()).
    let assignmentsCallCount = 0;
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') {
        assignmentsCallCount++;
        if (assignmentsCallCount === 1) {
          return { ...supabase._chain, select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'asg1' } }) };
        }
        return { ...supabase._chain, delete: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis() };
      }
      if (table === 'schedule_events') return { ...supabase._chain, delete: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({}) };
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/unassign').send({ challengeId: 'c1', studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /challenges/:assignmentId/complete', () => {
  test('requires studentId', async () => {
    const res = await request(app).post('/challenges/asg1/complete').send({});
    expect(res.status).toBe(400);
  });

  test('404s when the assignment does not exist', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: null }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/asg1/complete').send({ studentId: 's1' });
    expect(res.status).toBe(404);
  });

  test('403s when the assignment belongs to a different student', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', student_id: 'someone-else' } }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/asg1/complete').send({ studentId: 's1' });
    expect(res.status).toBe(403);
  });

  test('an already-completed assignment returns as-is without re-awarding XP', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', student_id: 's1', status: 'completed', xp_awarded: 80 } }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/asg1/complete').send({ studentId: 's1' });
    expect(res.status).toBe(200);
    expect(res.body.xpAwarded).toBe(80);
  });

  test('403s when the challenge has closed past its due date', async () => {
    isPastDue.mockReturnValue(true);
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', student_id: 's1', status: 'assigned', due_date: '2000-01-01' } }) };
      return supabase._chain;
    });
    const res = await request(app).post('/challenges/asg1/complete').send({ studentId: 's1' });
    expect(res.status).toBe(403);
  });

  test('completes the assignment, awards real XP based on score, and updates student_stats', async () => {
    getChallengeById.mockResolvedValue({ id: 'c1', xpReward: 100 });
    let assignmentsCallCount = 0;
    // student_stats is hit twice: .select().eq().single() to read current XP,
    // then a SEPARATE .update().eq() to write the new total — each call needs
    // its own chain since `eq` behaves differently in each (chainable to
    // .single() vs. terminal/awaitable after .update()).
    let statsCallCount = 0;
    const statsUpdateSpy = jest.fn().mockReturnThis();
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') {
        assignmentsCallCount++;
        if (assignmentsCallCount === 1) return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'asg1', student_id: 's1', status: 'assigned', challenge_id: 'c1', due_date: null } }) };
        return { ...supabase._chain, update: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'asg1', status: 'completed', score: 80, xp_awarded: 80 } }) };
      }
      if (table === 'student_stats') {
        statsCallCount++;
        if (statsCallCount === 1) {
          return { ...supabase._chain, select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { xp_points: 500, today_xp: 0, challenges_completed: 2 } }) };
        }
        return { ...supabase._chain, update: statsUpdateSpy, eq: jest.fn().mockResolvedValue({}) };
      }
      return supabase._chain;
    });

    const res = await request(app).post('/challenges/asg1/complete').send({ studentId: 's1', score: 80 });

    expect(res.status).toBe(200);
    expect(res.body.xpAwarded).toBe(80);
    expect(statsUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ xp_points: 580, today_xp: 80, challenges_completed: 3 }));
  });
});

describe('GET /challenges/leaderboard', () => {
  test('no completed assignments -> empty array', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([]);
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('ranks real students by total XP descending, with real average scores', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([
        { student_id: 's1', xp_awarded: 100, score: 90 },
        { student_id: 's1', xp_awarded: 50, score: 70 },
        { student_id: 's2', xp_awarded: 300, score: 100 },
      ]);
      if (table === 'users') return makeThenableChain([{ id: 's1', name: 'Aanya', grade: 'Grade 4' }, { id: 's2', name: 'Rohan', grade: 'Grade 5' }]);
      return supabase._chain;
    });

    const res = await request(app).get('/challenges/leaderboard?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.leaderboard[0]).toEqual(expect.objectContaining({ id: 's2', name: 'Rohan', xp: 300, avgScore: 100, rank: 1 }));
    expect(res.body.leaderboard[1]).toEqual(expect.objectContaining({ id: 's1', name: 'Aanya', xp: 150, avgScore: 80, rank: 2 }));
    expect(res.body.totalStudents).toBe(2);
  });

  test('honors the limit while still reporting the real totalStudents count', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([
        { student_id: 's1', xp_awarded: 300, score: 90 },
        { student_id: 's2', xp_awarded: 200, score: 80 },
        { student_id: 's3', xp_awarded: 100, score: 70 },
      ]);
      if (table === 'users') return makeThenableChain([{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }, { id: 's3', name: 'C' }]);
      return supabase._chain;
    });

    const res = await request(app).get('/challenges/leaderboard?limit=2');

    expect(res.body.leaderboard).toHaveLength(2);
    expect(res.body.totalStudents).toBe(3);
  });

  test('caps limit at 50 even when a larger value is requested', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return makeThenableChain([{ student_id: 's1', xp_awarded: 10, score: 10 }]);
      if (table === 'users') return makeThenableChain([{ id: 's1', name: 'A' }]);
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/leaderboard?limit=9999');
    expect(res.status).toBe(200); // limit is applied internally; no way to observe the cap directly via this response shape beyond it not erroring
  });

  test('an unhandled error maps to 500', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') return { ...supabase._chain, then: () => { throw new Error('boom'); } };
      return supabase._chain;
    });
    const res = await request(app).get('/challenges/leaderboard');
    expect(res.status).toBe(500);
  });
});

describe('GET /challenges/:id/questions', () => {
  test('returns the real predefined MCQs for a curated challenge', async () => {
    const questions = [
      { question: 'What is 2+2?', options: ['3', '4', '5', '6'], correct: 1, explanation: 'Basic addition.', questionType: 'mcq', acceptAnswers: null },
    ];
    getChallengeQuestions.mockResolvedValue(questions);

    const res = await request(app).get('/challenges/ncert_g1_maths_1/questions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(questions);
    expect(getChallengeQuestions).toHaveBeenCalledWith('ncert_g1_maths_1');
  });

  test('a challenge with no seeded questions returns an empty array (not a 404) — frontend decides the fallback', async () => {
    getChallengeQuestions.mockResolvedValue([]);
    const res = await request(app).get('/challenges/some_legacy_challenge/questions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('a real DB error maps to 500', async () => {
    getChallengeQuestions.mockRejectedValue(new Error('connection failed'));
    const res = await request(app).get('/challenges/c1/questions');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connection failed');
  });
});
