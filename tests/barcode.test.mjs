import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBarcode, productFromResponse, lookupProduct, validatePersonalFood, createBarcodeScanner } from '../src/barcode.js';
import { ingredientMacros } from '../src/foods.js';
import { mealFromIngredients, mealAlternatives } from '../src/planner.js';
import { createEmptyData, parseBackup, exportBackup } from '../src/storage.js';
const code = '4056489759096';
const food = { name: 'Mousse', brand: 'Milbona', barcode: code, unit: 'g', kcal: 76, protein: 10, carbs: 5.8, fat: 1.4 };
const nutrient = (value, unit = 'g') => ({ value, unit });
const response = () => ({ product: { product_name: 'Mousse', brands: 'Milbona', nutrition: { aggregated_set: { per: '100g', preparation: 'as_sold', nutrients: { 'energy-kcal': nutrient(76, 'kcal'), proteins: nutrient(10), carbohydrates: nutrient(5.8), fat: nutrient(1.4) } } } } });
test('barcodes retain leading zeroes and validate lengths and checksum', () => {
  assert.equal(normalizeBarcode('4056 4897-59096'), code);
  assert.equal(normalizeBarcode('036000291452'), '036000291452');
  assert.equal(normalizeBarcode('96385074'), '96385074');
  for (const invalid of ['4056489759095', '1234', 'https://x.test', '', '123456789012345']) assert.throws(() => normalizeBarcode(invalid));
});
test('v3.6 product maps only normalized sold-product data; absent is not zero', () => {
  assert.deepEqual(productFromResponse(response(), code), food);
  const payload = response();
  delete payload.product.nutrition.aggregated_set.nutrients.proteins;
  payload.product.nutrition.aggregated_set.nutrients.fat.value = 0;
  const result = productFromResponse(payload, code);
  assert.equal(result.protein, null); assert.equal(result.fat, 0);
  assert.throws(() => validatePersonalFood(result));
  for (const per of ['serving', undefined]) {
    payload.product.nutrition.aggregated_set.per = per;
    assert.equal(productFromResponse(payload, code).kcal, null);
  }
  payload.product.nutrition.aggregated_set.per = '100g';
  payload.product.nutrition.aggregated_set.preparation = 'prepared';
  assert.equal(productFromResponse(payload, code).kcal, null);
});
test('millilitres and kJ conversion are explicit; invalid units and bounds rejected', () => {
  const payload = response(), set = payload.product.nutrition.aggregated_set;
  set.per = '100ml'; delete set.nutrients['energy-kcal']; set.nutrients['energy-kj'] = nutrient(418.4, 'kJ');
  assert.equal(productFromResponse(payload, code).unit, 'ml');
  assert.ok(Math.abs(productFromResponse(payload, code).kcal - 100) < 1e-8);
  set.nutrients.proteins.unit = 'mg'; set.nutrients.fat.value = -1; set.nutrients.carbohydrates.value = Infinity;
  const parsed = productFromResponse(payload, code); assert.equal(parsed.protein, null); assert.equal(parsed.fat, null); assert.equal(parsed.carbs, null);
});
test('lookup makes an anonymous bounded field request and handles missing or throttled products', async () => {
  const result = await lookupProduct(code, { fetchImpl: async (url, options) => {
    assert.match(url, /api\/v3.6\/product\/4056489759096/); assert.match(url, /app_name=Pasti/);
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); return { ok: true, json: async () => response() };
  } });
  assert.deepEqual(result, food);
  for (const status of [404, 429, 500]) await assert.rejects(lookupProduct(code, { fetchImpl: async () => ({ ok: false, status }) }));
  assert.throws(() => productFromResponse({}, code));
  await assert.rejects(lookupProduct('123', { fetchImpl: () => assert.fail('invalid code must not reach network') }));
});
test('cancel propagates to the network request', async () => {
  const c = new AbortController();
  const pending = lookupProduct(code, { signal: c.signal, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  c.abort(); await assert.rejects(pending, /interrotta/);
});
test('personal portions survive backup and meal snapshots are independent', () => {
  const data = createEmptyData(); data.personalPortions = [{ id: 'personal-test', food: structuredClone(food), grams: 175 }];
  assert.deepEqual(parseBackup(exportBackup(data)), data);
  const ingredient = { foodId: 'personal-test', foodSnapshot: food, grams: 175 };
  const m = mealFromIngredients({ id: 'lunch', slot: 'lunch', time: '13:00', title: 'Pranzo', note: '', ingredients: [{ foodId: 'pasta', grams: 90 }, ingredient] });
  const kcal = m.macros.kcal;
  assert.equal(ingredientMacros(ingredient).protein, 17.5);
  food.kcal = 99; assert.equal(m.ingredients[1].foodSnapshot.kcal, 76); assert.equal(m.macros.kcal, kcal); food.kcal = 76;
  const variants = mealAlternatives(m, { kcal: 2200, protein: 144, fat: 80, carbs: 226 });
  assert.ok(variants.every(v => v.ingredients.some(i => i.foodSnapshot?.name === 'Mousse')));
  for (const change of [d => d.personalPortions.push(d.personalPortions[0]), d => d.personalPortions[0].grams = 0, d => d.personalPortions[0].food.fat = null]) {
    const invalid = structuredClone(data); change(invalid); assert.throws(() => exportBackup(invalid));
  }
});
test('scanner stops late camera permission responses without decoding', async () => {
  let resolve, stopped = 0, decoded = 0;
  const video = { srcObject: null };
  const scanner = createBarcodeScanner({ video, onCode: () => assert.fail(), onError: () => assert.fail(), mediaDevices: { getUserMedia: () => new Promise(r => { resolve = r; }) }, decoder: async () => ({ BrowserMultiFormatOneDReader: class { decodeFromVideoElement() { decoded++; } } }) });
  const pending = scanner.start(); await Promise.resolve(); scanner.stop(); resolve({ getTracks: () => [{ stop: () => stopped++ }] }); await pending;
  assert.equal(stopped, 1); assert.equal(decoded, 0); assert.equal(video.srcObject, null);
});
test('scanner delivers one valid result, closes tracks and ignores duplicate callbacks', async () => {
  let callback, stopped = 0, controlsStopped = 0; const codes = [];
  const scanner = createBarcodeScanner({ video: { srcObject: null }, onCode: c => codes.push(c), onError: assert.fail,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) },
    decoder: async () => ({ BrowserMultiFormatOneDReader: class { async decodeFromVideoElement(_, cb) { callback = cb; return { stop: () => controlsStopped++ }; } } }) });
  await scanner.start(); callback({ getText: () => '123' }); assert.equal(stopped, 0);
  callback({ getText: () => code }); callback({ getText: () => code });
  assert.deepEqual(codes, [code]); assert.equal(stopped, 1); assert.equal(controlsStopped, 1);
});
test('permission denial gives a recoverable message', async () => {
  const errors = [];
  const scanner = createBarcodeScanner({ video: {}, onCode: assert.fail, onError: e => errors.push(e), decoder: async () => ({}), mediaDevices: { getUserMedia: async () => { throw { name: 'NotAllowedError' }; } } });
  await scanner.start(); assert.match(errors[0], /negato/);
});
