const request = require('supertest');

// Each query records its operations; `mockResolveQuery(table, ops)` decides the result.
const mockResolveQuery = jest.fn();
const mockRpc = jest.fn();
jest.mock('../../services/supabase', () => {
  const from = (table) => {
    const ops = [];
    const chain = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'gt', 'insert', 'update', 'delete', 'order', 'limit', 'is', 'or']) {
      chain[m] = (...args) => { ops.push([m, ...args]); return chain; };
    }
    const done = () => Promise.resolve(mockResolveQuery(table, ops) ?? { data: null, error: null });
    chain.single = () => { ops.push(['single']); return done(); };
    chain.maybeSingle = () => { ops.push(['maybeSingle']); return done(); };
    chain.then = (res, rej) => done().then(res, rej);
    return chain;
  };
  return { from: jest.fn(from), rpc: (...a) => mockRpc(...a) };
});
jest.mock('../../services/challenges', () => ({
  getChallenges: jest.fn(),
  getChallengeById: jest.fn(),
  getChallengeQuestions: jest.fn(),
  attachImageUrl: jest.fn((c) => c),
  computeLevel: jest.fn(() => 1),
  isPastDue: jest.fn(() => false),
  notifyChallengeAssigned: jest.fn().mockResolvedValue(undefined),
}));

const { getChallengeById, notifyChallengeAssigned } = require('../../services/challenges');
const app = require('../../index');

const S1 = '11111111-1111-1111-1111-111111111111';
const CHALLENGE = { id: 'ch-motion', title: 'Motion', subject: 'Science', grade: 'Grade 4', category: 'Quiz' };
const has = (ops, m, ...args) => ops.some(o => o[0] === m && args.every((a, i) => o[i + 1] === a));

// Default world: student in the right grade, no existing assignment, inserts succeed.
function world(overrides = {}) {
  return (table, ops) => {
    if (overrides[table]) {
      const r = overrides[table](ops);
      if (r !== undefined) return r;
    }
    if (table === 'users') return { data: { grade: 'Grade 4' }, error: null };
    if (table === 'parent_children') return { data: { child_id: S1 }, error: null };
    if (table === 'challenge_assignments') {
      if (has(ops, 'insert')) return { data: { id: 'ca-new', student_id: S1, due_date: '2026-09-30', assigned_at: '2026-09-24T10:00:00.5+00:00', created_at: '2026-09-24T10:00:00.5+00:00' }, error: null };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
}

const events = () => mockRpc.mock.calls.filter(c => c[0] === 'notify_event').map(c => c[1].p_event);
const assign = (body = {}) => request(app).post('/challenges/assign')
  .send({ challengeId: 'ch-motion', studentId: S1, assignedById: 'Teacher@X.com', assignedByRole: 'teacher', dueDate: '2026-09-30', ...body });

let logSpy;
beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  getChallengeById.mockResolvedValue(CHALLENGE);
  mockRpc.mockResolvedValue({ data: { eventKey: 'k', recipients: 2, duplicates: 0, inserted: [{ id: 'n1' }, { id: 'n2' }] }, error: null });
  mockResolveQuery.mockImplementation(world());
});
afterEach(() => logSpy.mockRestore());

test('new assignment → one V2 event: student id, version = assigned_at, actor, deep-link data; legacy still runs', async () => {
  const res = await assign();
  expect(res.status).toBe(200);
  expect(events()).toEqual([{
    type: 'challenge_assigned', entity_type: 'challenge_assignment', entity_id: 'ca-new',
    version: '2026-09-24T10:00:00.5+00:00', student_ids: [S1],
    actor_email: 'teacher@x.com', actor_role: 'teacher',
    title: 'New challenge: Motion', body: 'Science · Due 30 Sept',
    parent_title: 'New challenge for {child}: Motion', parent_body: 'Science · Due 30 Sept',
    data: { challengeId: 'ch-motion', challengeAssignmentId: 'ca-new', subject: 'Science', dueDate: '2026-09-30' },
  }]);
  expect(notifyChallengeAssigned).toHaveBeenCalledTimes(1);
});

test('already pending (duplicate request) → alreadyAssigned, no new event', async () => {
  mockResolveQuery.mockImplementation(world({
    challenge_assignments: (ops) => (has(ops, 'single') ? { data: { id: 'ca-1', status: 'assigned', student_id: S1 }, error: null } : undefined),
  }));
  const res = await assign();
  expect(res.body.alreadyAssigned).toBe(true);
  expect(events()).toHaveLength(0);
});

test('re-assigning a completed challenge → new version (bumped assigned_at) → new event', async () => {
  let updatePayload;
  mockResolveQuery.mockImplementation(world({
    challenge_assignments: (ops) => {
      if (has(ops, 'update')) {
        updatePayload = ops.find(o => o[0] === 'update')[1];
        return { data: { id: 'ca-1', student_id: S1, status: 'assigned', due_date: null, assigned_at: updatePayload.assigned_at, created_at: '2026-09-01T00:00:00+00:00' }, error: null };
      }
      if (has(ops, 'single')) return { data: { id: 'ca-1', status: 'completed', student_id: S1 }, error: null };
      return undefined;
    },
  }));
  const res = await assign({ dueDate: undefined });
  expect(res.status).toBe(200);
  expect(events()).toHaveLength(1);
  expect(events()[0].entity_id).toBe('ca-1');
  expect(events()[0].version).toBe(updatePayload.assigned_at);
  expect(events()[0].version).not.toBe('2026-09-01T00:00:00+00:00');
});

test('re-assign double submit: the losing request matches no completed row → alreadyAssigned, no event', async () => {
  mockResolveQuery.mockImplementation(world({
    challenge_assignments: (ops) => {
      if (has(ops, 'update')) return { data: null, error: null };
      if (has(ops, 'single')) return { data: { id: 'ca-1', status: 'completed', student_id: S1 }, error: null };
      if (has(ops, 'maybeSingle')) return { data: { id: 'ca-1', status: 'assigned', student_id: S1 }, error: null };
      return undefined;
    },
  }));
  const res = await assign();
  expect(res.status).toBe(200);
  expect(res.body.alreadyAssigned).toBe(true);
  expect(events()).toHaveLength(0);
});

test('insert double submit: unique violation → alreadyAssigned, no second event', async () => {
  mockResolveQuery.mockImplementation(world({
    challenge_assignments: (ops) => {
      if (has(ops, 'insert')) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "challenge_assignments_challenge_student_uniq"' } };
      if (has(ops, 'maybeSingle')) return { data: { id: 'ca-winner', status: 'assigned', student_id: S1 }, error: null };
      return undefined;
    },
  }));
  const res = await assign();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ alreadyAssigned: true, assignmentId: 'ca-winner' });
  expect(events()).toHaveLength(0);
});

test('parent assigning → parent is the actor (excluded from their own notification by notify_event)', async () => {
  await assign({ assignedById: 'Mom@X.com', assignedByRole: 'parent' });
  expect(events()[0]).toMatchObject({ actor_email: 'mom@x.com', actor_role: 'parent' });
});

test.each([
  ['unknown challenge (404)', () => getChallengeById.mockResolvedValue(null), 404],
  ['wrong grade (400)', () => mockResolveQuery.mockImplementation(world({ users: () => ({ data: { grade: 'Grade 6' }, error: null }) })), 400],
  ['parent not linked to the child (403)', () => mockResolveQuery.mockImplementation(world({ parent_children: () => ({ data: null, error: null }) })), 403],
  ['insert failure (500)', () => mockResolveQuery.mockImplementation(world({
    challenge_assignments: (ops) => (has(ops, 'insert') ? { data: null, error: { code: 'XX000', message: 'boom' } } : undefined),
  })), 500],
])('rejected request: %s → no notification', async (_l, setup, status) => {
  setup();
  const res = await assign({ assignedByRole: status === 403 ? 'parent' : 'teacher' });
  expect(res.status).toBe(status);
  expect(events()).toHaveLength(0);
  expect(notifyChallengeAssigned).not.toHaveBeenCalled();
});

test('notification failure never fails the assignment', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'db timeout' } });
  const res = await assign();
  expect(res.status).toBe(200);
  const line = logSpy.mock.calls.map(c => c[0]).find(l => /notification\.create/.test(l));
  expect(JSON.parse(line)).toMatchObject({ svc: 'challenges', ok: false, reason: 'db timeout', entity: 'ca-new' });
});


// ── clearing on completion / unassign ──
const notificationWrites = () => mockResolveQuery.mock.calls.filter(([t, ops]) => t === 'notifications' && has(ops, 'update'));

describe('clearing stale notifications', () => {
  const completeWorld = (status = 'assigned', studentId = S1) => world({
    challenge_assignments: (ops) => {
      if (has(ops, 'update')) return { data: { id: 'ca-1', status: 'completed' }, error: null };
      if (has(ops, 'single')) return { data: { id: 'ca-1', challenge_id: 'ch-motion', student_id: studentId, status, due_date: null }, error: null };
      return undefined;
    },
    notifications: () => ({ data: [{ id: 'n1' }, { id: 'n2' }], error: null }),
  });

  test('completing a challenge clears that student’s and their parents’ open notifications for it', async () => {
    mockResolveQuery.mockImplementation(completeWorld());
    const res = await request(app).post('/challenges/ca-1/complete').send({ studentId: S1, score: 80 });
    expect(res.status).toBe(200);
    const [[, ops]] = notificationWrites();
    expect(ops).toEqual(expect.arrayContaining([
      ['update', { read_at: expect.any(String) }],
      ['eq', 'entity_type', 'challenge_assignment'],
      ['eq', 'entity_id', 'ca-1'],
      ['is', 'read_at', null],
      ['or', `recipient_id.eq.${S1},child_id.eq.${S1}`],
    ]));
    const log = logSpy.mock.calls.map(c => c[0]).find(l => /notification\.clear/.test(l));
    expect(JSON.parse(log)).toMatchObject({ evt: 'notification.clear', ok: true, cleared: 2, reason: 'completed' });
  });

  test.each([
    ['someone else’s challenge (403)', completeWorld('assigned', 'another-student'), 403],
    ['already completed (no-op)', completeWorld('completed'), 200],
  ])('%s → nothing cleared', async (_l, w, status) => {
    mockResolveQuery.mockImplementation(w);
    const res = await request(app).post('/challenges/ca-1/complete').send({ studentId: S1, score: 80 });
    expect(res.status).toBe(status);
    expect(notificationWrites()).toHaveLength(0);
  });

  test('unassigning clears every open notification for that assignment', async () => {
    mockResolveQuery.mockImplementation(world({
      challenge_assignments: (ops) => (has(ops, 'single') ? { data: { id: 'ca-1' }, error: null } : undefined),
      notifications: () => ({ data: [], error: null }),
    }));
    const res = await request(app).post('/challenges/unassign').send({ challengeId: 'ch-motion', studentId: S1 });
    expect(res.status).toBe(200);
    const [[, ops]] = notificationWrites();
    expect(ops).toEqual(expect.arrayContaining([['eq', 'entity_id', 'ca-1'], ['is', 'read_at', null]]));
    expect(ops.some(o => o[0] === 'or')).toBe(false);
  });

  test('a failure to clear never fails the completion', async () => {
    mockResolveQuery.mockImplementation(world({
      challenge_assignments: completeWorld().bind(null, 'challenge_assignments'),
      notifications: () => ({ data: null, error: { message: 'db down' } }),
    }));
    const res = await request(app).post('/challenges/ca-1/complete').send({ studentId: S1, score: 80 });
    expect(res.status).toBe(200);
  });
});
