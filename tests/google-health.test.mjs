import test from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleHealthDay, getGoogleHealthRange, verifyGoogleHealthAccount } from '../src/google-health.js';

const accessToken = 'synthetic-token-only';
const now = new Date('2026-10-22T22:03:43.987Z');
const dateKey = '2026-10-23';
const options = { accessToken, dateKey, now };
const range = getGoogleHealthRange(dateKey, now);
const response = (value, status = 200, changes = {}) => ({ status, url: '', redirected: false,
  text: async () => typeof value === 'string' ? value : JSON.stringify(value), ...changes });
const minute = (index, field, value, changes = {}) => ({
  startTime: new Date(Date.parse(range.rangeStart) + index * 60000).toISOString(),
  endTime: new Date(Date.parse(range.rangeStart) + (index + 1) * 60000).toISOString(),
  ...(value === undefined ? {} : { [field]: value === 'default' ? {} : { kcalSum: value } }), ...changes,
});
const fieldFor = url => url.includes('/total-calories/') ? 'totalCalories' : 'activeEnergyBurned';
const read = fetchImpl => getGoogleHealthDay({ ...options, fetchImpl });
const assertCode = (fn, code, text) => assert.rejects(fn, error => {
  assert.equal(error.code, code);
  if (text) assert.match(error.message, text);
  assert.ok(!String(error).includes(accessToken));
  return true;
});

test('Italian full days have independent midnights through 23-hour and 25-hour DST days', () => {
  const futureNow = new Date('2026-12-31T23:59:00Z');
  for (const [date, start, end, hours] of [
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25],
    ['2026-10-23', '2026-10-22T22:00:00.000Z', '2026-10-23T22:00:00.000Z', 24],
    ['2026-01-01', '2025-12-31T23:00:00.000Z', '2026-01-01T23:00:00.000Z', 24],
    ['2024-02-29', '2024-02-28T23:00:00.000Z', '2024-02-29T23:00:00.000Z', 24],
  ]) {
    const actual = getGoogleHealthRange(date, futureNow);
    assert.equal(actual.rangeStart, start);
    assert.equal(actual.rangeEnd, end);
    assert.equal((Date.parse(end) - Date.parse(start)) / 3600000, hours);
  }
});

test('today ends at the completed minute, using Rome calendar rather than the UTC date', () => {
  assert.deepEqual(range, { dateKey, timeZone: 'Europe/Rome', rangeStart: '2026-10-22T22:00:00.000Z',
    rangeEnd: '2026-10-22T22:03:00.000Z', fetchedAt: now.toISOString() });
  const first = getGoogleHealthRange('2026-10-25', new Date('2026-10-25T00:30:20Z'));
  const repeated = getGoogleHealthRange('2026-10-25', new Date('2026-10-25T01:30:20Z'));
  assert.equal(first.rangeStart, repeated.rangeStart);
  assert.equal(Date.parse(repeated.rangeEnd) - Date.parse(first.rangeEnd), 3600000);
});

test('the first incomplete minute returns no data and does not issue a zero-length API request', async () => {
  let calls = 0;
  const actual = await getGoogleHealthDay({ ...options, now: new Date('2026-10-22T22:00:59.999Z'), fetchImpl: () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(actual.totalKcal, null);
  assert.equal(actual.activeKcal, null);
  assert.deepEqual(actual.coverage, { totalSeconds: 0, activeSeconds: 0, requestedSeconds: 0 });
});

test('invalid calendar dates, future dates and invalid clocks are rejected before fetching', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; };
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '23/10/2026', '2026-10-24', '', null]) {
    await assertCode(() => getGoogleHealthDay({ ...options, dateKey: date, fetchImpl }), 'INVALID_RESPONSE');
  }
  for (const clock of [new Date('invalid'), '2026-10-23', null]) {
    await assertCode(() => getGoogleHealthDay({ ...options, now: clock, fetchImpl }), 'INVALID_RESPONSE');
  }
  assert.equal(calls, 0);
});

test('requests use fixed v4 endpoints, one source family and the same minute range without tokens in URLs or bodies', async () => {
  const calls = [];
  const actual = await read(async (url, init) => {
    calls.push({ url, init });
    const field = fieldFor(url);
    const values = field === 'totalCalories' ? [0.1, 0.2, 0.3] : [0, 0.05, 0.01];
    return response({ rollupDataPoints: values.map((value, index) => minute(index, field, value)).reverse() });
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://health.googleapis.com/v4/users/me/dataTypes/total-calories/dataPoints:rollUp');
  assert.equal(calls[1].url, 'https://health.googleapis.com/v4/users/me/dataTypes/active-energy-burned/dataPoints:rollUp');
  for (const { url, init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!url.includes(accessToken) && !init.body.includes(accessToken));
    assert.deepEqual(JSON.parse(init.body), { range: { startTime: range.rangeStart, endTime: range.rangeEnd },
      windowSize: '60s', pageSize: 2000, dataSourceFamily: 'users/me/dataSourceFamilies/all-sources' });
  }
  assert.equal(actual.totalKcal, 0.6);
  assert.equal(actual.activeKcal, 0.060000000000000005);
  assert.equal(actual.fetchedAt, now.toISOString());
  assert.deepEqual(actual.coverage, { totalSeconds: 180, activeSeconds: 180, requestedSeconds: 180 });
  assert.deepEqual(Object.keys(actual).sort(), ['source', 'dateKey', 'timeZone', 'rangeStart', 'rangeEnd', 'fetchedAt', 'totalKcal', 'activeKcal', 'coverage'].sort());
});

test('absent metrics are null, present empty proto messages and explicit zeros are zero with coverage', async () => {
  const empty = await read(async () => response({}));
  assert.equal(empty.totalKcal, null);
  assert.equal(empty.activeKcal, null);
  assert.equal(empty.coverage.totalSeconds, 0);
  const actual = await read(async url => {
    const field = fieldFor(url);
    return response({ rollupDataPoints: [minute(0, field, undefined), minute(1, field, field === 'totalCalories' ? 'default' : 0)] });
  });
  assert.equal(actual.totalKcal, 0);
  assert.equal(actual.activeKcal, 0);
  assert.deepEqual(actual.coverage, { totalSeconds: 60, activeSeconds: 60, requestedSeconds: 180 });
});

test('partial coverage is reported independently for each metric without filling gaps or estimating calories', async () => {
  const actual = await read(async url => {
    const field = fieldFor(url);
    return response({ rollupDataPoints: field === 'totalCalories' ? [minute(0, field, 12.345), minute(2, field, 9.876)] : [] });
  });
  assert.equal(actual.totalKcal, 22.221);
  assert.equal(actual.activeKcal, null);
  assert.deepEqual(actual.coverage, { totalSeconds: 120, activeSeconds: 0, requestedSeconds: 180 });
});

test('pagination keeps the initial request and deduplicates identical windows across pages', async () => {
  const calls = [];
  const actual = await read(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const field = fieldFor(url);
    return response(body.pageToken === undefined
      ? { rollupDataPoints: [minute(0, field, 1)], nextPageToken: 'opaque/+cursor=' }
      : { rollupDataPoints: [minute(0, field, 1), minute(2, field, 2)], nextPageToken: '' });
  });
  assert.equal(actual.totalKcal, 3);
  assert.equal(actual.activeKcal, 3);
  assert.equal(actual.coverage.totalSeconds, 120);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].body, { ...calls[0].body, pageToken: 'opaque/+cursor=' });
});

test('conflicting duplicates, overlaps, out-of-range and shifted windows fail instead of double-counting', async () => {
  const badLists = [
    [minute(0, 'totalCalories', 1), minute(0, 'totalCalories', 2)],
    [minute(0, 'totalCalories', undefined), minute(0, 'totalCalories', 0)],
    [minute(0, 'totalCalories', 1, { endTime: '2026-10-22T22:02:00Z' })],
    [minute(-1, 'totalCalories', 1)], [minute(3, 'totalCalories', 1)],
    [minute(0, 'totalCalories', 1, { startTime: '2026-10-22T22:00:00.000000001Z' })],
    [minute(2, 'totalCalories', 1, { endTime: '2026-10-22T22:03:00.000000001Z' })],
    [minute(0, 'totalCalories', 1, { startTime: '2026-10-22T22:00:30Z', endTime: '2026-10-22T22:01:30Z' })],
    [minute(0, 'totalCalories', 1, { startTime: '2026-02-30T22:00:00Z' })],
    [minute(0, 'totalCalories', 1, { startTime: '2026-10-22T22:00:00' })],
  ];
  for (const points of badLists) await assertCode(() => read(async () => response({ rollupDataPoints: points })), 'INVALID_RESPONSE');
});

test('equivalent RFC3339 offsets and nanosecond timestamps retain the same minute boundaries', async () => {
  const actual = await read(async url => response({ rollupDataPoints: [minute(0, fieldFor(url), 7, {
    startTime: '2026-10-23T00:00:00+02:00', endTime: '2026-10-22T22:01:00.000000000Z',
  })] }));
  assert.equal(actual.totalKcal, 7);
  assert.equal(actual.coverage.totalSeconds, 60);
});

test('malformed payloads, non-finite or negative calories and unknown metric types are rejected', async () => {
  const malformed = [null, [], '', '{', { rollupDataPoints: null }, { rollupDataPoints: {} }, { unexpected: 1 },
    { rollupDataPoints: [null] }, { rollupDataPoints: [{}] },
    ...[-1, null, '12', 'NaN', 'Infinity', true].map(value => ({ rollupDataPoints: [minute(0, 'totalCalories', value)] })),
    { rollupDataPoints: [minute(0, 'activeEnergyBurned', 1)] },
    { rollupDataPoints: [minute(0, 'totalCalories', 1, { totalCalories: null })] },
    { rollupDataPoints: [minute(0, 'totalCalories', 1, { totalCalories: { kcalSum: 1, unexpected: 2 } })] },
    JSON.stringify({ rollupDataPoints: [minute(0, 'totalCalories', 1)] }).replace('"kcalSum":1', '"kcalSum":1e400'),
    { rollupDataPoints: [minute(0, 'totalCalories', 1e308), minute(1, 'totalCalories', 1e308)] },
  ];
  for (const value of malformed) await assertCode(() => read(async () => response(value)), 'INVALID_RESPONSE');
});

test('malformed, looping and excessive pagination cannot produce a partial success', async () => {
  for (const token of [null, 1, {}, 'x'.repeat(16385)]) {
    await assertCode(() => read(async () => response({ nextPageToken: token })), 'INVALID_RESPONSE');
  }
  await assertCode(() => read(async () => response({ nextPageToken: 'same' })), 'INVALID_RESPONSE');
  let calls = 0;
  await assertCode(() => read(async () => response({ nextPageToken: `page-${++calls}` })), 'INVALID_RESPONSE');
  assert.equal(calls, 16);
});

test('missing or malformed bearer credentials never reach fetch or appear in errors', async () => {
  let calls = 0;
  for (const token of [undefined, null, '', ' ', 'Bearer token', 'secret\r\nInjected: value', 'x'.repeat(16385)]) {
    await assertCode(() => getGoogleHealthDay({ ...options, accessToken: token, fetchImpl: () => { calls++; } }), 'AUTH_REQUIRED');
  }
  assert.equal(calls, 0);
});

test('service failures use stable codes and do not expose response contents or network exceptions', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED'],
    [500, 'UNAVAILABLE'], [503, 'UNAVAILABLE'], [408, 'UNAVAILABLE'], [400, 'INVALID_RESPONSE'], [404, 'INVALID_RESPONSE']]) {
    await assertCode(() => read(async () => response({ error: { message: accessToken } }, status)), code);
  }
  await assertCode(() => read(async () => response({ error: { message: accessToken, details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCOUNT_NOT_LINKED' },
  ] } }, 400)), 'ACCOUNT_NOT_LINKED');
  await assertCode(() => read(async () => { throw new Error(accessToken); }), 'UNAVAILABLE');
  await assertCode(() => read(async () => response('not JSON ' + accessToken, 401)), 'AUTH_REQUIRED');
  await assertCode(() => read(async () => response({}, 200, { text: async () => { throw new Error(accessToken); } })), 'UNAVAILABLE');
  await assertCode(() => getGoogleHealthDay({ ...options, fetchImpl: null }), 'UNAVAILABLE');
});

test('redirects, unexpected origins and oversized bodies are refused', async () => {
  for (const changes of [{ redirected: true }, { url: 'https://example.invalid/data' }, { url: 'https://health.googleapis.com/v4/other' }]) {
    await assertCode(() => read(async () => response({}, 200, changes)), 'INVALID_RESPONSE');
  }
  await assertCode(() => read(async () => response(' '.repeat(2 * 1024 * 1024 + 1))), 'INVALID_RESPONSE');
});

test('failure of the second metric rejects the pair rather than returning a misleading first total', async () => {
  let calls = 0;
  await assertCode(() => read(async url => {
    calls++;
    return url.includes('/total-calories/') ? response({ rollupDataPoints: [minute(0, 'totalCalories', 8)] }) : response({}, 403);
  }), 'ACCESS_DENIED');
  assert.equal(calls, 2);
});

test('identity verification returns only the validated Health ID for private session comparison', async () => {
  const calls = [];
  const result = await verifyGoogleHealthAccount({ accessToken, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return response({ name: 'users/me/identity', healthUserId: 'synthetic-health-user', legacyUserId: 'legacy-test' });
  } });
  assert.deepEqual(result, { healthUserId: 'synthetic-health-user' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://health.googleapis.com/v4/users/me/identity');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${accessToken}`);
});

test('invalid identities and unlinked accounts are handled without leaking identity data', async () => {
  for (const healthUserId of [undefined, null, '', ' ', 'x'.repeat(64), 'user@example.invalid', 42]) {
    await assertCode(() => verifyGoogleHealthAccount({ accessToken, fetchImpl: async () => response({ healthUserId }) }), 'INVALID_RESPONSE');
  }
  await assertCode(() => verifyGoogleHealthAccount({ accessToken, fetchImpl: async () => response({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCOUNT_NOT_LINKED' },
  ] } }, 400) }), 'ACCOUNT_NOT_LINKED');
});

test('full DST fall coverage is 90000 seconds and the compensated sum remains finite and precise', async () => {
  const autumnNow = new Date('2026-10-26T12:00:00Z');
  const actual = await getGoogleHealthDay({ accessToken, dateKey: '2026-10-25', now: autumnNow, fetchImpl: async (url, init) => {
    const query = JSON.parse(init.body);
    const start = Date.parse(query.range.startTime);
    const count = (Date.parse(query.range.endTime) - start) / 60000;
    assert.equal(count, 1500);
    return response({ rollupDataPoints: Array.from({ length: count }, (_, index) => ({
      startTime: new Date(start + index * 60000).toISOString(), endTime: new Date(start + (index + 1) * 60000).toISOString(),
      [fieldFor(url)]: { kcalSum: 0.1 },
    })) });
  } });
  assert.equal(actual.totalKcal, 150);
  assert.equal(actual.activeKcal, 150);
  assert.deepEqual(actual.coverage, { totalSeconds: 90000, activeSeconds: 90000, requestedSeconds: 90000 });
});
