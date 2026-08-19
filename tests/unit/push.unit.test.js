jest.mock('../../services/supabase', () => {
  const chain = { select: jest.fn().mockReturnThis(), in: jest.fn() };
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { sendPush, getTokensForEmails } = require('../../services/push');

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  supabase.from.mockImplementation(() => supabase._chain);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('getTokensForEmails', () => {
  test('collects and dedupes valid Expo tokens across multiple users', async () => {
    supabase._chain.in.mockResolvedValue({
      data: [
        { user_email: 'a@a.com', data: { expoPushTokens: ['ExponentPushToken[a1]', 'ExponentPushToken[a1]'] } },
        { user_email: 'b@a.com', data: { expoPushTokens: ['ExponentPushToken[b1]'] } },
      ],
    });
    const tokens = await getTokensForEmails(['a@a.com', 'b@a.com']);
    expect(tokens.sort()).toEqual(['ExponentPushToken[a1]', 'ExponentPushToken[b1]'].sort());
  });

  test('filters out malformed / non-Expo tokens', async () => {
    supabase._chain.in.mockResolvedValue({
      data: [{ user_email: 'a@a.com', data: { expoPushTokens: ['garbage-token', 'ExponentPushToken[ok]'] } }],
    });
    const tokens = await getTokensForEmails('a@a.com');
    expect(tokens).toEqual(['ExponentPushToken[ok]']);
  });

  test('no emails supplied -> empty array, no Supabase call', async () => {
    const tokens = await getTokensForEmails([]);
    expect(tokens).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a Supabase error is swallowed and returns an empty array', async () => {
    supabase._chain.in.mockRejectedValue(new Error('db down'));
    const tokens = await getTokensForEmails('a@a.com');
    expect(tokens).toEqual([]);
  });

  test('a user with no expoPushTokens field is skipped without crashing', async () => {
    supabase._chain.in.mockResolvedValue({ data: [{ user_email: 'a@a.com', data: {} }] });
    const tokens = await getTokensForEmails('a@a.com');
    expect(tokens).toEqual([]);
  });
});

describe('sendPush', () => {
  test('sends to Expo and reports the real sent count for a single chunk', async () => {
    supabase._chain.in.mockImplementation((col, list) => {
      // First call = filterByPreference's user_preferences lookup (empty = no opt-outs);
      // second call = getTokensForEmails' lookup (has the token).
      if (supabase._chain.in.mock.calls.length === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [{ user_email: 'a@a.com', data: { expoPushTokens: ['ExponentPushToken[a1]'] } }] });
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    const result = await sendPush('a@a.com', { title: 'Hi', body: 'Body', prefKey: 'challengeUpdates' });

    expect(result).toEqual({ sent: 1 });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('a recipient who opted out via prefKey=false is excluded, resulting in sent:0', async () => {
    supabase._chain.in.mockResolvedValue({ data: [{ user_email: 'a@a.com', data: { challengeUpdates: false } }] });
    global.fetch = jest.fn();

    const result = await sendPush('a@a.com', { title: 'Hi', prefKey: 'challengeUpdates' });

    expect(result).toEqual({ sent: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('no tokens found for an allowed recipient -> sent:0, no fetch call', async () => {
    supabase._chain.in.mockResolvedValue({ data: [] });
    global.fetch = jest.fn();

    const result = await sendPush('a@a.com', { title: 'Hi' });

    expect(result).toEqual({ sent: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an Expo API error response does not count toward sent, and does not throw', async () => {
    supabase._chain.in.mockImplementation(() => {
      if (supabase._chain.in.mock.calls.length === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [{ user_email: 'a@a.com', data: { expoPushTokens: ['ExponentPushToken[a1]'] } }] });
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await sendPush('a@a.com', { title: 'Hi' });

    expect(result).toEqual({ sent: 0 });
  });

  test('a thrown error anywhere in the pipeline is caught and returns {sent:0, error}', async () => {
    supabase._chain.in.mockImplementation(() => { throw new Error('unexpected'); });
    const result = await sendPush('a@a.com', { title: 'Hi' });
    expect(result.sent).toBe(0);
  });

  test('a preference lookup failure fails open — still sends instead of blocking the notification', async () => {
    supabase._chain.in.mockImplementation(() => {
      if (supabase._chain.in.mock.calls.length === 1) return Promise.reject(new Error('prefs db down'));
      return Promise.resolve({ data: [{ user_email: 'a@a.com', data: { expoPushTokens: ['ExponentPushToken[a1]'] } }] });
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    const result = await sendPush('a@a.com', { title: 'Hi', prefKey: 'challengeUpdates' });

    expect(result).toEqual({ sent: 1 });
  });

  test('a batch of more than 100 tokens is split into multiple Expo requests', async () => {
    const manyTokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${i}]`);
    supabase._chain.in.mockResolvedValue({ data: [{ user_email: 'a@a.com', data: { expoPushTokens: manyTokens } }] });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    const result = await sendPush('a@a.com', { title: 'Hi' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 150 });
  });
});
