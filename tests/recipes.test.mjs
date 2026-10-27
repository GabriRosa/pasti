import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_RECIPES, BASE_RECIPE_FOODS } from '../src/base-recipes.js';
import { getIngredientFood, ingredientMacros } from '../src/foods.js';
import { validatePersonalFood } from '../src/barcode.js';
import { DEFAULT_MEAL_DISTRIBUTION } from '../src/recipe-fitting.js';
import { createEmptyData, validateRecipe, validateData, exportBackup, parseBackup, saveData, loadData } from '../src/storage.js';

const clone = value => structuredClone(value);
const recipe = () => ({ id: 'recipe-test', name: 'Pollo e riso', slot: 'lunch',
  ingredients: [{ foodId: 'chicken', grams: 150 }, { foodId: 'rice', grams: 80 }], source: '' });
const dateKey = '2026-10-27';
function legacyDiary() {
  const data = createEmptyData();
  data.profile = { age: 24, sex: 'male', weight: 90, height: 182, activity: 'moderate',
    goal: 'lose', trainingTime: '06:00', trainingDays: [1, 3, 5], specialCondition: false };
  const meal = { id: 'lunch', title: 'Pranzo', slot: 'lunch', time: '13:00', note: '',
    ingredients: [{ foodId: 'chicken', grams: 150 }], macros: ingredientMacros({ foodId: 'chicken', grams: 150 }) };
  data.days[dateKey] = { dateKey, createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z',
    profileSnapshot: clone(data.profile),
    targets: { kcal: 2200, protein: 144, carbs: 226, fat: 80, bmr: 1922.5, tdee: 2900, warnings: [], method: 'Stima' },
    meals: [meal], consumed: { lunch: { consumedAt: '2026-10-27T11:00:00Z', meal: clone(meal) } }, skipped: [] };
  return data;
}

test('all 195 Cibo Sano recipes satisfy storage and ingredient nutrition contracts', () => {
  assert.equal(BASE_RECIPES.length, 195);
  assert.equal(new Set(BASE_RECIPES.map(item => item.id)).size, BASE_RECIPES.length);
  for (const item of BASE_RECIPES) {
    assert.equal(validateRecipe(item), item, item.id);
    for (const ingredient of item.ingredients) {
      const food = getIngredientFood(ingredient);
      const values = ingredientMacros(ingredient);
      for (const key of ['kcal', 'protein', 'carbs', 'fat']) {
        assert.ok(Number.isFinite(food[key]) && food[key] >= 0, `${item.id}: ${ingredient.foodId}/${key}`);
        assert.equal(values[key], food[key] * ingredient.grams / 100);
      }
    }
  }
  for (const item of BASE_RECIPE_FOODS) assert.equal(validatePersonalFood(item.food), item.food);
  const data = { ...createEmptyData(), personalRecipes: clone(BASE_RECIPES) };
  assert.deepEqual(parseBackup(exportBackup(data)), data);
});

test('custom recipes and distinct global/day allocations survive a backup without changing eaten meals', () => {
  const data = legacyDiary();
  const eaten = clone(data.days[dateKey].consumed);
  const imported = clone(BASE_RECIPES.find(item => item.ingredients.some(i => i.foodSnapshot)));
  imported.id = 'recipe-personal-copy'; imported.name = 'La mia versione'; imported.ingredients[0].grams += 10;
  data.personalRecipes = [recipe(), imported];
  data.mealDistribution = clone(DEFAULT_MEAL_DISTRIBUTION);
  data.days[dateKey].mealDistribution = clone(DEFAULT_MEAL_DISTRIBUTION);
  data.days[dateKey].mealDistribution.breakfast.protein += 5;
  data.days[dateKey].mealDistribution.dinner.protein -= 5;
  const restored = parseBackup(exportBackup(data));
  assert.deepEqual(restored, data);
  assert.deepEqual(restored.days[dateKey].consumed, eaten);
  assert.notDeepEqual(restored.days[dateKey].mealDistribution, restored.mealDistribution);
  assert.notEqual(restored.personalRecipes[1].ingredients[0], data.personalRecipes[1].ingredients[0]);
});

test('old schema 1 diaries round-trip unchanged without adding optional recipe fields', () => {
  for (const data of [createEmptyData(), legacyDiary()]) {
    const before = clone(data);
    const restored = parseBackup(exportBackup(data));
    assert.deepEqual(restored, before);
    assert.deepEqual(data, before);
    assert.equal(restored.schemaVersion, 1);
    assert.equal(Object.hasOwn(restored, 'personalRecipes'), false);
    assert.equal(Object.hasOwn(restored, 'mealDistribution'), false);
    for (const day of Object.values(restored.days)) assert.equal(Object.hasOwn(day, 'mealDistribution'), false);
  }
});

test('malformed recipe records and invalid ingredients cannot enter a backup', () => {
  const changes = [
    r => { r.id = 'invalid'; }, r => { r.id = 'recipe-'; }, r => { r.name = ' '; },
    r => { r.name = 'x'.repeat(201); }, r => { r.slot = 'snack'; }, r => { r.source = 123; },
    r => { r.source = 'x'.repeat(501); }, r => { r.unexpected = true; },
    r => { r.ingredients = []; }, r => { r.ingredients = Array.from({ length: 31 }, () => ({ foodId: 'rice', grams: 80 })); },
    r => { r.ingredients[0].grams = 0; }, r => { r.ingredients[0].grams = 3001; },
    r => { r.ingredients[0].grams = '100'; }, r => { r.ingredients[0].grams = NaN; },
    r => { r.ingredients[0].foodId = 'unknown-food'; },
    r => { r.ingredients[0].foodId = 'personal-without-snapshot'; },
    r => { r.ingredients[0].unexpected = true; },
    r => { r.ingredients[0] = { foodId: 'personal-bad', grams: 100,
      foodSnapshot: { name: 'Bad food', brand: '', barcode: '', unit: 'g', kcal: 200, protein: -1, carbs: 10, fat: 5 } }; },
  ];
  for (const change of changes) {
    const item = recipe(); change(item);
    assert.throws(() => validateRecipe(item));
    assert.throws(() => parseBackup(JSON.stringify({ ...createEmptyData(), personalRecipes: [item] })));
  }
  for (const value of [null, [], {}, 4]) assert.throws(() => validateRecipe(value));
});

test('duplicate recipes and invalid recipe collections are rejected, distinct copied recipes are accepted', () => {
  const original = recipe();
  for (const personalRecipes of [null, {}, 'recipes', [original, clone(original)],
    Array.from({ length: 301 }, (_, i) => ({ ...recipe(), id: `recipe-${i}` }))]) {
    assert.throws(() => validateData({ ...createEmptyData(), personalRecipes }));
  }
  assert.doesNotThrow(() => validateData({ ...createEmptyData(), personalRecipes: [original, { ...recipe(), id: 'recipe-copy' }] }));
});

test('invalid macro distributions are rejected both globally and in historical days', () => {
  const values = [null, [], {}, 'distribution'];
  for (const change of [
    d => { delete d.dinner; }, d => { d.breakfast.protein += 1; },
    d => { d.lunch.carbs = -1; }, d => { d.dinner.fat = 101; },
    d => { d.preworkout.carbs = '10'; }, d => { d.breakfast.protein = Infinity; },
    d => { d.breakfast.kcal = 25; }, d => { d.extra = {}; },
  ]) { const value = clone(DEFAULT_MEAL_DISTRIBUTION); change(value); values.push(value); }
  for (const value of values) {
    assert.throws(() => validateData({ ...createEmptyData(), mealDistribution: value }));
    const data = legacyDiary(); data.days[dateKey].mealDistribution = value;
    assert.throws(() => validateData(data));
    assert.throws(() => parseBackup(JSON.stringify(data)));
  }
});

test('invalid recipe updates do not overwrite a previously saved diary', () => {
  let saved = null; let writes = 0;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; writes += 1; } };
  const data = { ...legacyDiary(), personalRecipes: [recipe()], mealDistribution: clone(DEFAULT_MEAL_DISTRIBUTION) };
  saveData(data, storage);
  const invalid = clone(data); invalid.personalRecipes.push(recipe());
  assert.throws(() => saveData(invalid, storage));
  assert.equal(writes, 1);
  assert.deepEqual(loadData(storage).data, data);
});
