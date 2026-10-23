import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleHealthSession, GOOGLE_HEALTH_SCOPE } from '../src/google-health-session.js';
import { getGoogleHealthDay, verifyGoogleHealthAccount } from '../src/google-health.js';

const TOKEN_A = 'synthetic-review-token-A';
const TOKEN_B = 'synthetic-review-token-B';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (body, status = 200) => ({ status, redirected: false, url: '', text: async () => JSON.stringify(body) });

function reviewHarness(t, handler) {
  let time = Date.parse('2026-10-22T22:03:43.987Z');
  let timerId = 0;
  const timers = new Map();
  const configs = [];
  const oauthRequests = [];
  const calls = [];
  const states = [];
  const standard = (url, init, value = 5) => {
    if (url.endsWith('/identity')) return response({ healthUserId: 'private-synthetic-identity' });
    const { range } = JSON.parse(init.body);
    const field = url.includes('/total-calories/') ? 'totalCalories' : 'activeEnergyBurned';
    return response({ rollupDataPoints: [{ startTime: range.startTime,
      endTime: new Date(Date.parse(range.startTime) + 60000).toISOString(), [field]: { kcalSum: value } }] });
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler ? handler({ url, init, standard }) : standard(url, init);
  };
  const session = createGoogleHealthSession({
    clientId: 'synthetic-public-client.apps.googleusercontent.com',
    loadOAuth: async () => ({ initTokenClient(config) {
      configs.push(config);
      return { requestAccessToken(request) { oauthRequests.push(request); } };
    } }),
    verifyAccount: options => verifyGoogleHealthAccount({ ...options, fetchImpl }),
    readDay: options => getGoogleHealthDay({ ...options, fetchImpl }),
    now: () => new Date(time),
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    onChange: state => states.push(state),
  });
  session.setContext({ dateKey: '2026-10-23', visible: true, active: true });
  const authorize = (token = TOKEN_A, extra = {}) => {
    assert.equal(session.connect(), true);
    return configs.at(-1).callback({ access_token: token, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE, ...extra });
  };
  const advance = async milliseconds => {
    time += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= time) { timers.delete(id); timer.callback(); }
    }
    await tick();
  };
  t.after(() => session.dispose());
  return { session, configs, oauthRequests, calls, states, timers, authorize, advance, standard };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /synthetic-review-token|private-synthetic-identity/);
}

test('review: real session-to-connector flow needs a gesture and exposes neither tokens nor identity', async t => {
  const h = reviewHarness(t);
  let storageReads = 0;
  const previous = new Map();
  for (const key of ['localStorage', 'sessionStorage']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, get() { storageReads++; throw new Error('Storage must not be used'); } });
  }
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await h.session.prepare();
  assert.equal(h.calls.length, 0);
  assert.equal(h.configs.length, 0);
  await h.authorize();
  assert.equal(h.configs[0].scope, GOOGLE_HEALTH_SCOPE);
  assert.equal(h.configs[0].include_granted_scopes, false);
  assert.deepEqual(h.oauthRequests, [{ prompt: 'select_account' }]);
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), [
    '/v4/users/me/identity', '/v4/users/me/dataTypes/total-calories/dataPoints:rollUp',
    '/v4/users/me/dataTypes/active-energy-burned/dataPoints:rollUp',
  ]);
  assert.equal(h.session.getState().status, 'connected');
  assert.equal(h.session.getState().data.totalKcal, 5);
  assert.equal(h.session.getState().data.coverage.totalSeconds, 60);
  for (const { url, init } of h.calls) {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN_A}`);
    assert.equal(init.credentials, 'omit');
    assert.ok(!url.includes(TOKEN_A));
    if (init.body) {
      assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['dataSourceFamily', 'pageSize', 'range', 'windowSize']);
      assert.ok(!init.body.includes(TOKEN_A));
    }
  }
  const copy = h.session.getState();
  copy.data.totalKcal = 999;
  assert.equal(h.session.getState().data.totalKcal, 5);
  assertNoSecrets(h.states);
  assert.equal(storageReads, 0);
  h.session.disconnect();
  assert.equal(h.session.getState().data, null);
  assert.equal(h.timers.size, 0);
});

test('review: real proto-zero and absent active metric stay different through the session', async t => {
  const h = reviewHarness(t, ({ url, init, standard }) => {
    if (url.endsWith('/identity')) return standard(url, init);
    if (url.includes('/active-energy-burned/')) return response({});
    const { range } = JSON.parse(init.body);
    return response({ rollupDataPoints: [{ startTime: range.startTime,
      endTime: new Date(Date.parse(range.startTime) + 60000).toISOString(), totalCalories: {} }] });
  });
  await h.session.prepare(); await h.authorize();
  assert.equal(h.session.getState().data.totalKcal, 0);
  assert.equal(h.session.getState().data.activeKcal, null);
  assert.deepEqual(h.session.getState().data.coverage, { totalSeconds: 60, activeSeconds: 0, requestedSeconds: 180 });
});

test('review: revocation reported by the real API clears all displayed data and stops requests', async t => {
  let revoked = false;
  const h = reviewHarness(t, ({ url, init, standard }) => revoked
    ? response({ error: { message: TOKEN_A } }, 401) : standard(url, init));
  await h.session.prepare(); await h.authorize();
  revoked = true;
  await h.session.refresh();
  const count = h.calls.length;
  assert.equal(h.session.getState().status, 'expired');
  assert.equal(h.session.getState().data, null);
  assert.equal(h.session.getState().error.code, 'AUTH_REQUIRED');
  assert.equal(h.timers.size, 0);
  await h.advance(600000);
  await h.session.refresh();
  assert.equal(h.calls.length, count);
  assertNoSecrets(h.states);
});

test('review: unlinked identity blocks all calorie requests without leaking the raw response', async t => {
  const h = reviewHarness(t, () => response({ error: { message: TOKEN_A, details: [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCOUNT_NOT_LINKED',
    metadata: { healthUserId: 'private-synthetic-identity' },
  }] } }, 400));
  await h.session.prepare(); await h.authorize();
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].url.endsWith('/identity'));
  assert.equal(h.session.getState().status, 'account_not_linked');
  assert.equal(h.session.getState().data, null);
  assertNoSecrets(h.states);
});

test('review: an old account response cannot overwrite a newly authorized account', async t => {
  const pending = deferred();
  let oldArguments;
  const h = reviewHarness(t, ({ url, init, standard }) => {
    if (init.headers.Authorization === `Bearer ${TOKEN_A}` && url.includes('/total-calories/')) {
      oldArguments = { url, init }; return pending.promise;
    }
    return standard(url, init, init.headers.Authorization === `Bearer ${TOKEN_B}` ? 12 : 999);
  });
  await h.session.prepare();
  const old = h.authorize(); await tick();
  assert.ok(oldArguments);
  h.session.disconnect();
  await h.authorize(TOKEN_B);
  assert.equal(h.session.getState().data.totalKcal, 12);
  pending.resolve(h.standard(oldArguments.url, oldArguments.init, 999));
  await old;
  assert.equal(h.session.getState().data.totalKcal, 12);
  assert.ok(h.states.every(state => state.data?.totalKcal !== 999));
  assertNoSecrets(h.states);
});

test('review: token expiry during identity verification cannot establish a late connection', async t => {
  const pending = deferred();
  const h = reviewHarness(t, () => pending.promise);
  await h.session.prepare();
  const auth = h.authorize(TOKEN_A, { expires_in: 1 }); await tick();
  assert.equal(h.session.getState().status, 'verifying');
  await h.advance(1001);
  pending.resolve(response({ healthUserId: 'private-synthetic-identity' })); await auth;
  assert.equal(h.session.getState().status, 'expired');
  assert.equal(h.session.getState().data, null);
  assert.equal(h.calls.length, 1);
  assertNoSecrets(h.states);
});

test('review: expiry while the second metric is in flight rejects the entire late pair', async t => {
  const pending = deferred();
  let active;
  const h = reviewHarness(t, ({ url, init, standard }) => {
    if (url.includes('/active-energy-burned/')) { active = { url, init }; return pending.promise; }
    return standard(url, init);
  });
  await h.session.prepare();
  const auth = h.authorize(TOKEN_A, { expires_in: 1 }); await tick();
  assert.ok(active);
  await h.advance(1001);
  pending.resolve(h.standard(active.url, active.init)); await auth;
  assert.equal(h.session.getState().status, 'expired');
  assert.equal(h.session.getState().data, null);
  assert.ok(h.states.every(state => state.data === null));
});

test('review: failure of the second metric retains only the previous complete pair as stale', async t => {
  let failActive = false;
  const h = reviewHarness(t, ({ url, init, standard }) => {
    if (failActive && url.includes('/active-energy-burned/')) return response({ error: { message: TOKEN_A } }, 503);
    return standard(url, init, failActive ? 999 : 5);
  });
  await h.session.prepare(); await h.authorize();
  const previous = h.session.getState().data;
  failActive = true; await h.session.refresh();
  assert.deepEqual(h.session.getState().data, previous);
  assert.equal(h.session.getState().stale, true);
  assert.equal(h.session.getState().error.code, 'UNAVAILABLE');
  const count = h.calls.length;
  await h.advance(300000);
  assert.equal(h.calls.length, count);
  failActive = false; await h.session.refresh();
  assert.equal(h.session.getState().stale, false);
  assert.equal(h.session.getState().error, null);
  assertNoSecrets(h.states);
});
