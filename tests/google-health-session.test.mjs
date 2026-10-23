import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleHealthSession, GOOGLE_HEALTH_SCOPE, loadGoogleIdentityServices } from '../src/google-health-session.js';

const TOKEN = 'unit-test-token-never-in-state';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const result = dateKey => ({ source: 'google_health', dateKey, timeZone: 'Europe/Rome', rangeStart: `${dateKey}T00:00:00Z`, rangeEnd: `${dateKey}T01:00:00Z`, fetchedAt: '2026-10-23T12:00:00Z', totalKcal: 0, activeKcal: null, coverage: { totalSeconds: 3600, activeSeconds: 0, requestedSeconds: 3600 } });

function harness(options = {}) {
  let milliseconds = Date.parse('2026-10-23T12:00:00Z');
  let nextId = 0;
  const timers = new Map();
  const configs = [];
  const requests = [];
  const reads = [];
  const states = [];
  const identities = [];
  let loads = 0;
  const session = createGoogleHealthSession({
    clientId: options.clientId ?? 'public-client.apps.googleusercontent.com',
    now: () => new Date(milliseconds),
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: milliseconds + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    loadOAuth: async () => { loads++; return { initTokenClient(config) { configs.push(config); return { requestAccessToken(request) { requests.push(request); } }; } }; },
    verifyAccount: async args => { identities.push(args); return options.verifyAccount?.(args); },
    readDay: async args => { reads.push(args); return options.readDay ? options.readDay(args) : result(args.dateKey); },
    onChange: state => states.push(state),
  });
  const authorize = async (response = {}) => {
    session.connect();
    await configs.at(-1).callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE, ...response });
    await tick();
  };
  const advance = async amount => {
    milliseconds += amount;
    for (const [id, timer] of [...timers]) if (timer.at <= milliseconds) { timers.delete(id); timer.callback(); }
    await tick();
  };
  return { session, configs, requests, reads, identities, states, timers, authorize, advance, loads: () => loads };
}

test('unconfigured access loads no script, requests no consent and exposes no fake connection', async () => {
  const h = harness({ clientId: '' });
  await h.session.prepare(); assert.equal(h.session.connect(), false);
  assert.equal(h.loads(), 0); assert.equal(h.requests.length, 0); assert.equal(h.session.getState().status, 'unconfigured');
});

test('preparation never asks for consent; explicit connect requests only the read-only scope', async () => {
  const h = harness(); await h.session.prepare();
  assert.equal(h.requests.length, 0);
  h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true });
  await h.authorize();
  assert.equal(h.configs[0].scope, GOOGLE_HEALTH_SCOPE); assert.equal(h.configs[0].include_granted_scopes, false);
  assert.deepEqual(h.requests[0], { prompt: 'select_account' });
  assert.equal(h.identities[0].accessToken, TOKEN); assert.equal(h.reads[0].accessToken, TOKEN);
  assert.equal(h.session.getState().status, 'connected');
  assert.equal(JSON.stringify(h.states).includes(TOKEN), false);
});

test('missing or extra scopes and invalid expiry values fail before identity or data access', async () => {
  for (const response of [{ scope: '' }, { scope: `${GOOGLE_HEALTH_SCOPE} openid` }, { expires_in: true }, { expires_in: 0 }, { expires_in: 'NaN' }]) {
    const h = harness(); await h.session.prepare(); await h.authorize(response);
    assert.equal(h.identities.length, 0); assert.equal(h.reads.length, 0); assert.equal(h.session.getState().error.code, 'ACCESS_DENIED');
    h.session.dispose();
  }
});

test('identity failure is normalized and prevents declaring the account connected', async () => {
  const h = harness({ verifyAccount: async () => { throw { code: 'ACCOUNT_NOT_LINKED', message: TOKEN }; } });
  await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await h.authorize();
  assert.equal(h.session.getState().status, 'account_not_linked'); assert.equal(h.reads.length, 0);
  assert.equal(JSON.stringify(h.session.getState()).includes(TOKEN), false);
});

test('zero and absence stay distinct, private result fields are never exposed, and partial coverage is retained', async () => {
  const h = harness({ readDay: async args => ({ ...result(args.dateKey), accessToken: TOKEN, coverage: { totalSeconds: 1800, activeSeconds: 0, requestedSeconds: 3600 } }) });
  await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await h.authorize();
  const data = h.session.getState().data;
  assert.equal(data.totalKcal, 0); assert.equal(data.activeKcal, null); assert.equal(data.coverage.totalSeconds, 1800);
  assert.equal(Object.hasOwn(data, 'accessToken'), false);
});

test('periodic reading runs after five minutes only for today, and stops while hidden or on another page', async () => {
  const h = harness(); await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await h.authorize();
  assert.equal(h.reads.length, 1); await h.advance(300000); assert.equal(h.reads.length, 2);
  h.session.setContext({ dateKey: '2026-10-23', active: true, visible: false }); await h.advance(300000); assert.equal(h.reads.length, 2);
  h.session.setContext({ dateKey: '2026-10-23', active: false, visible: true }); await h.advance(300000); assert.equal(h.reads.length, 2);
  assert.equal(h.session.getState().data, null);
});

test('past days load once; future days make no read request', async () => {
  const h = harness(); await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-22', active: true, visible: true }); await h.authorize();
  await h.advance(300000); assert.equal(h.reads.length, 1);
  h.session.setContext({ dateKey: '2026-10-24', active: true, visible: true }); await tick(); assert.equal(h.reads.length, 1); assert.equal(h.session.getState().data, null);
});

test('late day responses cannot replace the selected day and disconnection clears the result', async () => {
  const pending = [];
  const h = harness({ readDay: args => { const job = deferred(); pending.push({ ...job, dateKey: args.dateKey }); return job.promise; } });
  await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); h.session.connect();
  void h.configs[0].callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE }); await tick();
  h.session.setContext({ dateKey: '2026-10-22', active: true, visible: true }); await tick();
  pending[0].resolve(result('2026-10-23')); await tick(); assert.equal(h.session.getState().data, null);
  pending[1].resolve(result('2026-10-22')); await tick(); assert.equal(h.session.getState().data.dateKey, '2026-10-22');
  h.session.disconnect(); assert.equal(h.session.getState().data, null); assert.equal(h.session.getState().status, 'disconnected');
});

test('expiry clears credentials and displayed health data even while hidden', async () => {
  const h = harness(); await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await h.authorize({ expires_in: 10 });
  h.session.setContext({ dateKey: '2026-10-23', active: true, visible: false }); await h.advance(10001);
  assert.equal(h.session.getState().status, 'expired'); assert.equal(h.session.getState().data, null);
  await h.session.refresh(); assert.equal(h.reads.length, 1); assert.equal(h.timers.size, 0);
});

test('rate limiting preserves clearly stale data and pauses automatic retries until a manual attempt', async () => {
  let fail = false;
  const h = harness({ readDay: args => { if (fail) throw { code: 'RATE_LIMITED', message: TOKEN }; return result(args.dateKey); } });
  await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await h.authorize();
  fail = true; await h.advance(300000); assert.equal(h.session.getState().error.code, 'RATE_LIMITED'); assert.equal(h.session.getState().stale, true);
  const count = h.reads.length; await h.advance(300000); assert.equal(h.reads.length, count);
  assert.equal(JSON.stringify(h.states).includes(TOKEN), false);
  fail = false; await h.session.refresh(); assert.equal(h.session.getState().error, null); assert.equal(h.session.getState().stale, false);
});

test('switching accounts clears previous data immediately and rejects a late old authorization', async () => {
  const h = harness(); await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true });
  h.session.connect(); const old = h.configs[0]; h.session.disconnect(); h.session.connect();
  await old.callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE }); assert.equal(h.identities.length, 0);
  await h.configs[1].callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE }); assert.equal(h.session.getState().status, 'connected');
  h.session.connect(); assert.equal(h.session.getState().data, null);
  h.configs[2].error_callback({ type: 'popup_closed', message: TOKEN }); assert.equal(h.session.getState().status, 'disconnected'); assert.equal(h.session.getState().error.code, 'AUTH_CANCELLED');
});

test('a hidden page discards an in-flight response and resumes with a new read when visible', async () => {
  const pending = [];
  const h = harness({ readDay: args => { const job = deferred(); pending.push({ ...job, dateKey: args.dateKey }); return job.promise; } });
  await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); h.session.connect();
  void h.configs[0].callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE }); await tick();
  h.session.setContext({ dateKey: '2026-10-23', active: true, visible: false });
  pending[0].resolve(result('2026-10-23')); await tick(); assert.equal(h.session.getState().data, null);
  h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await tick();
  assert.equal(pending.length, 2); pending[1].resolve(result('2026-10-23')); await tick();
  assert.equal(h.session.getState().data.dateKey, '2026-10-23');
});

test('invalid result fields and raw network errors never enter session snapshots', async () => {
  for (const readDay of [async args => ({ ...result(args.dateKey), totalKcal: TOKEN }), async () => { throw new Error(TOKEN); }]) {
    const h = harness({ readDay }); await h.session.prepare(); h.session.setContext({ dateKey: '2026-10-23', active: true, visible: true }); await h.authorize();
    assert.equal(h.session.getState().data, null); assert.ok(h.session.getState().error);
    assert.equal(JSON.stringify(h.states).includes(TOKEN), false); h.session.dispose();
  }
});

test('the official GIS script times out, is removed, and ignores a late load callback', async () => {
  const events = new Map(); let timeout; let removed = false; let appended; let cancelled = false;
  const script = { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name), remove() { removed = true; } };
  const pending = loadGoogleIdentityServices({ createElement: () => script, head: { append(value) { appended = value; } } }, {
    setTimer(callback, delay) { timeout = callback; assert.equal(delay, 15000); return 1; },
    clearTimer(id) { assert.equal(id, 1); cancelled = true; },
  });
  assert.equal(appended.src, 'https://accounts.google.com/gsi/client');
  const lateLoad = events.get('load'); timeout();
  await assert.rejects(pending, /GIS_UNAVAILABLE/);
  assert.equal(removed, true); assert.equal(cancelled, true); assert.equal(events.size, 0);
  assert.doesNotThrow(lateLoad);
});

test('a failed access-script load is retryable without requesting OAuth consent', async () => {
  let calls = 0; const requests = [];
  const session = createGoogleHealthSession({ clientId: 'public-client', loadOAuth: async () => {
    calls++; if (calls === 1) throw new Error('network detail');
    return { initTokenClient: () => ({ requestAccessToken: request => requests.push(request) }) };
  } });
  await session.prepare(); assert.equal(session.getState().ready, false); assert.equal(session.getState().error.code, 'GIS_UNAVAILABLE');
  await session.prepare(); assert.equal(session.getState().ready, true); assert.equal(session.getState().error, null);
  assert.equal(requests.length, 0); session.dispose();
});

test('an unanswered OAuth popup times out and cannot complete with a late response', async () => {
  const h = harness(); await h.session.prepare(); h.session.connect();
  const old = h.configs[0];
  await h.advance(5 * 60 * 1000 + 1);
  assert.equal(h.session.getState().status, 'disconnected'); assert.equal(h.session.getState().error.code, 'AUTH_TIMEOUT');
  await old.callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE });
  assert.equal(h.identities.length, 0); assert.equal(h.session.getState().data, null);
  assert.equal(h.session.connect(), true); h.session.dispose();
});
