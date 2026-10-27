import { searchFoodsUpstream } from '../src/food-search.js';

/** Public, fixed-provider search only. It never reads the diary, cookies or OAuth credentials. */
export function createFoodSearchHandler({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), searchImpl = searchFoodsUpstream } = {}) {
  const cache = new Map();
  const recent = [];
  const cacheMilliseconds = 5 * 60 * 1000;
  return async function handle(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = origin === 'https://gabrirosa.github.io' || origin === env.APP_ORIGIN;
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' });
    if (allowed) headers.set('Access-Control-Allow-Origin', origin);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    // Same deployment serves both the Worker app and the static GitHub Pages app.
    if (url.origin !== env.APP_ORIGIN || (origin && !allowed)) return reply({ error: 'FORBIDDEN' }, 403);
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const query = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
    const pageText = url.searchParams.get('page') || '1';
    const page = Number(pageText);
    if (query.length < 2 || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || !/^\d+$/.test(pageText) || !Number.isInteger(page) || page < 1 || page > 50
      || [...url.searchParams.keys()].some(key => !['q', 'page'].includes(key)) || url.searchParams.getAll('q').length !== 1 || url.searchParams.getAll('page').length > 1) return reply({ error: 'INVALID_QUERY' }, 400);
    const stamp = now();
    for (const [key, entry] of cache) if (stamp - entry.savedAt >= cacheMilliseconds) cache.delete(key);
    const key = JSON.stringify([query.toLocaleLowerCase('it'), page]);
    if (cache.has(key)) return reply(cache.get(key).value);
    // Best-effort isolate-local budget: cached requests do not consume upstream calls.
    while (recent.length && stamp - recent[0] >= 60000) recent.shift();
    if (recent.length >= 10) { headers.set('Retry-After', '60'); return reply({ error: 'RATE_LIMITED' }, 429); }
    recent.push(stamp);
    try {
      const value = await searchImpl(query, { page, signal: request.signal, fetchImpl });
      if (request.signal.aborted) return reply({ error: 'UPSTREAM_UNAVAILABLE' }, 502);
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { savedAt: now(), value });
      return reply(value);
    } catch (error) {
      const limited = error?.status === 429 || error?.code === 'RATE_LIMITED';
      if (limited) headers.set('Retry-After', '60');
      return reply({ error: limited ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE' }, limited ? 429 : 502);
    }
  };
}
