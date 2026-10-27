import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFoods, searchFoodsUpstream } from '../src/food-search.js';

const code = '4056489759096';
const secondCode = '036000291452';
const product = (changes = {}) => ({ code, product_name: 'Yogurt', brands: ['Marca'], ...changes });
const body = (hits = [product()], changes = {}) => ({ hits, page: 1, page_size: 20, page_count: 1, count: hits.length, is_count_exact: true, timed_out: false, ...changes });
const ok = payload => ({ ok: true, status: 200, json: async () => payload });
const fetchBody = payload => async () => ok(payload);

test('search sends only encoded names, bounded fields and anonymous request options', async () => {
  await searchFoodsUpstream('  yogurt   caffè & cacao  ', { page: 2, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://search.openfoodfacts.org');
    assert.equal(parsed.pathname, '/search');
    assert.equal(parsed.searchParams.get('q'), 'yogurt caffè \\& cacao');
    assert.equal(parsed.searchParams.get('page'), '2');
    assert.equal(parsed.searchParams.get('page_size'), '20');
    assert.equal(parsed.searchParams.get('langs'), 'it,en');
    assert.equal(parsed.searchParams.get('fields'), 'code,product_name,product_name_it,product_name_en,brands');
    assert.deepEqual(Object.keys(options).sort(), ['credentials', 'redirect', 'referrerPolicy', 'signal']);
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'manual');
    return ok(body());
  } });
});

test('query syntax in product names is escaped and cannot inject Lucene filters', async () => {
  await searchFoodsUpstream('marca:"bio" OR code:*', { fetchImpl: async url => {
    assert.equal(new URL(url).searchParams.get('q'), String.raw`marca\:\"bio\" or code\:\*`);
    return ok(body());
  } });
});

test('invalid query and page inputs never reach the network', async () => {
  const fetchImpl = () => assert.fail('invalid input must not make a request');
  for (const query of ['', ' a ', 'a'.repeat(101), null, {}, 'ab\u0000cd']) await assert.rejects(searchFoodsUpstream(query, { fetchImpl }), /2.*100/);
  for (const page of [0, -1, 1.5, 51, Infinity, NaN, '1', null]) await assert.rejects(searchFoodsUpstream('yogurt', { page, fetchImpl }), /Pagina/);
});

test('Italian name wins, brands accept arrays or strings, summaries contain no nutrition', async () => {
  const hits = [
    product({ product_name_it: '  Yogurt italiano  ', brands: ['  Marca ', null, '', 'Linea'], nutriments: { energy_100g: 42 }, nutrition: { aggregated_set: {} } }),
    product({ code: secondCode, product_name: '', product_name_en: 'English name', brands: '  Altra marca ' }),
    product({ code: '96385074', product_name: undefined, brands: {} })
  ];
  const result = await searchFoodsUpstream('yogurt', { fetchImpl: fetchBody(body(hits)) });
  assert.deepEqual(result, { items: [
    { barcode: code, name: 'Yogurt italiano', brand: 'Marca, Linea' },
    { barcode: secondCode, name: 'English name', brand: 'Altra marca' },
    { barcode: '96385074', name: 'Prodotto 96385074', brand: '' }
  ], page: 1, hasMore: false });
});

test('codes are normalized, checked and deduplicated while leading zeroes survive', async () => {
  const hits = [null, {}, product({ code: '4056 4897-59096' }), product(), product({ code: secondCode }), product({ code: 36000291452 }), product({ code: '4056489759095' }), product({ code: 'https://example.com' })];
  const result = await searchFoodsUpstream('yogurt', { fetchImpl: fetchBody(body(hits)) });
  assert.deepEqual(result.items.map(item => item.barcode), [code, secondCode]);
});

test('untrusted summaries are bounded and oversized result pages are not exposed', async () => {
  const hits = [product({ product_name_it: 'x'.repeat(500), brands: ['b'.repeat(500)] }), ...Array.from({ length: 19 }, () => product({ code: 'invalid' })), product({ code: secondCode })];
  const { items } = await searchFoodsUpstream('yogurt', { fetchImpl: fetchBody(body(hits)) });
  assert.equal(items.length, 1); assert.equal(items[0].name.length, 200); assert.equal(items[0].brand.length, 200);
});

test('pagination uses exact totals, inexact page counts and raw hits before filtering', async () => {
  const cases = [
    [body([], { count: 0, page_count: 0 }), 1, false],
    [body([product()], { count: 21, page_count: 2 }), 1, true],
    [body([product()], { count: 21, page_count: 2 }), 2, false],
    [body([product({ code: 'invalid' })], { count: 10000, page_count: 500, is_count_exact: false }), 1, true],
    [body([product()], { count: 10000, page_count: 500, is_count_exact: false }), 50, false],
    [body(Array.from({ length: 20 }, () => product()), { count: undefined, page_count: undefined, is_count_exact: false }), 1, true],
    [body([product()], { count: undefined, page_count: undefined, is_count_exact: false }), 1, false],
    [body([], { count: 10000, page_count: 500, is_count_exact: false }), 1, false]
  ];
  for (const [payload, page, hasMore] of cases) assert.equal((await searchFoodsUpstream('yogurt', { page, fetchImpl: fetchBody(payload) })).hasMore, hasMore);
});

test('throttled and unavailable requests report a recoverable error without retries', async () => {
  for (const [status, message] of [[302, /non è disponibile/], [429, /Attendi un minuto/], [400, /non è disponibile/], [503, /non è disponibile/]]) {
    let calls = 0;
    await assert.rejects(searchFoodsUpstream('yogurt', { fetchImpl: async () => { calls++; return { ok: false, status }; } }), message);
    assert.equal(calls, 1);
  }
  await assert.rejects(searchFoodsUpstream('yogurt', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /Connessione/);
  await assert.rejects(searchFoodsUpstream('yogurt', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }) }), /non è disponibile/);
});

test('malformed, upstream-error and partial-timeout responses are not empty success', async () => {
  for (const payload of [null, {}, { products: [] }, { hits: 'bad' }, body([], { errors: [{ title: 'bad query' }] }), body([product()], { timed_out: true })]) {
    await assert.rejects(searchFoodsUpstream('yogurt', { fetchImpl: fetchBody(payload) }), /non è disponibile/);
  }
});

test('cancelled requests abort the transport and an already-cancelled call makes no request', async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = searchFoodsUpstream('yogurt', { signal: controller.signal, fetchImpl: (_, { signal }) => {
    requestSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  controller.abort(); await assert.rejects(pending, /interrotta/);
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(searchFoodsUpstream('yogurt', { signal: controller.signal, fetchImpl: () => assert.fail('no request after abort') }), /interrotta/);
});

test('request timeout aborts transport and cleans up its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const pending = searchFoodsUpstream('yogurt', { fetchImpl: (_, { signal }) => {
    requestSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  } });
  t.mock.timers.tick(14999); assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1); await assert.rejects(pending, /scaduta/);
  assert.equal(requestSignal.aborted, true);
});

test('aborting while decoding JSON prevents stale results from being cached', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => { controller.abort(); return body(); } }; };
  await assert.rejects(searchFoodsUpstream('yogurt', { signal: controller.signal, fetchImpl }), /interrotta/);
  await searchFoodsUpstream('yogurt', { fetchImpl });
  assert.equal(calls, 2);
});

test('successful cache is isolated per transport, expires and returns independent objects', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const fetchImpl = async () => { calls++; return ok(body()); };
  const first = await searchFoodsUpstream(' yogurt ', { fetchImpl });
  first.items[0].name = 'Changed'; first.items.push({ barcode: secondCode });
  const second = await searchFoodsUpstream('yogurt', { fetchImpl });
  assert.equal(calls, 1); assert.equal(second.items.length, 1); assert.equal(second.items[0].name, 'Yogurt');
  await searchFoodsUpstream('yogurt', { page: 2, fetchImpl }); assert.equal(calls, 2);
  await searchFoodsUpstream('yogurt', { fetchImpl: fetchBody(body([product({ name: 'Other' })])) });
  t.mock.timers.tick(5 * 60 * 1000);
  await searchFoodsUpstream('yogurt', { fetchImpl }); assert.equal(calls, 3);
});

test('cache evicts older entries and never caches failures', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return ok(body()); };
  for (let n = 0; n < 21; n++) await searchFoodsUpstream(`yogurt ${n}`, { fetchImpl });
  await searchFoodsUpstream('yogurt 0', { fetchImpl }); assert.equal(calls, 22);
  let failedCalls = 0;
  const failOnce = async () => ++failedCalls === 1 ? { ok: false, status: 503 } : ok(body());
  await assert.rejects(searchFoodsUpstream('yogurt', { fetchImpl: failOnce }));
  await searchFoodsUpstream('yogurt', { fetchImpl: failOnce }); assert.equal(failedCalls, 2);
});

test('browser adapter calls the fixed Worker proxy with the original query and no credentials', async () => {
  const result = await searchFoods('  yogurt caffè & cacao ', { page: 2, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://pasti.gabri-rosso02.workers.dev');
    assert.equal(parsed.pathname, '/api/foods/search');
    assert.deepEqual([...parsed.searchParams], [['q', 'yogurt caffè & cacao'], ['page', '2']]);
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ items: [{ barcode: code, name: 'Yogurt', brand: 'Marca', kcal: 99 }], page: 2, hasMore: true }));
  } });
  assert.deepEqual(result, { items: [{ barcode: code, name: 'Yogurt', brand: 'Marca' }], page: 2, hasMore: true });
});

test('proxy errors have Italian messages and stable error codes for the server contract', async () => {
  for (const [status, code, message] of [[400, 'INVALID_QUERY', /non valida/], [429, 'RATE_LIMITED', /Attendi un minuto/], [502, 'UPSTREAM_UNAVAILABLE', /non è disponibile/]]) {
    await assert.rejects(searchFoods('yogurt', { fetchImpl: async () => ({ ok: false, status }) }), error => error.code === code && message.test(error.message));
  }
  await assert.rejects(searchFoodsUpstream('x'), error => error.code === 'INVALID_QUERY');
});

test('proxy summaries normalize codes, bound text and reject unexpected response shapes', async () => {
  const result = await searchFoods('yogurt', { fetchImpl: fetchBody({ items: [{ barcode: ` ${code} `, name: 'x'.repeat(300), brand: '' }, { barcode: code, name: 'Duplicate', brand: '' }, { barcode: 'invalid', name: 'Skip', brand: '' }], page: 1, hasMore: true }) });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].name.length, 200); assert.equal(result.items[0].barcode, code);
  for (const payload of [{}, { hits: [] }, { items: [], page: 2, hasMore: false }, { items: [], page: 1, hasMore: 'false' }, { items: [null], page: 1, hasMore: false }, { items: Array.from({ length: 21 }, () => ({ barcode: code, name: '', brand: '' })), page: 1, hasMore: false }]) {
    await assert.rejects(searchFoods('yogurt', { fetchImpl: fetchBody(payload) }), /non è disponibile/);
  }
});

test('streamed JSON responses have a bounded size even without a Content-Length header', async () => {
  for (const response of [new Response('x'.repeat(512 * 1024 + 1)), new Response('{}', { headers: { 'Content-Length': String(512 * 1024 + 1) } })]) {
    await assert.rejects(searchFoodsUpstream('yogurt', { fetchImpl: async () => response }), error => error.code === 'UPSTREAM_UNAVAILABLE');
  }
  const result = await searchFoodsUpstream('yogurt', { fetchImpl: async () => new Response(JSON.stringify(body([product({ product_name_it: 'Caffè' })]))) });
  assert.equal(result.items[0].name, 'Caffè');
});
