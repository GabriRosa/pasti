import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistentHealthClient } from '../src/google-health-persistent.js';
import { createGoogleHealthSession, GOOGLE_HEALTH_SCOPE as READ, GOOGLE_HEALTH_NUTRITION_SCOPE as WRITE } from '../src/google-health-session.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate()); };
const credentials = (extra = {}) => ({ access_token: 'private-access', expires_in: 3600, scope: READ, healthUserId: 'user-1', ...extra });
function harness(extra = {}) {
  let now = Date.now(); let calls = 0; let disconnects = 0; const starts = []; const timers = new Set();
  const client = { restore: async () => { calls++; return credentials(); }, connect: async n => { starts.push(n); }, disconnect: async () => { disconnects++; }, ...extra };
  const session = createGoogleHealthSession({ clientId: 'test-client', persistent: client,
    loadOAuth: () => { throw new Error('GIS must not load'); },
    now: () => new Date(now),
    receiptStore: { available: true },
    setTimer(fn, delay) { const timer = { fn, at: now + delay }; timers.add(timer); return timer; }, clearTimer(t) { timers.delete(t); },
  });
  return { session, timers, starts, calls: () => calls, disconnects: () => disconnects,
    async advance(ms) { now += ms; for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn(); } await tick(); } };
}

test('cookie adapter sends same-origin no-store POST and keeps callback URLs fixed', async () => {
  const calls = [], assigned = [];
  const api = createPersistentHealthClient({ locationRef: { assign: u => assigned.push(u) }, fetchImpl: async (...args) => {
    calls.push(args); return Response.json(args[0].endsWith('start') ? { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' } : credentials());
  } });
  assert.equal((await api.restore()).access_token, 'private-access');
  await api.connect(true);
  assert.equal(assigned.length, 1);
  assert.equal(calls[0][0], '/api/health/session');
  for (const [, options] of calls) { assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers['X-Pasti-Request'], '1'); }
  assert.equal(calls[1][1].body, '{"nutrition":true}');
  const bad = createPersistentHealthClient({ locationRef: { assign: () => assert.fail('unsafe redirect') }, fetchImpl: async () => Response.json({ url: 'https://attacker.test/' }) });
  await assert.rejects(bad.connect(), { code: 'INVALID_RESPONSE' });
});

test('missing session is normal; network errors and callback errors reveal no server detail', async () => {
  const api = createPersistentHealthClient({ fetchImpl: async () => new Response('private error', { status: 401 }) });
  assert.equal(await api.restore(), null);
  await assert.rejects(api.disconnect(), { code: 'AUTH_REQUIRED' });
  const history = [];
  const callback = createPersistentHealthClient({ locationRef: { href: 'https://app.test/?health_error=secret&other=1#today' }, historyRef: { replaceState: (...a) => history.push(a) } });
  assert.equal(callback.consumeError(), 'UNAVAILABLE'); assert.equal(history[0][2], '/?other=1#today');
});

test('reopening restores read access without Google script or nutrition consent', async () => {
  const h = harness(); await h.session.prepare();
  assert.equal(h.session.getState().status, 'connected'); assert.equal(h.session.getState().nutrition.status, 'disabled');
  assert.equal(JSON.stringify(h.session.getState()).includes('private-access'), false);
  h.session.suspend(); assert.equal(h.disconnects(), 0); assert.equal(h.session.getState().status, 'disconnected');
  await h.session.prepare(); assert.equal(h.session.getState().status, 'connected');
  assert.equal(h.starts.length, 0); h.session.dispose();
});

test('renewal occurs before expiry while visible and waits until visible if hidden', async () => {
  const h = harness(); await h.session.prepare();
  await h.advance(3540000); await wait(() => h.calls() === 2);
  h.session.setContext({ active: false, visible: false, dateKey: '2026-10-27' });
  await h.advance(3600000); assert.equal(h.calls(), 2);
  h.session.setContext({ active: false, visible: true, dateKey: '2026-10-27' });
  await wait(() => h.calls() === 3); h.session.dispose();
});

test('explicit disconnect cancels a delayed restore and deletes server session', async () => {
  let resolve; const h = harness({ restore: () => new Promise(r => { resolve = r; }) });
  const preparing = h.session.prepare(); await tick();
  await h.session.disconnect(); resolve(credentials()); await preparing;
  assert.equal(h.session.getState().status, 'disconnected'); assert.equal(h.disconnects(), 1);
  h.session.setContext({ active: true, visible: true, dateKey: '2026-10-27' });
  assert.equal(h.session.getState().status, 'disconnected'); h.session.dispose();
});

test('failed disconnect is visible and does not pretend server credentials were deleted', async () => {
  const h = harness({ disconnect: async () => { throw new Error('private server failure'); } });
  await h.session.prepare(); await h.session.disconnect();
  assert.equal(h.session.getState().error.code, 'DISCONNECT_FAILED');
  assert.equal(JSON.stringify(h.session.getState()).includes('private server failure'), false); h.session.dispose();
});

test('restored write scope enables only the existing review flow, never uploads on restore', async () => {
  const h = harness({ restore: async () => credentials({ scope: `${READ} ${WRITE}` }) });
  await h.session.prepare(); assert.equal(h.session.getState().nutrition.status, 'ready');
  assert.equal(h.session.requestNutritionAccess(), false); h.session.dispose();
  const readOnly = harness(); await readOnly.session.prepare(); await readOnly.session.requestNutritionAccess();
  assert.deepEqual(readOnly.starts, [true]); readOnly.session.dispose();
});

test('malformed credentials and extra scopes cannot become connected', async () => {
  for (const bad of [{ scope: `${READ} openid` }, { healthUserId: '../other' }, { expires_in: true }, { access_token: 'has space' }]) {
    const h = harness({ restore: async () => credentials(bad) }); await h.session.prepare();
    assert.equal(h.session.getState().status, 'expired'); assert.equal(h.session.getState().error.code, 'INVALID_RESPONSE'); h.session.dispose();
  }
});

test('transient restore failure permits retry without opening a consent screen', async () => {
  let fail = true; const h = harness({ restore: async () => { if (fail) throw { code: 'UNAVAILABLE' }; return credentials(); } });
  await h.session.prepare(); assert.equal(h.session.getState().error.code, 'UNAVAILABLE');
  fail = false; await h.session.prepare(); assert.equal(h.session.getState().status, 'connected'); assert.deepEqual(h.starts, []); h.session.dispose();
});
