import test from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleHealthNutritionAccountKey, prepareGoogleHealthConsumedMeal } from '../src/google-health-nutrition.js';
import { createGoogleHealthReceiptStore, GOOGLE_HEALTH_RECEIPTS_KEY, googleHealthAccountKey, googleHealthMealKey, validateGoogleHealthReceipt } from '../src/google-health-receipts.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}
function locks() {
  const held = new Set(), tails = new Map();
  return { request(name, options, callback) {
    if (options.ifAvailable && held.has(name)) return callback(null);
    const previous = tails.get(name) ?? Promise.resolve();
    const next = previous.then(async () => { held.add(name); try { return await callback({ name }); } finally { held.delete(name); } });
    tails.set(name, next.catch(() => {})); return next;
  } };
}
const receipt = (changes = {}) => ({ version: 1, accountKey: 'a'.repeat(64), mealKey: 'b'.repeat(64), fingerprint: 'c'.repeat(64), status: 'pending', attemptedAt: '2026-10-23T12:00:00.000Z', ...changes });

test('receipt keys bind account, client and local meal without preserving raw identity', async () => {
  const account = await googleHealthAccountKey('client-a', 'health-user');
  assert.match(account, /^[a-f0-9]{64}$/);
  assert.notEqual(account, await googleHealthAccountKey('client-b', 'health-user'));
  assert.notEqual(account, await googleHealthAccountKey('client-a', 'other-user'));
  assert.notEqual(await googleHealthMealKey('2026-10-23', 'breakfast'), await googleHealthMealKey('2026-10-24', 'breakfast'));
});

test('only the receipt whitelist is persisted; tokens, meal data and raw account IDs are rejected', async () => {
  for (const key of ['accessToken', 'healthUserId', 'meal', 'nutrients', 'body']) assert.throws(() => validateGoogleHealthReceipt(receipt({ [key]: 'private' })));
  for (const changes of [{ accountKey: 'raw-user' }, { status: 'uploaded' }, { attemptedAt: '2026-02-30T10:00:00Z' }, { remoteId: 'https://remote/path' }]) assert.throws(() => validateGoogleHealthReceipt(receipt(changes)));
  const storage = new MemoryStorage(), store = createGoogleHealthReceiptStore({ storage, locks: locks() });
  await store.compareAndSet(receipt(), null);
  assert.deepEqual(store.read('a'.repeat(64), 'b'.repeat(64)), receipt());
  assert.equal(storage.values.size, 1); assert.ok(storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY));
});

test('compare and set rejects a stale record and keeps the newer durable receipt', async () => {
  const storage = new MemoryStorage(), store = createGoogleHealthReceiptStore({ storage, locks: locks() });
  await store.compareAndSet(receipt(), null);
  const sent = receipt({ status: 'sent', remoteId: 'remote-id' });
  await store.compareAndSet(sent, receipt());
  await assert.rejects(store.compareAndSet(receipt({ status: 'rejected' }), receipt()), { code: 'RECEIPT_CHANGED' });
  assert.deepEqual(store.read(sent.accountKey, sent.mealKey), sent);
});

test('the document lock prevents lost updates to different meal receipts', async () => {
  const storage = new MemoryStorage(), api = locks();
  const first = createGoogleHealthReceiptStore({ storage, locks: api }), second = createGoogleHealthReceiptStore({ storage, locks: api });
  const other = receipt({ mealKey: 'd'.repeat(64) });
  await Promise.all([first.compareAndSet(receipt(), null), second.compareAndSet(other, null)]);
  assert.deepEqual(first.read(other.accountKey, other.mealKey), other);
  assert.deepEqual(second.read(receipt().accountKey, receipt().mealKey), receipt());
});

test('a meal lock rejects a concurrent operation from another store', async () => {
  const storage = new MemoryStorage(), api = locks();
  const first = createGoogleHealthReceiptStore({ storage, locks: api }), second = createGoogleHealthReceiptStore({ storage, locks: api });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const active = first.withMealLock(receipt().accountKey, receipt().mealKey, () => gate);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(second.withMealLock(receipt().accountKey, receipt().mealKey, () => assert.fail('must not run')), { code: 'BUSY' });
  release(); await active;
});

test('generation checks and unavailable Web Locks prevent every write', async () => {
  const storage = new MemoryStorage(), store = createGoogleHealthReceiptStore({ storage, locks: locks() });
  await assert.rejects(store.compareAndSet(receipt(), null, { isActive: () => false }), { code: 'SESSION_CHANGED' });
  const unavailable = createGoogleHealthReceiptStore({ storage, locks: null });
  assert.equal(unavailable.available, false);
  await assert.rejects(unavailable.compareAndSet(receipt(), null), { code: 'LOCKS_UNAVAILABLE' });
  await assert.rejects(unavailable.withMealLock(receipt().accountKey, receipt().mealKey, () => {}), { code: 'LOCKS_UNAVAILABLE' });
  assert.equal(storage.values.size, 0);
});

test('corrupt or quota-blocked receipt storage remains intact and fails closed', async () => {
  const storage = new MemoryStorage(); storage.setItem(GOOGLE_HEALTH_RECEIPTS_KEY, '{bad');
  const store = createGoogleHealthReceiptStore({ storage, locks: locks() });
  await assert.rejects(store.compareAndSet(receipt(), null), { code: 'RECEIPTS_INVALID' });
  assert.equal(storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), '{bad');
  storage.values.clear(); storage.setItem = () => { throw new Error('quota detail'); };
  await assert.rejects(store.compareAndSet(receipt(), null), { code: 'RECEIPTS_UNAVAILABLE' });
  assert.equal(storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), null);
});

test('local undo can detect past receipts without exposing another account key', async () => {
  const storage = new MemoryStorage(), store = createGoogleHealthReceiptStore({ storage, locks: locks() });
  assert.equal(store.hasAny(), false); await store.compareAndSet(receipt(), null);
  assert.equal(store.hasAny(), true); assert.equal(store.hasForMeal(receipt().mealKey), true);
  assert.equal(store.hasForMeal('d'.repeat(64)), false);
});


test('UI receipt keys exactly match the connector account and meal keys', async () => {
  const clientId = 'test-client.apps.googleusercontent.com', healthUserId = 'test-user';
  const actual = await getGoogleHealthNutritionAccountKey({ clientId, accessToken: 'synthetic-token',
    fetchImpl: async () => ({ status: 200, url: '', redirected: false, text: async () => JSON.stringify({ healthUserId }) }) });
  assert.equal(await googleHealthAccountKey(clientId, healthUserId), actual);
  const prepared = await prepareGoogleHealthConsumedMeal({ dateKey: '2026-10-23', now: new Date('2026-10-23T15:00:00Z'), consumed: { consumedAt: '2026-10-23T10:00:00Z', meal: { id: 'test-meal', title: 'Pasto', slot: 'lunch', time: '12:00', macros: { kcal: 400, protein: 20, carbs: 50, fat: 10 } } } });
  assert.equal(await googleHealthMealKey('2026-10-23', 'test-meal'), prepared.mealKey);
});
