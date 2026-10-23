import test from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleHealthNutritionAccountKey, prepareGoogleHealthConsumedMeal, syncGoogleHealthConsumedMeal } from '../src/google-health-nutrition.js';

const accessToken = 'synthetic-nutrition-token';
const clientId = '1234567890-test.apps.googleusercontent.com';
const dateKey = '2026-10-23';
const now = new Date('2026-10-23T14:00:00Z');
const consumed = { consumedAt: '2026-10-23T11:20:43.123Z', meal: {
  id: '2026-10-23-lunch', slot: 'lunch', title: 'Pasta e pollo', time: '13:00',
  macros: { kcal: 501.123, protein: 40.123, carbs: 70.01, fat: 10.005 },
  ingredients: [{ foodId: 'pasta', grams: 100 }], note: 'Private note',
} };
const base = { accessToken, clientId, dateKey, consumed, now };
const copy = value => structuredClone(value);
const response = (value, status = 200, extra = {}) => ({ status, url: '', redirected: false,
  text: async () => typeof value === 'string' ? value : JSON.stringify(value), ...extra });
const expectCode = (fn, code) => assert.rejects(fn, error => {
  assert.equal(error.code, code);
  assert.ok(!String(error).includes(accessToken));
  return true;
});

function cloud() {
  const state = { account: 'synthetic-account', points: [], calls: [], posts: 0, beforePost: null };
  state.point = (body, id = `remote-${state.points.length + 1}`) => ({
    name: `users/${state.account}/dataTypes/nutrition-log/dataPoints/${id}`,
    dataSource: { application: { googleWebClientId: clientId }, platform: 'GOOGLE_WEB_API' }, ...copy(body),
  });
  state.fetch = async (url, init) => {
    const parsed = new URL(url);
    state.calls.push({ url, init });
    if (parsed.pathname === '/v4/users/me/identity') return response({ healthUserId: state.account });
    const root = '/v4/users/me/dataTypes/nutrition-log/dataPoints';
    assert.ok(parsed.pathname.startsWith(root));
    if (init.method === 'POST') {
      state.posts++;
      const body = JSON.parse(init.body);
      if (state.beforePost) return state.beforePost(body);
      const point = state.point(body); state.points.push(point);
      return response({ done: true, response: { '@type': 'type.googleapis.com/google.devicesandservices.health.v4.DataPoint', ...point } });
    }
    if (parsed.pathname === root) return response({ dataPoints: state.points });
    const point = state.points.find(item => item.name.endsWith('/' + parsed.pathname.split('/').at(-1)));
    return point ? response(point) : response({}, 404);
  };
  return state;
}
function ledger(initial = null) {
  const state = { value: initial, saves: [] };
  state.save = async (next, previous) => {
    assert.deepEqual(previous, state.value);
    state.value = copy(next); state.saves.push(copy(next));
  };
  return state;
}

test('preparation exports only the saved consumed snapshot, with exact kcal, macros and local offset', async () => {
  const original = copy(consumed);
  const result = await prepareGoogleHealthConsumedMeal(base);
  assert.deepEqual(result.body, { nutritionLog: {
    interval: { startTime: '2026-10-23T11:20:42.123Z', endTime: consumed.consumedAt, startUtcOffset: '7200s', endUtcOffset: '7200s' },
    foodDisplayName: 'Pasta e pollo', mealType: 'LUNCH', energy: { kcal: 501.123 },
    totalCarbohydrate: { grams: 70.01 }, totalFat: { grams: 10.005 },
    nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: 40.123 } }], serving: { amount: 1 },
  } });
  assert.match(result.mealKey, /^[a-f0-9]{64}$/);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(consumed, original);
  assert.ok(!JSON.stringify(result.body).includes('Private note'));
  assert.ok(!JSON.stringify(result.body).includes('ingredients'));
  const changed = await prepareGoogleHealthConsumedMeal({ ...base, consumed: { ...consumed, meal: { ...consumed.meal, macros: { ...consumed.meal.macros, protein: 41 } } } });
  assert.equal(changed.mealKey, result.mealKey);
  assert.notEqual(changed.fingerprint, result.fingerprint);
});

test('retroactive meals use the journal day and saved meal time with winter and summer offsets', async () => {
  for (const [day, stamp, offset] of [['2026-01-10', '2026-01-10T12:00:00.000Z', '3600s'], ['2026-07-10', '2026-07-10T11:00:00.000Z', '7200s']]) {
    const result = await prepareGoogleHealthConsumedMeal({ ...base, dateKey: day });
    assert.equal(result.body.nutritionLog.interval.startTime, new Date(Date.parse(stamp) - 1000).toISOString());
    assert.equal(result.body.nutritionLog.interval.endTime, stamp);
    assert.equal(result.body.nutritionLog.interval.startUtcOffset, offset);
  }
});

test('ambiguous and nonexistent local meal times require an explicit instant', async () => {
  for (const day of ['2026-03-29', '2026-10-25']) {
    const value = { ...base, dateKey: day, now: new Date('2026-10-26T12:00:00Z'), consumed: { ...consumed, meal: { ...consumed.meal, time: '02:30' } } };
    await expectCode(() => prepareGoogleHealthConsumedMeal(value), 'TIME_REQUIRED');
  }
  for (const [stamp, offset] of [['2026-10-25T00:30:00Z', '7200s'], ['2026-10-25T01:30:00Z', '3600s']]) {
    const result = await prepareGoogleHealthConsumedMeal({ ...base, dateKey: '2026-10-25', now: new Date('2026-10-26T12:00:00Z'), occurredAt: stamp });
    assert.equal(result.body.nutritionLog.interval.startUtcOffset, offset);
  }
});

test('all meal slots map explicitly and zero-valued macros remain valid', async () => {
  for (const [slot, mealType] of [['preworkout', 'SNACK'], ['breakfast', 'BREAKFAST'], ['lunch', 'LUNCH'], ['dinner', 'DINNER']]) {
    const result = await prepareGoogleHealthConsumedMeal({ ...base, consumed: { ...consumed, meal: { ...consumed.meal, slot, macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } } } });
    assert.equal(result.body.nutritionLog.mealType, mealType);
    assert.equal(result.body.nutritionLog.energy.kcal, 0);
  }
});

test('the conventional one-second interval stays in the diary date at midnight', async () => {
  const result = await prepareGoogleHealthConsumedMeal({ ...base, occurredAt: '2026-10-22T22:00:00Z' });
  assert.equal(result.body.nutritionLog.interval.startTime, '2026-10-22T22:00:00.000Z');
  assert.equal(result.body.nutritionLog.interval.endTime, '2026-10-22T22:00:01.000Z');
});

test('account keys are stable per verified account and OAuth client without exposing the Health ID', async () => {
  const api = cloud();
  const key = await getGoogleHealthNutritionAccountKey({ accessToken, clientId, fetchImpl: api.fetch });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, await getGoogleHealthNutritionAccountKey({ accessToken, clientId, fetchImpl: api.fetch }));
  api.account = 'another-account';
  assert.notEqual(key, await getGoogleHealthNutritionAccountKey({ accessToken, clientId, fetchImpl: api.fetch }));
  assert.ok(!key.includes('synthetic'));
});

test('planned-only meals, malformed snapshots, future dates and non-finite values fail before network use', async () => {
  const invalid = [
    { consumed: consumed.meal }, { consumed: null }, { dateKey: '2026-02-30' }, { dateKey: '2026-10-24' },
    { now: new Date('invalid') }, { occurredAt: '2026-10-22T11:00:00Z' }, { occurredAt: '2026-10-23T15:00:00Z' },
    { consumed: { ...consumed, consumedAt: '2026-10-24T11:00:00Z' } },
    ...['toString', '__proto__', 'other'].map(slot => ({ consumed: { ...consumed, meal: { ...consumed.meal, slot } } })),
    ...[-1, NaN, Infinity, '20', undefined, 100001].map(kcal => ({ consumed: { ...consumed, meal: { ...consumed.meal, macros: { ...consumed.meal.macros, kcal } } } })),
  ];
  for (const patch of invalid) {
    await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, ...patch, fetchImpl: () => { assert.fail('unexpected network'); } }), 'INVALID_INPUT');
  }
  await expectCode(() => prepareGoogleHealthConsumedMeal(null), 'INVALID_INPUT');
});

test('read-only mode never creates a record and uses only own-client sources', async () => {
  const api = cloud();
  const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch });
  assert.equal(result.status, 'not_found'); assert.equal(result.receipt, null);
  assert.equal(api.posts, 0);
  const list = new URL(api.calls[1].url);
  assert.equal(list.searchParams.get('dataSourceFamily'), 'users/me/dataSourceFamilies/self-sources');
  assert.equal(list.searchParams.get('pageSize'), '1000');
  assert.equal(list.searchParams.has('filter'), false);
});

test('an explicit create saves pending before POST, then sent, without altering the consumed entry', async () => {
  const api = cloud(), store = ledger(), before = copy(consumed);
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') assert.equal(store.value.status, 'pending');
    assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.ok(!url.includes(accessToken));
    return api.fetch(url, init);
  };
  const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl, allowCreate: true, recordReceipt: store.save });
  assert.equal(result.status, 'uploaded'); assert.equal(result.receipt.status, 'sent');
  assert.equal(api.posts, 1); assert.deepEqual(store.saves.map(x => x.status), ['pending', 'sent']);
  assert.deepEqual(consumed, before);
  assert.ok(!JSON.stringify(result).includes(accessToken));
  assert.ok(!JSON.stringify(result).includes(api.account));
  assert.ok(!JSON.stringify(api.calls.find(x => x.init.method === 'POST').init.body).includes('dataPoints/'));
});

test('an identical existing meal is recovered without a POST, including a retry with the saved remote ID', async () => {
  const api = cloud(), store = ledger();
  const first = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  const again = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: first.receipt, allowCreate: true, recordReceipt: store.save });
  assert.equal(again.status, 'existing'); assert.equal(api.posts, 1);
  assert.ok(api.calls.at(-1).url.endsWith('/remote-1'));
  const lostLedger = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true });
  assert.equal(lostLedger.status, 'existing'); assert.equal(api.posts, 1);
});

test('a lost create response is recovered by read-own, never by repeating its POST', async () => {
  const api = cloud(), store = ledger();
  api.beforePost = body => { api.points.push(api.point(body)); throw new Error('network lost ' + accessToken); };
  const uncertain = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  assert.equal(uncertain.status, 'pending'); assert.equal(uncertain.error.code, 'UNAVAILABLE');
  const recovered = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: store.value, allowCreate: true, recordReceipt: store.save });
  assert.equal(recovered.status, 'existing'); assert.equal(api.posts, 1);
});

test('an already sent remote meal that was removed is not silently recreated', async () => {
  const api = cloud(), store = ledger();
  await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  api.points = [];
  const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: store.value, allowCreate: true, recordReceipt: store.save });
  assert.equal(result.status, 'pending'); assert.equal(api.posts, 1);
});

test('unfinished and malformed operations remain pending even when an explicit create is requested again', async () => {
  for (const operation of [{ name: 'operations/pending', done: false }, {}, { done: true }, { done: true, response: { name: 'https://evil.invalid/token' } }]) {
    const api = cloud(), store = ledger(); api.beforePost = () => response(operation);
    const pending = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
    assert.equal(pending.status, 'pending');
    const repeat = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: store.value, allowCreate: true, recordReceipt: store.save });
    assert.equal(repeat.status, 'pending'); assert.equal(api.posts, 1);
    assert.ok(api.calls.every(call => !call.url.includes('operations/')));
  }
});

test('changed consumed snapshots are reported without updating, deleting or recreating remote data', async () => {
  const api = cloud(), store = ledger();
  await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  const result = await syncGoogleHealthConsumedMeal({ ...base, consumed: { ...consumed, meal: { ...consumed.meal, macros: { ...consumed.meal.macros, kcal: 600 } } },
    fetchImpl: api.fetch, receipt: store.value, allowCreate: true, recordReceipt: store.save });
  assert.equal(result.status, 'changed'); assert.equal(api.posts, 1);
  assert.equal(api.points[0].nutritionLog.energy.kcal, 501.123);
  assert.ok(api.calls.every(call => ['GET', 'POST'].includes(call.init.method) && !call.url.includes('batchDelete')));
});

test('account changes are rejected before reading or writing meals from the new account', async () => {
  const api = cloud(), store = ledger();
  await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  api.account = 'another-account'; api.calls.length = 0;
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: store.value, allowCreate: true, recordReceipt: store.save }), 'ACCOUNT_CHANGED');
  assert.equal(api.calls.length, 1); assert.equal(api.posts, 1);
});

test('multiple matching records and related changed records stop creation', async () => {
  const prepared = await prepareGoogleHealthConsumedMeal(base);
  for (const duplicate of [true, false]) {
    const api = cloud();
    api.points.push(api.point(prepared.body, 'first'));
    const other = api.point(prepared.body, 'second');
    if (!duplicate) { other.nutritionLog.energy.kcal = 700; api.points = []; }
    api.points.push(other);
    const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true });
    assert.equal(result.status, duplicate ? 'conflict' : 'changed'); assert.equal(api.posts, 0);
  }
});

test('pagination is followed completely and matching duplicates by remote ID count once', async () => {
  const api = cloud(), prepared = await prepareGoogleHealthConsumedMeal(base), point = api.point(prepared.body, 'same');
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/identity')) return api.fetch(url, init);
    const parsed = new URL(url);
    if (!parsed.searchParams.has('pageToken')) return response({ dataPoints: [point], nextPageToken: 'next/+page=' });
    assert.equal(parsed.searchParams.get('pageToken'), 'next/+page=');
    return response({ dataPoints: [point] });
  };
  const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl, allowCreate: true });
  assert.equal(result.status, 'existing'); assert.equal(result.receipt.remoteId, 'same');
});

test('an early matching page does not hide a later page failure or a second remote match', async () => {
  const prepared = await prepareGoogleHealthConsumedMeal(base);
  for (const failure of [true, false]) {
    const api = cloud(), first = api.point(prepared.body, 'first'), second = api.point(prepared.body, 'second');
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/identity')) return api.fetch(url, init);
      if (!new URL(url).searchParams.has('pageToken')) return response({ dataPoints: [first], nextPageToken: 'next' });
      return failure ? response({}, 503) : response({ dataPoints: [second] });
    };
    if (failure) await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl, allowCreate: true }), 'UNAVAILABLE');
    else assert.equal((await syncGoogleHealthConsumedMeal({ ...base, fetchImpl, allowCreate: true })).status, 'conflict');
    assert.equal(api.posts, 0);
  }
});

test('looping, truncated and malformed read-own pages refuse creation', async () => {
  for (const page of [{ nextPageToken: 'same' }, { dataPoints: null }, { dataPoints: [{}] }, { nextPageToken: 12 }]) {
    const api = cloud();
    await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, allowCreate: true, fetchImpl: async (url, init) =>
      url.endsWith('/identity') ? api.fetch(url, init) : response(page) }), 'INVALID_RESPONSE');
    assert.equal(api.posts, 0);
  }
  const api = cloud(); let pageCount = 0;
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, allowCreate: true, fetchImpl: async (url, init) =>
    url.endsWith('/identity') ? api.fetch(url, init) : response({ nextPageToken: `p${++pageCount}` }) }), 'INVALID_RESPONSE');
  assert.equal(pageCount, 16);
});

test('a response from another client or account cannot authorize a duplicate or a write', async () => {
  for (const change of ['account', 'client']) {
    const api = cloud(), prepared = await prepareGoogleHealthConsumedMeal(base), point = api.point(prepared.body);
    if (change === 'account') point.name = point.name.replace('synthetic-account', 'wrong-account');
    else point.dataSource.application.googleWebClientId = 'other.apps.googleusercontent.com';
    api.points.push(point);
    await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true }), 'INVALID_RESPONSE');
    assert.equal(api.posts, 0);
  }
});

test('failure to save the initial receipt prevents the POST; failure after success preserves a recoverable pending receipt', async () => {
  const api = cloud();
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true }), 'LOCAL_STATE_ERROR');
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: async () => { throw new Error(accessToken); } }), 'LOCAL_STATE_ERROR');
  assert.equal(api.posts, 0);
  let durable;
  const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: async value => {
    if (value.status === 'sent') throw new Error(accessToken); durable = copy(value);
  } });
  assert.equal(result.status, 'uploaded'); assert.equal(result.error.code, 'LOCAL_STATE_ERROR'); assert.equal(durable.status, 'pending');
  const recovered = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: durable });
  assert.equal(recovered.status, 'existing'); assert.equal(api.posts, 1);
});

test('definitive HTTP rejection permits a later explicit retry, while transient failures remain pending', async () => {
  for (const [status, expected, code] of [[401, 'rejected', 'AUTH_REQUIRED'], [403, 'rejected', 'ACCESS_DENIED'],
    [429, 'rejected', 'RATE_LIMITED'], [500, 'pending', 'UNAVAILABLE'], [408, 'pending', 'UNAVAILABLE']]) {
    const api = cloud(), store = ledger(); api.beforePost = () => response({ error: { message: accessToken } }, status);
    const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
    assert.equal(result.status, expected); assert.equal(result.error.code, code); assert.ok(!JSON.stringify(result).includes(accessToken));
    api.beforePost = null;
    const retry = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, receipt: store.value, allowCreate: true, recordReceipt: store.save });
    assert.equal(retry.status, expected === 'rejected' ? 'uploaded' : 'pending');
    assert.equal(api.posts, expected === 'rejected' ? 2 : 1);
  }
});

test('operation errors use RPC codes and never expose raw messages', async () => {
  const api = cloud(), store = ledger();
  api.beforePost = () => response({ done: true, error: { code: 7, message: accessToken } });
  const result = await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'ACCESS_DENIED');
  assert.ok(!JSON.stringify(result).includes(accessToken));
});

test('concurrent attempts for the same account and meal are refused while the first request is active', async () => {
  const api = cloud(), store = ledger(); let release, started;
  const arrived = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, init) => {
    if (url.includes('dataSourceFamily')) { started(); await gate; }
    return api.fetch(url, init);
  };
  const first = syncGoogleHealthConsumedMeal({ ...base, fetchImpl, allowCreate: true, recordReceipt: store.save });
  await arrived;
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl, allowCreate: true, recordReceipt: store.save }), 'BUSY');
  release(); await first; assert.equal(api.posts, 1);
});

test('invalid credentials, malicious receipt IDs, redirects and malformed bodies fail safely', async () => {
  const api = cloud();
  for (const patch of [{ accessToken: 'secret\r\nInjected: header' }, { accessToken: '' }])
    await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, ...patch, fetchImpl: api.fetch }), 'AUTH_REQUIRED');
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, clientId: 'wrong', fetchImpl: api.fetch }), 'INVALID_INPUT');
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl: async () => response({}, 200, { redirected: true, url: 'https://example.invalid/' }) }), 'INVALID_RESPONSE');
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, fetchImpl: async () => response(' '.repeat(2 * 1024 * 1024 + 1)) }), 'INVALID_RESPONSE');
  const store = ledger(); await syncGoogleHealthConsumedMeal({ ...base, fetchImpl: api.fetch, allowCreate: true, recordReceipt: store.save });
  await expectCode(() => syncGoogleHealthConsumedMeal({ ...base, receipt: { ...store.value, remoteId: '../../other' }, fetchImpl: api.fetch }), 'INVALID_INPUT');
});
