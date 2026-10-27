import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEAL_DISTRIBUTION, MACRO_KEYS, validateMealDistribution, mealMacroTarget, remainingMealTargets, fitRecipeIngredients } from '../src/recipe-fitting.js';
import { ingredientMacros } from '../src/foods.js';
import { sumMacros } from '../src/nutrition.js';
const clone = value => JSON.parse(JSON.stringify(value));
const base = [{ foodId: 'chicken', grams: 130 }, { foodId: 'rice', grams: 80 }, { foodId: 'olive-oil', grams: 15 }];
const near = (actual, expected, tolerance = .05) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('each daily macro is fully and independently distributed; validation returns a detached copy', () => {
  const allocation = validateMealDistribution(DEFAULT_MEAL_DISTRIBUTION);
  assert.notEqual(allocation, DEFAULT_MEAL_DISTRIBUTION);
  assert.notEqual(allocation.breakfast, DEFAULT_MEAL_DISTRIBUTION.breakfast);
  const daily = { protein: 144, carbs: 226, fat: 80, kcal: 2200 };
  const meals = Object.keys(allocation).map(slot => mealMacroTarget(daily, allocation, slot));
  const total = sumMacros(meals);
  for (const key of [...MACRO_KEYS, 'kcal']) near(total[key], daily[key]);
  assert.deepEqual(meals[0], { protein: 0, carbs: 22.6, fat: 0, kcal: 90.4 });
});

test('distribution rejects missing slots, extra fields, nonnumeric values and totals other than 100', () => {
  for (const mutation of [
    d => { delete d.dinner; }, d => { d.extra = {}; }, d => { d.lunch.protein = 40; },
    d => { d.breakfast.carbs = '25'; }, d => { d.breakfast.fat = NaN; }, d => { d.preworkout.protein = -1; },
    d => { d.dinner.kcal = 3; }, d => { d.preworkout.carbs = 101; },
  ]) { const value = clone(DEFAULT_MEAL_DISTRIBUTION); mutation(value); assert.throws(() => validateMealDistribution(value)); }
  for (const value of [null, [], {}, undefined]) assert.throws(() => validateMealDistribution(value));
  const rounded = clone(DEFAULT_MEAL_DISTRIBUTION); rounded.lunch.protein -= .01;
  assert.doesNotThrow(() => validateMealDistribution(rounded));
  assert.throws(() => mealMacroTarget({ protein: 1, carbs: 1, fat: 1 }, DEFAULT_MEAL_DISTRIBUTION, 'snack'));
});

test('chicken, rice and oil meet feasible targets with all food contributions counted', () => {
  const target = { protein: 50, carbs: 70, fat: 20 };
  const before = clone(base);
  const result = fitRecipeIngredients(base, target);
  assert.equal(result.matched, true);
  for (const key of MACRO_KEYS) near(result.macros[key], target[key]);
  assert.deepEqual(result.macros, sumMacros(result.ingredients.map(item => ingredientMacros(item))));
  assert.deepEqual(base, before);
  assert.deepEqual(result.ingredients.map(item => item.foodId), base.map(item => item.foodId));
  for (const item of result.ingredients) { assert.ok(item.grams > 0 && item.grams <= 3000); near(item.grams * 10, Math.round(item.grams * 10), 1e-7); }
});

test('an impossible single-food recipe reports deficits instead of claiming an exact fit', () => {
  const result = fitRecipeIngredients([{ foodId: 'chicken', grams: 100 }], { protein: 40, carbs: 60, fat: 20 });
  assert.equal(result.matched, false);
  assert.equal(result.deviation.carbs, -60);
  assert.ok(result.deviation.fat < 0);
  assert.equal(result.ingredients.length, 1);
});

test('zero macro allocation yields zero unlocked amounts; locked quantities stay fixed', () => {
  const target = { protein: 0, carbs: 0, fat: 0 };
  const result = fitRecipeIngredients(base, target);
  assert.ok(result.ingredients.every(item => item.grams === 0));
  assert.deepEqual(result.macros, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  assert.equal(result.matched, true);
  const locked = fitRecipeIngredients(base, target, {}, { lockedFoodIds: ['chicken'] });
  assert.equal(locked.ingredients[0].grams, 130);
  assert.equal(locked.matched, false);
});

test('custom food snapshots, ml quantities and overrides are fitted without mutating their label', () => {
  const foodSnapshot = { name: 'Bevanda test', brand: '', barcode: '', unit: 'ml', kcal: 60, protein: 10, carbs: 5, fat: 0 };
  const ingredients = [{ foodId: 'personal-test', grams: 100, foodSnapshot }];
  const result = fitRecipeIngredients(ingredients, { protein: 20, carbs: 10, fat: 0 });
  assert.equal(result.matched, true); near(result.ingredients[0].grams, 200);
  assert.deepEqual(result.ingredients[0].foodSnapshot, foodSnapshot);
  assert.notEqual(result.ingredients[0].foodSnapshot, foodSnapshot);
  const overrides = { chicken: { kcal: 100, protein: 20, carbs: 0, fat: 0 } };
  const changed = fitRecipeIngredients([{ foodId: 'chicken', grams: 100 }], { protein: 30, carbs: 0, fat: 0 }, overrides);
  near(changed.ingredients[0].grams, 150); near(changed.macros.protein, 30);
});

test('practical bounds constrain enormous target portions and inputs are strictly validated', () => {
  const result = fitRecipeIngredients([{ foodId: 'rice', grams: 40 }], { protein: 0, carbs: 900, fat: 0 });
  assert.ok(result.ingredients[0].grams <= 160); assert.equal(result.matched, false);
  for (const target of [null, {}, { protein: -1, carbs: 1, fat: 1 }, { protein: Infinity, carbs: 1, fat: 1 }, { protein: 1, carbs: '1', fat: 1 }, { protein: 1, carbs: 1, fat: 1, kcal: NaN }]) {
    assert.throws(() => fitRecipeIngredients(base, target));
  }
  for (const ingredients of [[], [null], [{ foodId: 'unknown', grams: 100 }], [{ foodId: 'rice', grams: -1 }], [{ foodId: 'rice', grams: 3001 }]]) {
    assert.throws(() => fitRecipeIngredients(ingredients, { protein: 10, carbs: 10, fat: 10 }));
  }
  assert.throws(() => fitRecipeIngredients(base, { protein: 10, carbs: 10, fat: 10 }, {}, { lockedFoodIds: 'rice' }));
});


const dayFixture = () => ({
  targets: { protein: 144, carbs: 226, fat: 80, kcal: 2200 },
  meals: ['preworkout', 'breakfast', 'lunch', 'dinner'].map(slot => ({ id: `today-${slot}`, slot })),
  consumed: {}, skipped: [],
});

test('remaining targets use actual eaten macros and redistribute a skipped snack', () => {
  const day = dayFixture();
  day.skipped = ['today-preworkout'];
  day.consumed['today-breakfast'] = { meal: { macros: { protein: 54, carbs: 46, fat: 20, kcal: 580 } } };
  const before = clone(day);
  const targets = remainingMealTargets(day);
  assert.deepEqual(Object.keys(targets), ['lunch', 'dinner']);
  const total = sumMacros(Object.values(targets));
  near(total.protein, 90); near(total.carbs, 180); near(total.fat, 60);
  near(targets.lunch.protein, 45);
  near(targets.lunch.carbs, 180 * 35 / 65);
  near(targets.dinner.fat, 60 * 35 / 75);
  assert.deepEqual(day, before);
});

test('zero remaining percentage shares residual macro budget equally and overshoots stay zero', () => {
  const day = dayFixture();
  day.skipped = ['today-breakfast', 'today-lunch'];
  day.consumed['today-dinner'] = { meal: { macros: { protein: 150, carbs: 100, fat: 30, kcal: 1270 } } };
  const targets = remainingMealTargets(day);
  assert.deepEqual(targets.preworkout, { protein: 0, carbs: 126, fat: 50, kcal: 954 });
  day.skipped.push('today-preworkout');
  assert.deepEqual(remainingMealTargets(day), {});
});

test('remaining targets reject malformed diary macros and duplicate slots', () => {
  const day = dayFixture();
  day.consumed['today-breakfast'] = { meal: { macros: { kcal: 1, protein: NaN, carbs: 1, fat: 1 } } };
  assert.throws(() => remainingMealTargets(day));
  delete day.consumed['today-breakfast'];
  day.meals.push({ id: 'duplicate', slot: 'breakfast' });
  assert.throws(() => remainingMealTargets(day));
});


const personal = (id, grams, values) => ({ foodId: `personal-${id}`, grams,
  foodSnapshot: { name: id, brand: '', barcode: '', unit: 'g', kcal: 200, protein: 0, carbs: 0, fat: 0, ...values } });

test('small spices and yeast stay at recipe amounts rather than being used to fill macro deficits', () => {
  {
    const mode = 'balanced';
    const ingredients = [
      { foodId: 'rice', grams: 80 },
      personal('cumin', 2, { protein: 18, carbs: 44, fat: 22, kcal: 375 }),
      personal('yeast', 2, { protein: 40, carbs: 35, fat: 5, kcal: 325 }),
      personal('salt', 12, { kcal: 0 }),
    ];
    const result = fitRecipeIngredients(ingredients, { protein: 60, carbs: 100, fat: 30 }, {}, { mode });
    assert.equal(result.ingredients[1].grams, 2);
    assert.equal(result.ingredients[2].grams, 2);
    assert.equal(result.ingredients[3].grams, 12);
    assert.equal(result.matched, false);
    assert.deepEqual(ingredients.slice(1).map(item => item.grams), [2, 2, 12]);
  }
});

test('balanced fitting retains ingredient character with quarter-base minimum and fourfold maximum', () => {
  const ingredients = [{ foodId: 'chicken', grams: 200 }, { foodId: 'rice', grams: 100 }, { foodId: 'olive-oil', grams: 5 }];
  const result = fitRecipeIngredients(ingredients, { protein: 2, carbs: 1, fat: 40 });
  assert.equal(result.ingredients[0].grams, 50);
  assert.equal(result.ingredients[1].grams, 25);
  assert.equal(result.ingredients[2].grams, 20, 'small oil remains adjustable, but never exceeds four times the base');
  assert.equal(result.matched, false);
});

test('proportional mode uses a shared factor and preserves explicit locks', () => {
  const ingredients = [...base, personal('spice', 2, { protein: 2, carbs: 3, fat: 1 })];
  const scaled = ingredients.map((item, i) => ({ ...item, grams: i === 0 ? item.grams : item.grams * 1.5 }));
  const target = sumMacros(scaled.map(item => ingredientMacros(item)));
  const result = fitRecipeIngredients(ingredients, target, {}, { mode: 'proportional', lockedFoodIds: ['chicken'] });
  assert.equal(result.ingredients[0].grams, 130);
  assert.equal(result.ingredients[3].grams, 3);
  near(result.ingredients[1].grams, 120);
  near(result.ingredients[2].grams, 22.5);
  assert.equal(result.matched, true);
  const capped = fitRecipeIngredients(base, { protein: 10000, carbs: 10000, fat: 10000 }, {}, { mode: 'proportional' });
  capped.ingredients.forEach((item, i) => near(item.grams, base[i].grams * 4));
  assert.throws(() => fitRecipeIngredients(base, target, {}, { mode: 'unknown' }));
});

test('zero target does not change zero-macro ingredients and zero-base ingredients cannot grow', () => {
  const ingredients = [{ foodId: 'rice', grams: 100 }, personal('salt', 15, { kcal: 0 }), { foodId: 'olive-oil', grams: 0 }];
  for (const mode of ['balanced', 'proportional']) {
    const zero = fitRecipeIngredients(ingredients, { protein: 0, carbs: 0, fat: 0 }, {}, { mode });
    assert.deepEqual(zero.ingredients.map(item => item.grams), mode === 'balanced' ? [0, 15, 0] : [0, 0, 0]);
    assert.equal(zero.matched, true);
    const nonzero = fitRecipeIngredients(ingredients, { protein: 20, carbs: 50, fat: 20 }, {}, { mode });
    assert.equal(nonzero.ingredients[2].grams, 0);
  }
});


test('proportional mode scales spices, yeast and water by the same recipe factor', () => {
  const ingredients = [
    ...base,
    personal('cumin', 2, { protein: 18, carbs: 44, fat: 22, kcal: 375 }),
    personal('yeast', 2, { protein: 40, carbs: 35, fat: 5, kcal: 325 }),
    personal('water', 500, { kcal: 0 }),
  ];
  const doubled = ingredients.map(item => ({ ...item, grams: item.grams * 2 }));
  const result = fitRecipeIngredients(ingredients, sumMacros(doubled.map(item => ingredientMacros(item))), {}, { mode: 'proportional' });
  assert.equal(result.matched, true);
  result.ingredients.forEach((item, i) => near(item.grams, doubled[i].grams));
  const cappedIngredients = [...base, personal('water', 2000, { kcal: 0 })];
  const capped = fitRecipeIngredients(cappedIngredients, { protein: 10000, carbs: 10000, fat: 10000 }, {}, { mode: 'proportional' });
  capped.ingredients.forEach((item, i) => near(item.grams, cappedIngredients[i].grams * 1.5));
});
