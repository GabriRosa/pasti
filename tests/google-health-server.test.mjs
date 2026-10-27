import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createGoogleHealthWorker } from '../server/worker.js';

const READ = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
const WRITE = 'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly';
const ORIGIN = 'https://pasti.example';
const cookieName = '__Host-pasti-health';
function harness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../server/migrations/0001_health_sessions.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      return { bind(...args) {
        return {
          first: async () => sqlite.prepare(sql).get(...args) ?? null,
          run: async () => sqlite.prepare(sql).run(...args),
        };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const item of statements) results.push(await item.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  let time = Date.UTC(2026, 9, 27, 10);
  const calls = [];
  const replies = [];
  const worker = createGoogleHealthWorker({ now: () => time, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const reply = replies.shift();
    assert.ok(reply, `Unexpected Google request ${url}`);
    return typeof reply === 'function' ? reply(url, init) : Response.json(reply.body, { status: reply.status || 200 });
  } });
  const env = { DB, APP_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), ASSETS: { fetch: async () => new Response('static') } };
  const request = (path, { cookies = '', method = 'POST', body, headers = {} } = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { Origin: ORIGIN, 'X-Pasti-Request': '1', 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  async function start(nutrition = false, session = '') {
    const res = await request('/api/health/start', { body: { nutrition }, cookies: session });
    assert.equal(res.status, 200);
    const data = await res.json();
    const url = new URL(data.url);
    return { url, flow: cookies(res), state: url.searchParams.get('state') };
  }
  const token = (nutrition = false, extra = {}) => ({ body: { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'Bearer', scope: nutrition ? `${READ} ${WRITE}` : READ, ...extra } });
  async function login({ nutrition = false, session = '', identity = 'health-user-1' } = {}) {
    const flow = await start(nutrition, session);
    replies.push(token(nutrition), { body: { healthUserId: identity } });
    const res = await request(`/api/health/callback?code=test-code&state=${flow.state}`, { method: 'GET', cookies: [session, flow.flow].filter(Boolean).join('; ') });
    return { res, session: cookies(res).split('; ').filter(value => value.startsWith(`${cookieName}=`)).join('; '), flow };
  }
  return { sqlite, env, worker, replies, calls, request, cookies, start, token, login, advance: ms => { time += ms; } };
}

test('offline authorization uses PKCE, exact scopes and secure browser-bound cookie', async () => {
  const h = harness();
  const { url, flow, state } = await h.start();
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), READ);
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/health/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.match(state, /^[\w-]{43}$/);
  const stored = h.sqlite.prepare('SELECT * FROM health_oauth_states').get();
  assert.notEqual(stored.id, state);
  assert.ok(!stored.payload.includes('verifier'));
  const wrong = await h.request(`/api/health/callback?code=stolen&state=${state}`, { method: 'GET' });
  assert.match(wrong.headers.get('Location'), /health_error=AUTH_CANCELLED/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.sqlite.prepare('SELECT consumed FROM health_oauth_states').get().consumed, 0);
  assert.match(flow, /^__Host-pasti-oauth=/);
});

test('login rotates opaque session; access restored without exposing refresh token or storing plaintext', async () => {
  const h = harness();
  const { res, session, flow } = await h.login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), `${ORIGIN}/#today`);
  const setCookie = res.headers.getSetCookie().find(value => value.startsWith(cookieName));
  assert.match(setCookie, /Secure; HttpOnly; SameSite=Lax; Max-Age=7776000/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  const row = h.sqlite.prepare('SELECT * FROM health_sessions').get();
  assert.ok(!row.payload.includes('access-secret'));
  assert.ok(!row.payload.includes('refresh-secret'));
  assert.ok(!row.payload.includes('health-user-1'));
  assert.notEqual(row.id, session.split('=')[1]);
  const restored = await h.request('/api/health/session', { cookies: session });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { access_token: 'access-secret', expires_in: 3600, scope: READ, healthUserId: 'health-user-1' });
  assert.equal(h.calls.length, 2);
  const exchange = new URLSearchParams(h.calls[0].init.body);
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.get('code_verifier')))).toString('base64url');
  assert.equal(challenge, flow.url.searchParams.get('code_challenge'));
  const replay = await h.request(`/api/health/callback?code=test-code&state=${flow.state}`, { method: 'GET', cookies: flow.flow });
  assert.match(replay.headers.get('Location'), /AUTH_CANCELLED/);
  assert.equal(h.calls.length, 2);
});

test('all mutation and credential endpoints reject cross-origin, missing header, wrong methods and unknown API paths', async () => {
  const h = harness();
  for (const path of ['start', 'session', 'disconnect']) {
    assert.equal((await h.request(`/api/health/${path}`, { headers: { Origin: 'https://evil.example' }, body: { nutrition: false } })).status, 403);
    assert.equal((await h.request(`/api/health/${path}`, { headers: { 'X-Pasti-Request': '' }, body: { nutrition: false } })).status, 403);
    assert.equal((await h.request(`/api/health/${path}`, { method: 'GET' })).status, 405);
  }
  assert.equal((await h.request('/api/unknown')).status, 404);
  assert.equal(await (await h.request('/assets/icon.svg', { method: 'GET' })).text(), 'static');
  assert.equal(h.calls.length, 0);
});

test('expired state, duplicate parameters and cancellation never exchange an OAuth code', async () => {
  for (const suffix of ['&state=duplicate', '&error=access_denied', '&code=duplicate', '']) {
    const h = harness();
    const flow = await h.start();
    if (!suffix) h.advance(600001);
    const res = await h.request(`/api/health/callback?code=test&state=${flow.state}${suffix}`, { method: 'GET', cookies: flow.flow });
    assert.match(res.headers.get('Location'), /AUTH_CANCELLED/);
    assert.equal(h.calls.length, 0);
  }
});

test('short lived access renews from encrypted refresh token and preserves omitted refresh/scope', async () => {
  const h = harness();
  const { session } = await h.login();
  h.advance(3510000);
  h.replies.push(h.token(false, { access_token: 'new-access', refresh_token: undefined, scope: undefined }));
  const response = await h.request('/api/health/session', { cookies: session });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_token, 'new-access');
  const params = new URLSearchParams(h.calls[2].init.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'refresh-secret');
  assert.equal(params.get('client_secret'), 'test-client-secret');
  assert.equal(h.sqlite.prepare('SELECT refresh_owner FROM health_sessions').get().refresh_owner, null);
});

test('revocation deletes unusable session, transient outage retains it for retry', async () => {
  for (const revoked of [false, true]) {
    const h = harness();
    const { session } = await h.login();
    h.advance(3600000);
    h.replies.push({ status: revoked ? 400 : 500, body: { error: revoked ? 'invalid_grant' : 'temporarily_unavailable' } });
    const res = await h.request('/api/health/session', { cookies: session });
    assert.equal(res.status, revoked ? 401 : 503);
    assert.deepEqual(await res.json(), { error: revoked ? 'AUTH_REQUIRED' : 'UNAVAILABLE' });
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_sessions').get().n, revoked ? 0 : 1);
  }
});

test('nutrition escalation requires existing session and same Google Health identity', async () => {
  const h = harness();
  const noSession = await h.request('/api/health/start', { body: { nutrition: true } });
  assert.equal(noSession.status, 401);
  const { session } = await h.login();
  const wrong = await h.login({ nutrition: true, session, identity: 'other-user' });
  assert.match(wrong.res.headers.get('Location'), /ACCOUNT_CHANGED/);
  const original = await h.request('/api/health/session', { cookies: session });
  assert.equal((await original.json()).scope, READ);
  const upgraded = await h.login({ nutrition: true, session });
  assert.equal(upgraded.res.headers.get('Location'), `${ORIGIN}/#today`);
  assert.notEqual(upgraded.session, session);
  const restored = await h.request('/api/health/session', { cookies: upgraded.session });
  assert.equal((await restored.json()).scope, `${READ} ${WRITE}`);
  assert.equal((await h.request('/api/health/session', { cookies: session })).status, 401);
});

test('unexpected scope and missing offline access reject login without disturbing existing session', async () => {
  for (const tokenOverride of [{ scope: `${READ} ${WRITE}` }, { refresh_token: undefined }, { token_type: 'Basic' }]) {
    const h = harness();
    const { session } = await h.login();
    const flow = await h.start(false, session);
    h.replies.push(h.token(false, tokenOverride));
    const res = await h.request(`/api/health/callback?code=test&state=${flow.state}`, { method: 'GET', cookies: `${session}; ${flow.flow}` });
    assert.match(res.headers.get('Location'), /health_error=/);
    assert.equal((await h.request('/api/health/session', { cookies: session })).status, 200);
  }
});

test('ciphertext copied to a different session is rejected, never decrypted for another cookie', async () => {
  const h = harness();
  const first = await h.login();
  const second = await h.login();
  const rows = h.sqlite.prepare('SELECT id,payload FROM health_sessions').all();
  h.sqlite.prepare('UPDATE health_sessions SET payload = ? WHERE id = ?').run(rows[0].payload, rows[1].id);
  assert.equal((await h.request('/api/health/session', { cookies: second.session })).status, 503);
  assert.equal((await h.request('/api/health/session', { cookies: first.session })).status, 200);
});

test('disconnect clears session and pending flow, preventing late callback resurrection', async () => {
  const h = harness();
  const { session } = await h.login();
  const flow = await h.start(true, session);
  const disconnected = await h.request('/api/health/disconnect', { cookies: `${session}; ${flow.flow}` });
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.headers.getSetCookie().length, 2);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_sessions').get().n, 0);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_oauth_states').get().n, 0);
  const late = await h.request(`/api/health/callback?code=test&state=${flow.state}`, { method: 'GET', cookies: `${session}; ${flow.flow}` });
  assert.match(late.headers.get('Location'), /AUTH_CANCELLED/);
});

test('logout while initial code exchange is in flight also prevents session creation', async () => {
  const h = harness();
  const flow = await h.start();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.replies.push(() => new Promise(resolve => { release = () => resolve(Response.json(h.token().body)); entered(); }), { body: { healthUserId: 'health-user-1' } });
  const pending = h.request(`/api/health/callback?code=test&state=${flow.state}`, { method: 'GET', cookies: flow.flow });
  await started;
  await h.request('/api/health/disconnect', { cookies: flow.flow });
  release();
  const result = await pending;
  assert.match(result.headers.get('Location'), /AUTH_CANCELLED/);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_sessions').get().n, 0);
});

test('concurrent refresh calls use one lease; logout does not resurrect deleted session', async () => {
  const h = harness();
  const { session } = await h.login();
  h.advance(3600000);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.replies.push(() => new Promise(resolve => { release = () => resolve(Response.json(h.token().body)); entered(); }));
  const pending = h.request('/api/health/session', { cookies: session });
  await started;
  assert.equal((await h.request('/api/health/session', { cookies: session })).status, 503);
  assert.equal(h.calls.length, 3);
  await h.request('/api/health/disconnect', { cookies: session });
  release();
  assert.equal((await pending).status, 401);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_sessions').get().n, 0);
});

test('90 days without use expires the cookie-backed server session', async () => {
  const h = harness();
  const { session } = await h.login();
  h.advance(90 * 86400000 + 1);
  assert.equal((await h.request('/api/health/session', { cookies: session })).status, 401);
  assert.equal(h.calls.length, 2);
});

test('oversized or malformed Google replies and invalid configuration fail without leaking details', async () => {
  for (const reply of [() => new Response('not json secret'), () => new Response('x'.repeat(17000))]) {
    const h = harness();
    const flow = await h.start();
    h.replies.push(reply);
    const res = await h.request(`/api/health/callback?code=test&state=${flow.state}`, { method: 'GET', cookies: flow.flow });
    assert.equal(res.headers.get('Location'), `${ORIGIN}/?health_error=INVALID_RESPONSE#today`);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_sessions').get().n, 0);
  }
  const h = harness();
  h.env.TOKEN_ENCRYPTION_KEY = 'not a key';
  const res = await h.request('/api/health/session');
  assert.deepEqual(await res.json(), { error: 'UNAVAILABLE' });
  assert.equal(res.status, 503);
});

test('a delayed stale reader reuses credentials renewed before it acquired the refresh lease', async () => {
  const h = harness();
  const { session } = await h.login();
  h.advance(3600000);
  const prepare = h.env.DB.prepare.bind(h.env.DB);
  let pauseNextRead = true;
  let releaseRead;
  let signalRead;
  const captured = new Promise(resolve => { signalRead = resolve; });
  const released = new Promise(resolve => { releaseRead = resolve; });
  h.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT * FROM health_sessions')) return statement;
    return { bind(...args) {
      const bound = statement.bind(...args);
      return { ...bound, async first() {
        const result = await bound.first();
        if (pauseNextRead) {
          pauseNextRead = false;
          signalRead();
          await released;
        }
        return result;
      } };
    } };
  };
  const staleReader = h.request('/api/health/session', { cookies: session });
  await captured;
  h.replies.push(h.token(false, { access_token: 'rotated-access', refresh_token: 'rotated-refresh' }));
  const renewed = await h.request('/api/health/session', { cookies: session });
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).access_token, 'rotated-access');
  // Reusing the old refresh token would invalidate the otherwise healthy session.
  h.replies.push({ status: 400, body: { error: 'invalid_grant' } });
  releaseRead();
  const delayed = await staleReader;
  assert.equal(delayed.status, 200);
  assert.equal((await delayed.json()).access_token, 'rotated-access');
  assert.equal(h.calls.length, 3, 'two login calls plus exactly one refresh');
  assert.equal(h.replies.length, 1, 'the stale token was never exchanged');
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM health_sessions').get().n, 1);
  assert.equal(h.sqlite.prepare('SELECT refresh_owner FROM health_sessions').get().refresh_owner, null);
});

test('callback lifetime starts after token response, not before the OAuth exchange', async () => {
  const h = harness();
  const flow = await h.start();
  h.replies.push(() => { h.advance(10000); return Response.json(h.token().body); }, { body: { healthUserId: 'health-user-1' } });
  const callback = await h.request(`/api/health/callback?code=test&state=${flow.state}`, { method: 'GET', cookies: flow.flow });
  const session = h.cookies(callback).split('; ').find(value => value.startsWith(`${cookieName}=`));
  const restored = await h.request('/api/health/session', { cookies: session });
  assert.equal((await restored.json()).expires_in, 3600);
});
