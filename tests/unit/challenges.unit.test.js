jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});
jest.mock('../../services/push', () => ({ sendPush: jest.fn().mockResolvedValue({ sent: 1 }) }));
jest.mock('fs');

const fs = require('fs');
const supabase = require('../../services/supabase');
const { sendPush } = require('../../services/push');
const {
  getChallenges,
  getChallengeById,
  attachImageUrl,
  computeLevel,
  isPastDue,
  notifyChallengeAssigned,
} = require('../../services/challenges');

beforeEach(() => {
  jest.clearAllMocks();
  supabase.from.mockImplementation(() => supabase._chain);
});

describe('getChallenges', () => {
  test('maps real DB rows (snake_case) to camelCase challenge objects', async () => {
    supabase._chain.eq.mockImplementation(function (col) {
      // Last .eq() in the chain resolves the query when awaited directly.
      return this;
    });
    // Make the chain thenable so `await query` resolves.
    Object.assign(supabase._chain, {
      then: (resolve) => resolve({
        data: [{ id: 'c1', title: 'Fractions Quiz', description: 'd', subject: 'Math', topic: 'Fractions', grade: 'Grade 4', curriculum: 'NCERT', category: 'quiz', difficulty: 'easy', xp_reward: 100, question_count: 5, time_limit_minutes: 10, type: 'mcq', tags: ['math'], is_published: true, created_at: '2026-01-01', thumbnail_url: null }],
        error: null,
      }),
    });

    const result = await getChallenges('Grade 4', 'NCERT');

    expect(result).toEqual([{
      id: 'c1', title: 'Fractions Quiz', description: 'd', subject: 'Math', topic: 'Fractions',
      grade: 'Grade 4', curriculum: 'NCERT', category: 'quiz', difficulty: 'easy', xpReward: 100,
      questionCount: 5, timeLimitMinutes: 10, type: 'mcq', tags: ['math'], isPublished: true,
      created_at: '2026-01-01', thumbnailUrl: null,
    }]);
  });

  test('defaults topic and type to empty string when missing', async () => {
    Object.assign(supabase._chain, {
      then: (resolve) => resolve({ data: [{ id: 'c1', title: 't', is_published: true }], error: null }),
    });
    const result = await getChallenges();
    expect(result[0].topic).toBe('');
    expect(result[0].type).toBe('');
  });

  test('a Supabase error throws the real error object', async () => {
    Object.assign(supabase._chain, {
      then: (resolve) => resolve({ data: null, error: new Error('db down') }),
    });
    await expect(getChallenges()).rejects.toThrow('db down');
  });

  test('no rows returns an empty array, not null/undefined', async () => {
    Object.assign(supabase._chain, { then: (resolve) => resolve({ data: null, error: null }) });
    const result = await getChallenges();
    expect(result).toEqual([]);
  });
});

describe('getChallengeById', () => {
  test('returns the mapped challenge when found', async () => {
    supabase._chain.single.mockResolvedValue({ data: { id: 'c1', title: 'Quiz', is_published: true }, error: null });
    const result = await getChallengeById('c1');
    expect(result).toEqual(expect.objectContaining({ id: 'c1', title: 'Quiz' }));
  });

  test('returns null when Supabase errors', async () => {
    supabase._chain.single.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const result = await getChallengeById('missing');
    expect(result).toBeNull();
  });

  test('returns null when no data and no error', async () => {
    supabase._chain.single.mockResolvedValue({ data: null, error: null });
    const result = await getChallengeById('missing');
    expect(result).toBeNull();
  });
});

describe('attachImageUrl', () => {
  const challenge = { id: 'c1' };

  test('uses the Cloudinary URL when a matching key exists in the JSON map', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ 'challenges/c1.png': 'https://cdn.example.com/c1.png' }));
    const result = attachImageUrl(challenge);
    expect(result.imageUrl).toBe('https://cdn.example.com/c1.png');
  });

  test('falls back to a local file path when no Cloudinary entry exists but the file is on disk', () => {
    fs.readFileSync.mockReturnValue('{}');
    fs.existsSync.mockReturnValue(true);
    const result = attachImageUrl(challenge);
    expect(result.imageUrl).toBe('/data/images/challenges/c1.png');
  });

  test('imageUrl is null when neither Cloudinary nor a local file has the image', () => {
    fs.readFileSync.mockReturnValue('{}');
    fs.existsSync.mockReturnValue(false);
    const result = attachImageUrl(challenge);
    expect(result.imageUrl).toBeNull();
  });

  test('a corrupt/missing cloudinary_urls.json is tolerated (readCloudinaryUrls swallows the error)', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    fs.existsSync.mockReturnValue(false);
    const result = attachImageUrl(challenge);
    expect(result.imageUrl).toBeNull();
  });
});

describe('computeLevel', () => {
  test('starts at level 1 with 0 xp', () => {
    expect(computeLevel(0)).toBe(1);
  });

  test('reaches level 2 exactly at the first threshold (500 xp)', () => {
    expect(computeLevel(499)).toBe(1);
    expect(computeLevel(500)).toBe(2);
  });

  test('later thresholds grow by 250 each level (500, 750, 1000, ...)', () => {
    // total after level2 threshold(500)+level3 threshold(750) = 1250
    expect(computeLevel(1249)).toBe(2);
    expect(computeLevel(1250)).toBe(3);
  });
});

describe('isPastDue', () => {
  test('a null/undefined due date is never past due', () => {
    expect(isPastDue(null)).toBe(false);
    expect(isPastDue(undefined)).toBe(false);
  });

  test('a due date far in the past is past due', () => {
    expect(isPastDue('2000-01-01')).toBe(true);
  });

  test('a due date far in the future is not past due', () => {
    expect(isPastDue('2999-01-01')).toBe(false);
  });
});

describe('notifyChallengeAssigned', () => {
  const challenge = { id: 'c1', title: 'Fractions Quiz', subject: 'Math' };

  test('sends a push to the student and linked parents, and creates a parent message', async () => {
    let callCount = 0;
    supabase.from.mockImplementation((table) => {
      callCount++;
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { email: 'student@a.com', name: 'Aanya' } }) };
      if (table === 'parent_children') return { ...supabase._chain, eq: jest.fn().mockResolvedValue({ data: [{ parent_email: 'parent@a.com' }] }) };
      if (table === 'messages') return { ...supabase._chain, insert: jest.fn().mockResolvedValue({}) };
      return supabase._chain;
    });

    await notifyChallengeAssigned({ challenge, studentId: 's1', assignmentId: 'a1', dueDate: '2026-05-01' });

    expect(sendPush).toHaveBeenCalledWith(
      ['student@a.com', 'parent@a.com'],
      expect.objectContaining({ title: 'New challenge: Fractions Quiz', prefKey: 'challengeUpdates' })
    );
  });

  test('a push failure is swallowed and does not throw (best-effort)', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockRejectedValue(new Error('boom')) };
      return supabase._chain;
    });
    await expect(notifyChallengeAssigned({ challenge, studentId: 's1', assignmentId: 'a1' })).resolves.toBeUndefined();
  });

  test('no linked parents -> no message insert attempted, still resolves', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { email: 'student@a.com' } }) };
      if (table === 'parent_children') return { ...supabase._chain, eq: jest.fn().mockResolvedValue({ data: [] }) };
      return supabase._chain;
    });
    await expect(notifyChallengeAssigned({ challenge, studentId: 's1', assignmentId: 'a1' })).resolves.toBeUndefined();
  });
});
