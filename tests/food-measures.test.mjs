import test from 'node:test';
import assert from 'node:assert/strict';
import { getFood } from '../src/foods.js';
import { quantitySpec, toDisplayAmount, toStoredAmount, formatFoodAmount, quantizeFoodAmount, normalizeOilIngredients } from '../src/food-measures.js';

const oil = getFood('olive-oil');

test('oil uses quarter tablespoons and preserves exact conversions without rounding input', () => {
  const spec = quantitySpec('olive-oil', oil);
  assert.deepEqual(spec, { unit: 'cucchiai', min: .25, step: .25, max: 222, factor: 13.5 });
  assert.equal(toDisplayAmount('olive-oil', oil, 13.5), 1);
  assert.equal(toDisplayAmount('olive-oil', oil, 16.875), 1.25);
  assert.equal(toDisplayAmount('olive-oil', oil, .01), .25);
  assert.equal(toDisplayAmount('olive-oil', oil, 0), 0);
  assert.equal(toStoredAmount('olive-oil', oil, 1.25), 16.875);
  assert.equal(toStoredAmount('olive-oil', oil, 1.3), 17.55);
  assert.equal(quantizeFoodAmount('olive-oil', oil, 15), 13.5);
  assert.equal(formatFoodAmount('olive-oil', oil, 13.5), '1 cucchiaio');
  assert.equal(formatFoodAmount('olive-oil', oil, 16.875), '1,25 cucchiai');
  assert.equal(formatFoodAmount('olive-oil', oil, 15), 'circa 1 cucchiaio');
});

test('personal oils use 15 ml tablespoons for labels expressed per 100 ml', () => {
  const food = { name: 'Olio di semi', unit: 'ml', fat: 91 };
  assert.equal(quantitySpec('personal-oil', food).factor, 15);
  assert.equal(quantitySpec('personal-oil', food).max, 200);
  assert.equal(toStoredAmount('personal-oil', food, 1.25), 18.75);
  assert.equal(quantizeFoodAmount('personal-oil', food, 19), 18.75);
  assert.equal(formatFoodAmount('personal-oil', food, 18.75), '1,25 cucchiai');
  assert.equal(quantitySpec('personal-oil', { name: 'Extra virgin olive oil', fat: 100, unit: 'g' }).factor, 13.5);
});

test('ordinary food quantities are not rounded and foods preserved in oil stay in grams', () => {
  for (const name of ['Tonno sott’olio', 'Tuna in olive oil', 'Pomodori sottolio', 'Tuna with oil']) {
    const food = { name, fat: 90, unit: 'g' };
    assert.equal(quantitySpec('personal-food', food).factor, 1, name);
  }
  const food = getFood('rice');
  assert.deepEqual(quantitySpec('rice', food), { unit: 'g', min: .1, step: .1, max: 3000, factor: 1 });
  assert.equal(toDisplayAmount('rice', food, 23.456), 23.456);
  assert.equal(toStoredAmount('rice', food, 23.456), 23.456);
  assert.equal(quantizeFoodAmount('rice', food, 23.456), 23.456);
  assert.equal(formatFoodAmount('rice', food, 23.456), '23,5 g');
});

test('normalization clones ingredients and personal labels while snapping only oils', () => {
  const ingredients = [
    { foodId: 'olive-oil', grams: 15 },
    { foodId: 'rice', grams: 23.456 },
    { foodId: 'personal-oil', grams: 19, foodSnapshot: { name: 'Olio di semi', brand: '', barcode: '', unit: 'ml', kcal: 819, protein: 0, carbs: 0, fat: 91 } },
  ];
  const result = normalizeOilIngredients(ingredients);
  assert.deepEqual(result.map(item => item.grams), [13.5, 23.456, 18.75]);
  assert.deepEqual(ingredients.map(item => item.grams), [15, 23.456, 19]);
  assert.notEqual(result[0], ingredients[0]);
  assert.notEqual(result[2].foodSnapshot, ingredients[2].foodSnapshot);
});

test('quantity helpers reject nonfinite, negative and nonnumeric amounts', () => {
  for (const value of [NaN, Infinity, -1, '2', null]) {
    for (const helper of [toDisplayAmount, toStoredAmount, quantizeFoodAmount, formatFoodAmount]) {
      assert.throws(() => helper('olive-oil', oil, value));
    }
  }
});

test('new oil quantities cap at a valid quarter below 3000 while legacy display remains unclamped', () => {
  assert.equal(quantizeFoodAmount('olive-oil', oil, 3000), 2997);
  assert.equal(quantizeFoodAmount('olive-oil', oil, 2999), 2997);
  assert.equal(toDisplayAmount('olive-oil', oil, 3000), 222.25);
  assert.equal(formatFoodAmount('olive-oil', oil, 3000), 'circa 222,25 cucchiai');
  const mlOil = { name: 'Olio di semi', unit: 'ml', fat: 91 };
  assert.equal(quantizeFoodAmount('personal-oil', mlOil, 3000), 3000);
  assert.equal(quantizeFoodAmount('personal-oil', mlOil, 3001), 3000);
  assert.equal(normalizeOilIngredients([{ foodId: 'olive-oil', grams: 3000 }])[0].grams, 2997);
});
