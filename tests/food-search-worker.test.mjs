import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoodSearchHandler } from '../server/food-search.js';
import { createGoogleHealthWorker } from '../server/worker.js';
const env = { APP_ORIGIN: 'https://pasti.gabri-rosso02.workers.dev' };
const result = { items: [{ barcode: '3017620422003', name: 'Nutella', brand: 'Ferrero' }], page: 1, hasMore: false };
const request = (query = 'yogurt', origin = 'https://gabrirosa.github.io', extra = '') => new Request(`${env.APP_ORIGIN}/api/foods/search?q=${encodeURIComponent(query)}${extra}`, { headers: origin ? { Origin: origin, Cookie: 'private-session=not-forwarded' } : {} });

test('food search exposes only expected CORS origins and uses no health credentials', async () => {
  const calls = [];
  const handler = createFoodSearchHandler({ searchImpl: async (q, opts) => { calls.push([q, opts]); return result; } });
  for (const origin of ['https://gabrirosa.github.io', env.APP_ORIGIN]) {
    const response = await handler(request('yogurt', origin), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.deepEqual(await response.json(), result);
  }
  assert.equal(calls.length, 1, 'Second origin uses the public product cache');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['fetchImpl', 'page', 'signal']);
  const foreign = await handler(request('yogurt', 'https://example.com'), env);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls.length, 1);
});

test('food search preflight and unsupported methods do not call the upstream', async () => {
  const handler = createFoodSearchHandler({ searchImpl: async () => { assert.fail('Unexpected upstream call'); } });
  const options = await handler(new Request(`${env.APP_ORIGIN}/api/foods/search`, { method: 'OPTIONS', headers: { Origin: 'https://gabrirosa.github.io' } }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal((await handler(new Request(`${env.APP_ORIGIN}/api/foods/search?q=yogurt`, { method: 'POST' }), env)).status, 405);
});

test('food search validates query, page, duplicates and rejects arbitrary destination parameters', async () => {
  const handler = createFoodSearchHandler({ searchImpl: async () => { assert.fail('Unexpected upstream call'); } });
  for (const params of ['q=a', `q=${'x'.repeat(101)}`, 'q=yogurt&page=0', 'q=yogurt&page=51', 'q=yogurt&page=1.5', 'q=yogurt&q=latte', 'q=yogurt&page=1&page=2', 'q=yogurt&url=https://example.com']) {
    const response = await handler(new Request(`${env.APP_ORIGIN}/api/foods/search?${params}`), env);
    assert.equal(response.status, 400, params);
  }
  assert.equal((await handler(new Request('https://example.com/api/foods/search?q=yogurt'), env)).status, 403);
});

test('public food cache expires and the upstream budget recovers after one minute', async () => {
  let stamp = 0, calls = 0;
  const handler = createFoodSearchHandler({ now: () => stamp, searchImpl: async () => { calls++; return result; } });
  for (let i = 0; i < 10; i++) assert.equal((await handler(request(`food ${i}`), env)).status, 200);
  assert.equal((await handler(request('food 0'), env)).status, 200, 'Cached calls remain usable');
  const limited = await handler(request('uncached food'), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.equal(calls, 10);
  stamp = 60001;
  assert.equal((await handler(request('uncached food'), env)).status, 200);
  stamp = 300001;
  assert.equal((await handler(request('food 0'), env)).status, 200);
  assert.equal(calls, 12);
});

test('upstream failures are not cached or exposed and keep retryable status', async () => {
  let calls = 0;
  const handler = createFoodSearchHandler({ searchImpl: async () => { calls++; throw Object.assign(new Error('private upstream details'), { status: calls === 1 ? 429 : 500 }); } });
  const limited = await handler(request(), env);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'RATE_LIMITED' });
  const unavailable = await handler(request(), env);
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), { error: 'UPSTREAM_UNAVAILABLE' });
  assert.equal(calls, 2);
});

test('cancelled client search does not become a cached result', async () => {
  let resolve, calls = 0;
  const controller = new AbortController();
  const handler = createFoodSearchHandler({ searchImpl: async (_q, opts) => {
    calls++; assert.equal(opts.signal.aborted, false);
    if (calls === 1) return new Promise(r => { resolve = r; });
    return result;
  } });
  const pending = handler(new Request(`${env.APP_ORIGIN}/api/foods/search?q=yogurt`, { signal: controller.signal }), env);
  controller.abort(); resolve(result);
  assert.equal((await pending).status, 502);
  assert.equal((await handler(request(), env)).status, 200);
  assert.equal(calls, 2);
});

test('Worker routes public search independently of Google OAuth configuration', async () => {
  const worker = createGoogleHealthWorker({ fetchImpl: async () => { throw new Error('No live network in test'); } });
  const invalid = await worker.fetch(request('x'), env);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'INVALID_QUERY' });
  const foreign = await worker.fetch(request('yogurt', 'https://example.com'), env);
  assert.equal(foreign.status, 403);
});
