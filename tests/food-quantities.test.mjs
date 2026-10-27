import test from 'node:test';
import assert from 'node:assert/strict';
import { foodQuantityKey, usualFoodQuantity } from '../src/food-quantities.js';
import { createEmptyData, exportBackup, parseBackup } from '../src/storage.js';

test('usual amounts survive backup and follow a barcode without mixing grams and ml', () => {
  const data = createEmptyData();
  data.usualQuantities = { chicken: { grams: 175, unit: 'g' }, 'barcode-036000291452': { grams: 250, unit: 'ml' } };
  const restored = parseBackup(exportBackup(data));
  assert.deepEqual(restored, data);
  assert.equal(usualFoodQuantity('chicken', { unit: 'g' }, restored.usualQuantities), 175);
  assert.equal(usualFoodQuantity('personal-new-id', { barcode: '036000291452', unit: 'ml' }, restored.usualQuantities), 250);
  assert.equal(usualFoodQuantity('personal-new-id', { barcode: '036000291452', unit: 'g' }, restored.usualQuantities), 100);
  assert.equal(foodQuantityKey('catalog', { label: { barcode: '036000291452' } }), 'barcode-036000291452');
  assert.equal(usualFoodQuantity('personal-id', { unit: 'g' }, {}, 125), 125);
  assert.deepEqual(parseBackup(exportBackup(createEmptyData())), createEmptyData());
});

test('invalid usual amounts cannot enter the diary through a backup', () => {
  for (const value of [null, [], { x: { grams: -1, unit: 'g' } }, { x: { grams: 0, unit: 'g' } }, { x: { grams: 3001, unit: 'g' } }, { x: { grams: 50, unit: 'kg' } }, { x: { grams: '50', unit: 'g' } }, { x: { grams: 50, unit: 'g', extra: true } }, { 'bad key': { grams: 50, unit: 'g' } }]) {
    assert.throws(() => exportBackup({ ...createEmptyData(), usualQuantities: value }));
  }
});
