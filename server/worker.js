const READ_SCOPE = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly';
const SESSION_COOKIE = '__Host-pasti-health';
const FLOW_COOKIE = '__Host-pasti-oauth';
const SESSION_SECONDS = 90 * 24 * 60 * 60;
const FLOW_SECONDS = 600;
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const IDENTITY_ENDPOINT = 'https://health.googleapis.com/v4/users/me/identity';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fail = (code = 'UNAVAILABLE', status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const tokenValue = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/\s/.test(value);
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => b64(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function readCookie(request, name) {
  const entries = (request.headers.get('Cookie') || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(name.length + 1);
  return opaque(value) ? value : null;
}
function headers(cookies = []) {
  const result = new Headers({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  for (const value of cookies) result.append('Set-Cookie', value);
  return result;
}
function json(value, status = 200, cookies = []) {
  const result = headers(cookies);
  result.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers: result });
}
function redirect(origin, error, cookies = []) {
  const result = headers(cookies);
  result.set('Location', `${origin}/${error ? `?health_error=${encodeURIComponent(error)}` : ''}#today`);
  return new Response(null, { status: 303, headers: result });
}
async function boundedJson(response, limit) {
  if (Number(response.headers.get('Content-Length')) > limit) fail('INVALID_RESPONSE', 502);
  if (!response.body) fail('INVALID_RESPONSE', 502);
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('INVALID_RESPONSE', 502);
      chunks.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(decoder.decode(buffer));
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_RESPONSE', 502);
    return data;
  } catch (error) {
    try { await reader.cancel(); } catch { /* The stream may already be closed. */ }
    if (error?.code) throw error;
    fail('INVALID_RESPONSE', 502);
  } finally { reader.releaseLock(); }
}
async function cryptoBox(secret) {
  let bytes;
  try { bytes = unb64(secret); } catch { fail(); }
  if (bytes.length !== 32) fail();
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return {
    async seal(value, id) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, encoder.encode(JSON.stringify(value)));
      return `${b64(iv)}.${b64(data)}`;
    },
    async open(value, id) {
      try {
        const [iv, data, extra] = value.split('.');
        if (extra !== undefined || unb64(iv).length !== 12) fail();
        return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(id) }, key, unb64(data))));
      } catch { fail(); }
    },
  };
}
function validateScopes(value, nutrition) {
  const expected = nutrition ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE];
  const scopes = typeof value === 'string' ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
  if (scopes.length !== expected.length || expected.some(scope => !scopes.includes(scope))) fail('ACCESS_DENIED', 403);
  return expected.join(' ');
}
function credentials(response, nutrition, now, previous = null) {
  const scope = validateScopes(response.scope ?? previous?.scope, nutrition);
  const seconds = Number(response.expires_in);
  if (!tokenValue(response.access_token) || !['number', 'string'].includes(typeof response.expires_in) || !Number.isFinite(seconds) || seconds < 120 || seconds > 86400 || String(response.token_type).toLowerCase() !== 'bearer') fail('INVALID_RESPONSE', 502);
  const refresh = response.refresh_token ?? previous?.refresh;
  if (!tokenValue(refresh)) fail('OFFLINE_ACCESS_REQUIRED', 403);
  return { access: response.access_token, refresh, scope, expiry: now + seconds * 1000, nutrition };
}

/** Same-origin auth service. Dependency injection keeps real Google credentials out of tests. */
export function createGoogleHealthWorker({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  async function google(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      const data = await boundedJson(response, 16384);
      if (!response.ok) {
        if (data.error === 'invalid_grant') fail('AUTH_REQUIRED', 401);
        if (response.status === 401) fail('AUTH_REQUIRED', 401);
        if (response.status === 403) fail('ACCESS_DENIED', 403);
        if (url === IDENTITY_ENDPOINT && response.status === 404) fail('ACCOUNT_NOT_LINKED', 403);
        fail();
      }
      return data;
    } catch (error) { if (error?.code && error?.status) throw error; fail(); }
    finally { clearTimeout(timer); }
  }
  const exchange = params => google(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      let origin;
      let callback = false;
      let claimedStateId = null;
      try {
        origin = new URL(env.APP_ORIGIN).origin;
        if (origin !== env.APP_ORIGIN || !origin.startsWith('https://') || url.origin !== origin || !env.DB || !tokenValue(env.GOOGLE_CLIENT_ID) || !tokenValue(env.GOOGLE_CLIENT_SECRET)) fail();
        const paths = ['/api/health/start', '/api/health/callback', '/api/health/session', '/api/health/disconnect'];
        if (!paths.includes(url.pathname)) return json({ error: 'NOT_FOUND' }, 404);
        callback = url.pathname === '/api/health/callback';
        if (request.method !== (callback ? 'GET' : 'POST')) return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
        if (!callback && (request.headers.get('Origin') !== origin || request.headers.get('X-Pasti-Request') !== '1')) return json({ error: 'FORBIDDEN' }, 403);
        const box = await cryptoBox(env.TOKEN_ENCRYPTION_KEY);
        const stamp = now();
        const sessionToken = readCookie(request, SESSION_COOKIE);
        const sessionId = sessionToken ? await hash(sessionToken) : null;
        const stmt = (sql, ...args) => env.DB.prepare(sql).bind(...args);
        const current = async () => {
          if (!sessionId) return null;
          const row = await stmt('SELECT * FROM health_sessions WHERE id = ? AND expires_at > ?', sessionId, stamp).first();
          if (!row) return null;
          return { ...row, data: await box.open(row.payload, `session:${sessionId}`) };
        };
        if (url.pathname === '/api/health/disconnect') {
          // Cancel pending authorizations too: a late callback must not sign the user back in.
          const flow = readCookie(request, FLOW_COOKIE);
          if (sessionId) await stmt('DELETE FROM health_sessions WHERE id = ?', sessionId).run();
          if (flow) await stmt('DELETE FROM health_oauth_states WHERE browser_hash = ?', await hash(flow)).run();
          return json({ disconnected: true }, 200, [cookie(SESSION_COOKIE, '', 0), cookie(FLOW_COOKIE, '', 0)]);
        }
        if (url.pathname === '/api/health/start') {
          if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'INVALID_INPUT' }, 400);
          let body;
          try { body = await boundedJson(request, 1024); } catch { return json({ error: 'INVALID_INPUT' }, 400); }
          if (typeof body.nutrition !== 'boolean') return json({ error: 'INVALID_INPUT' }, 400);
          const old = await current();
          if (body.nutrition && !old) fail('AUTH_REQUIRED', 401);
          const state = random(), flow = random(), verifier = random();
          const id = await hash(state);
          const payload = await box.seal({ verifier, nutrition: body.nutrition, previous: old ? sessionId : null, expectedUser: body.nutrition ? old.data.healthUserId : null }, `state:${id}`);
          const oldFlow = readCookie(request, FLOW_COOKIE);
          await env.DB.batch([
            stmt('DELETE FROM health_oauth_states WHERE expires_at <= ?', stamp),
            stmt('DELETE FROM health_sessions WHERE expires_at <= ?', stamp),
            ...(oldFlow ? [stmt('DELETE FROM health_oauth_states WHERE browser_hash = ?', await hash(oldFlow))] : []),
            stmt('INSERT INTO health_oauth_states (id, browser_hash, payload, expires_at) VALUES (?, ?, ?, ?)', id, await hash(flow), payload, stamp + FLOW_SECONDS * 1000),
          ]);
          const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          auth.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/health/callback`, response_type: 'code', scope: body.nutrition ? `${READ_SCOPE} ${WRITE_SCOPE}` : READ_SCOPE, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state, code_challenge: await hash(verifier), code_challenge_method: 'S256' }).toString();
          return json({ url: auth.href }, 200, [cookie(FLOW_COOKIE, flow, FLOW_SECONDS)]);
        }
        if (callback) {
          const state = url.searchParams.get('state');
          const flow = readCookie(request, FLOW_COOKIE);
          if (!opaque(state) || !flow || url.searchParams.getAll('state').length !== 1) fail('AUTH_CANCELLED', 400);
          const stateId = await hash(state);
          // Atomic claiming permits one exchange; retaining the row lets logout cancel an in-flight callback.
          const row = await stmt('UPDATE health_oauth_states SET consumed = 1 WHERE id = ? AND browser_hash = ? AND expires_at > ? AND consumed = 0 RETURNING payload', stateId, await hash(flow), stamp).first();
          if (!row) fail('AUTH_CANCELLED', 400);
          claimedStateId = stateId;
          const flowData = await box.open(row.payload, `state:${stateId}`);
          const old = await current();
          if ((old ? sessionId : null) !== flowData.previous) fail('AUTH_CANCELLED', 400);
          if (url.searchParams.has('error')) fail('AUTH_CANCELLED', 400);
          const code = url.searchParams.get('code');
          if (!tokenValue(code) || url.searchParams.getAll('code').length !== 1) fail('AUTH_CANCELLED', 400);
          const reply = await exchange({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, code_verifier: flowData.verifier, grant_type: 'authorization_code', redirect_uri: `${origin}/api/health/callback` });
          // A new consent must actually issue offline access; never borrow a token from a different grant.
          const data = credentials(reply, flowData.nutrition, now());
          const identity = await google(IDENTITY_ENDPOINT, { headers: { Authorization: `Bearer ${data.access}` } });
          if (typeof identity.healthUserId !== 'string' || !/^[A-Za-z0-9-]{1,63}$/.test(identity.healthUserId)) fail('ACCOUNT_NOT_LINKED', 403);
          if (flowData.expectedUser && flowData.expectedUser !== identity.healthUserId) fail('ACCOUNT_CHANGED', 403);
          data.healthUserId = identity.healthUserId;
          const newToken = random(), newId = await hash(newToken);
          const encrypted = await box.seal(data, `session:${newId}`);
          // Detect logout/account change during Google network calls before saving a replacement session.
          if (flowData.previous && !(await current())) fail('AUTH_CANCELLED', 400);
          await env.DB.batch([
            stmt('INSERT INTO health_sessions (id, payload, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM health_oauth_states WHERE id = ? AND consumed = 1) AND (? IS NULL OR EXISTS (SELECT 1 FROM health_sessions WHERE id = ?))', newId, encrypted, now() + SESSION_SECONDS * 1000, stateId, flowData.previous, flowData.previous),
            ...(flowData.previous ? [stmt('DELETE FROM health_sessions WHERE id = ? AND EXISTS (SELECT 1 FROM health_sessions WHERE id = ?)', flowData.previous, newId)] : []),
            stmt('DELETE FROM health_oauth_states WHERE id = ?', stateId),
          ]);
          if (!(await stmt('SELECT id FROM health_sessions WHERE id = ?', newId).first())) fail('AUTH_CANCELLED', 400);
          return redirect(origin, null, [cookie(SESSION_COOKIE, newToken, SESSION_SECONDS), cookie(FLOW_COOKIE, '', 0)]);
        }
        const row = await current();
        if (!row) return json({ error: 'AUTH_REQUIRED' }, 401, [cookie(SESSION_COOKIE, '', 0)]);
        let data = row.data;
        if (data.expiry - stamp <= 90000) {
          // A D1 lease serializes refreshes across Worker instances. Failed requests can retry after it expires.
          const owner = random();
          const leaseTime = now();
          const lease = await stmt('UPDATE health_sessions SET refresh_owner = ?, refresh_until = ? WHERE id = ? AND expires_at > ? AND refresh_until <= ? RETURNING payload', owner, leaseTime + 30000, sessionId, leaseTime, leaseTime).first();
          if (!lease) return json({ error: 'UNAVAILABLE' }, 503);
          try {
            // Another request may have renewed between our first read and acquiring this lease.
            // The payload returned by the atomic lease update is the authoritative credential.
            data = await box.open(lease.payload, `session:${sessionId}`);
            if (data.expiry - now() <= 90000) {
              const reply = await exchange({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: data.refresh, grant_type: 'refresh_token' });
              data = { ...credentials(reply, data.nutrition, now(), data), healthUserId: data.healthUserId };
            }
            const changed = await stmt('UPDATE health_sessions SET payload = ?, expires_at = ?, refresh_owner = NULL, refresh_until = 0 WHERE id = ? AND refresh_owner = ? RETURNING id', await box.seal(data, `session:${sessionId}`), now() + SESSION_SECONDS * 1000, sessionId, owner).first();
            if (!changed) fail('AUTH_REQUIRED', 401);
          } catch (error) {
            if (error?.code === 'AUTH_REQUIRED' || error?.code === 'ACCESS_DENIED') await stmt('DELETE FROM health_sessions WHERE id = ? AND refresh_owner = ?', sessionId, owner).run();
            else await stmt('UPDATE health_sessions SET refresh_owner = NULL, refresh_until = 0 WHERE id = ? AND refresh_owner = ?', sessionId, owner).run();
            throw error;
          }
        } else {
          const changed = await stmt('UPDATE health_sessions SET expires_at = ? WHERE id = ? RETURNING id', stamp + SESSION_SECONDS * 1000, sessionId).first();
          if (!changed) fail('AUTH_REQUIRED', 401);
        }
        return json({ access_token: data.access, expires_in: Math.max(0, Math.floor((data.expiry - now()) / 1000)), scope: data.scope, healthUserId: data.healthUserId }, 200, [cookie(SESSION_COOKIE, sessionToken, SESSION_SECONDS)]);
      } catch (error) {
        const allowed = ['AUTH_REQUIRED', 'AUTH_CANCELLED', 'ACCESS_DENIED', 'ACCOUNT_CHANGED', 'ACCOUNT_NOT_LINKED', 'OFFLINE_ACCESS_REQUIRED', 'INVALID_RESPONSE'];
        const code = allowed.includes(error?.code) ? error.code : 'UNAVAILABLE';
        if (claimedStateId) { try { await env.DB.prepare('DELETE FROM health_oauth_states WHERE id = ?').bind(claimedStateId).run(); } catch { /* The row remains unusable and expires after ten minutes. */ } }
        if (callback && origin) return redirect(origin, code, [cookie(FLOW_COOKIE, '', 0)]);
        return json({ error: code }, allowed.includes(error?.code) ? error.status : 503, code === 'AUTH_REQUIRED' ? [cookie(SESSION_COOKIE, '', 0)] : []);
      }
    },
  };
}
export default createGoogleHealthWorker();
