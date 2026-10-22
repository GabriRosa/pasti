import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_LEVELS, calculateTargets, sumMacros } from '../src/nutrition.js';
import { FOODS, getFood, foodMacros } from '../src/foods.js';
import { MEAL_SLOTS, createDayPlan, mealFromIngredients, mealAlternatives, swapMealFood } from '../src/planner.js';

const profile = { age: 35, sex: 'male', weight: 80, height: 180, activity: 'moderate', goal: 'lose', trainingTime: '06:00', trainingDays: [1, 3, 5], specialCondition: false };
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const makeMeal = (ingredients, slot = 'lunch') => mealFromIngredients({ id: 'test-meal', slot, title: 'Pasto di prova', time: '13:00', note: '', ingredients });
const grams = (meal, id) => meal.ingredients.filter(item => item.foodId === id).reduce((n, item) => n + item.grams, 0);
const checkMeal = (meal, overrides = {}) => {
  assert.ok(MEAL_SLOTS.some(slot => slot.id === meal.slot));
  assert.ok(meal.ingredients.length);
  for (const item of meal.ingredients) {
    assert.ok(item.grams > 0 && Number.isFinite(item.grams));
    assert.ok(item.grams <= 650, `${item.foodId}: ${item.grams} g`);
  }
  const exact = sumMacros(meal.ingredients.map(item => foodMacros(item.foodId, item.grams, overrides)));
  for (const key of Object.keys(exact)) close(meal.macros[key], exact[key]);
};

test('Mifflin, activity and modest goal adjustment have independent numeric checks', () => {
  const targets = calculateTargets(profile);
  close(targets.bmr, 1755);
  close(targets.tdee, 2720.25);
  close(targets.kcal, 2448.225);
  close(targets.protein, 144);
  close(targets.fat, 81.6075);
  close(targets.carbs, 284.439375);
  close(targets.protein * 4 + targets.carbs * 4 + targets.fat * 9, targets.kcal);
  close(calculateTargets({ ...profile, sex: 'female' }).bmr, 1589);
  close(calculateTargets({ ...profile, goal: 'maintain' }).kcal, targets.tdee);
  close(calculateTargets({ ...profile, goal: 'gain' }).kcal, targets.tdee * 1.05);
  assert.match(targets.method, /Mifflin/);
  assert.match(targets.method, /doi.org/);
});

test('activity factors include the weekly exercise and are not applied again for training days', () => {
  assert.deepEqual(ACTIVITY_LEVELS.map(level => level.factor), [1.2, 1.375, 1.55, 1.725, 1.9]);
  assert.deepEqual(calculateTargets(profile), calculateTargets({ ...profile, trainingDays: [] }));
});

test('invalid and clinical profiles fail with useful errors', () => {
  for (const change of [{ age: 17 }, { age: 101 }, { weight: NaN }, { weight: Infinity }, { height: 0 }, { weight: '80' }, { sex: 'x' }, { activity: 'athlete' }, { goal: 'fast-loss' }, { trainingDays: [7] }, { trainingDays: ['1'] }, { trainingTime: '6:00' }, { specialCondition: 'false' }]) {
    assert.throws(() => calculateTargets({ ...profile, ...change }), Error);
  }
  assert.throws(() => calculateTargets({ ...profile, specialCondition: true }), /professionista/);
});

test('underweight does not receive a deficit and extreme results are finite and warned', () => {
  const underweight = calculateTargets({ ...profile, weight: 45 });
  close(underweight.kcal, underweight.tdee);
  assert.ok(underweight.warnings.some(warning => warning.includes('deficit')));
  for (const change of [{ weight: 250, height: 130 }, { age: 100, weight: 35, height: 130 }, { activity: 'very-active' }]) {
    const targets = calculateTargets({ ...profile, ...change });
    for (const key of ['bmr', 'tdee', 'kcal', 'protein', 'carbs', 'fat']) assert.ok(Number.isFinite(targets[key]) && targets[key] > 0);
    assert.ok(targets.warnings.length >= 2);
    assert.ok(targets.protein * 4 <= targets.kcal * 0.35 + 1e-8);
    close(targets.protein * 4 + targets.carbs * 4 + targets.fat * 9, targets.kcal);
  }
});

test('catalog has all required unique IDs, complete sources and edible-weight notes', () => {
  const required = ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl', 'chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin', 'olive-oil', 'vegetables', 'banana', 'rice-cakes', 'jam', 'oats', 'greek-yogurt', 'bread', 'protein-pudding-lidl', 'protein-mousse-lidl', 'dark-chocolate'];
  assert.equal(new Set(FOODS.map(food => food.id)).size, FOODS.length);
  for (const id of required) {
    const food = getFood(id);
    assert.ok(food.unitNote && /^https:\/\//.test(food.source));
    for (const key of ['kcal', 'protein', 'carbs', 'fat']) assert.ok(Number.isFinite(food[key]) && food[key] >= 0);
  }
  assert.match(getFood('tuna').unitNote, /sgocciolat/);
  assert.match(getFood('eggs').unitNote, /50 g/);
  for (const id of ['lentil-pasta-lidl', 'protein-pudding-lidl', 'protein-mousse-lidl']) {
    assert.equal(getFood(id).estimated, true);
    assert.match(getFood(id).unitNote, /non verificata/);
  }
});

test('all four macros scale linearly, including protein in dry lentil pasta', () => {
  const lentil = foodMacros('lentil-pasta-lidl', 80);
  assert.deepEqual(lentil, { kcal: 267.2, protein: 20.8, carbs: 40, fat: 1.36 });
  const egg = foodMacros('eggs', 100);
  close(egg.protein, 12.4);
  assert.deepEqual(foodMacros('pasta', 0), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  assert.throws(() => foodMacros('pasta', -1));
  assert.throws(() => foodMacros('pasta', NaN));
  assert.throws(() => getFood('constructor'));
  assert.throws(() => getFood('__proto__'));
});

test('label overrides are applied without changing immutable identity and metadata', () => {
  const values = { kcal: 350, protein: 24, carbs: 52, fat: 3 };
  const overrides = { 'lentil-pasta-lidl': { ...values, name: 'Changed', source: 'invalid' } };
  const actual = getFood('lentil-pasta-lidl', overrides);
  assert.equal(actual.name, getFood('lentil-pasta-lidl').name);
  assert.equal(actual.source, getFood('lentil-pasta-lidl').source);
  assert.deepEqual(foodMacros('lentil-pasta-lidl', 50, overrides), { kcal: 175, protein: 12, carbs: 26, fat: 1.5 });
  assert.equal(getFood('lentil-pasta-lidl').protein, 26);
  for (const values of [{ kcal: 1 }, { kcal: 1, protein: -1, carbs: 0, fat: 0 }, { kcal: 1, protein: 1, carbs: NaN, fat: 0 }]) {
    assert.throws(() => getFood('pasta', { pasta: values }));
  }
  const inherited = Object.create({ pasta: { kcal: 1, protein: 1, carbs: 1, fat: 1 } });
  assert.equal(getFood('pasta', inherited).kcal, getFood('pasta').kcal);
});

test('sum rejects corrupt inputs and does not silently turn missing numbers into zero', () => {
  assert.deepEqual(sumMacros([]), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const items = [foodMacros('pasta', 80), foodMacros('chicken', 100)];
  const total = sumMacros(items);
  close(total.protein, 34.1);
  assert.throws(() => sumMacros([{ kcal: 1 }]));
  assert.throws(() => sumMacros([{ kcal: 1, protein: 0, carbs: -1, fat: 0 }]));
});

test('day plans are deterministic, independent copies and vary with local calendar date', () => {
  const targets = calculateTargets(profile);
  const first = createDayPlan(profile, targets, '2026-10-23');
  const second = createDayPlan(profile, targets, '2026-10-23');
  assert.deepEqual(first, second);
  first[0].ingredients[0].grams = 999;
  assert.notEqual(first[0].ingredients[0].grams, second[0].ingredients[0].grams);
  assert.notDeepEqual(second.map(meal => meal.title), createDayPlan(profile, targets, '2026-10-24').map(meal => meal.title));
  assert.equal(new Set(second.map(meal => meal.id)).size, second.length);
  assert.ok(second.every(meal => meal.id.startsWith('2026-10-23-')));
});

test('06:00 training has a tiny optional preworkout then breakfast at 07:30', () => {
  const targets = calculateTargets(profile);
  const training = createDayPlan(profile, targets, '2026-10-23');
  assert.deepEqual(training.map(meal => meal.slot), ['preworkout', 'breakfast', 'lunch', 'dinner']);
  assert.equal(training[0].time, '05:45');
  assert.equal(training[1].time, '07:30');
  assert.ok(training[0].macros.kcal < 120);
  assert.ok(training[0].macros.fat < 2);
  assert.ok(training[0].ingredients.every(item => !['protein-pudding-lidl', 'protein-mousse-lidl', 'greek-yogurt'].includes(item.foodId)));
  const rest = createDayPlan(profile, targets, '2026-10-22');
  assert.deepEqual(rest.map(meal => meal.slot), ['breakfast', 'lunch', 'dinner']);
  assert.equal(rest[0].time, '08:00');
  assert.equal(createDayPlan({ ...profile, includePreworkout: false }, targets, '2026-10-23').length, 3);
  assert.equal(createDayPlan({ ...profile, trainingDays: [] }, targets, '2026-10-23').length, 3);
});

test('dates are validated without UTC/local weekday shifts, including Sunday and leap day', () => {
  const sunday = { ...profile, trainingDays: [0] };
  assert.equal(createDayPlan(sunday, calculateTargets(sunday), '2026-10-25')[0].slot, 'preworkout');
  assert.doesNotThrow(() => createDayPlan(profile, calculateTargets(profile), '2028-02-29'));
  for (const date of ['1900-01-01', '1969-12-29', '1969-12-31']) {
    for (const meal of createDayPlan(profile, calculateTargets(profile), date)) checkMeal(meal);
  }
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', 'invalid', '1800-01-01']) assert.throws(() => createDayPlan(profile, calculateTargets(profile), date));
  const midnight = createDayPlan({ ...profile, trainingTime: '00:10' }, calculateTargets(profile), '2026-10-23');
  assert.equal(midnight[0].time, '23:55');
  assert.match(midnight[0].note, /sera precedente/);
});

test('at least three practical breakfast and preworkout alternatives include all user preferences', () => {
  const targets = calculateTargets(profile);
  const plan = createDayPlan(profile, targets, '2026-10-23');
  const snacks = mealAlternatives(plan[0], targets);
  const breakfasts = mealAlternatives(plan[1], targets);
  assert.ok(snacks.length >= 3 && breakfasts.length >= 3);
  for (const meal of [...snacks, ...breakfasts]) checkMeal(meal);
  for (const id of ['protein-pudding-lidl', 'protein-mousse-lidl', 'dark-chocolate']) assert.ok(breakfasts.some(meal => meal.ingredients.some(item => item.foodId === id)));
  const pudding = breakfasts.find(meal => grams(meal, 'protein-pudding-lidl'));
  close(grams(pudding, 'protein-pudding-lidl'), 200);
  assert.ok(breakfasts.some(meal => grams(meal, 'greek-yogurt') && grams(meal, 'dark-chocolate')));
});

test('main alternatives cover every requested carb and protein with full macro totals', () => {
  const targets = calculateTargets(profile);
  const main = makeMeal([{ foodId: 'pasta', grams: 100 }, { foodId: 'chicken', grams: 150 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 15 }]);
  const alternatives = mealAlternatives(main, targets);
  assert.equal(alternatives.length, 30);
  for (const id of ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl', 'chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin']) assert.ok(alternatives.some(meal => grams(meal, id) > 0), id);
  for (const meal of alternatives) {
    checkMeal(meal);
    assert.equal(meal.id, main.id);
    close(grams(meal, 'vegetables'), 200);
    assert.ok(grams(meal, 'eggs') <= 100);
    if (grams(meal, 'eggs')) assert.equal(meal.ingredients.find(item => ['eggs', 'egg-whites'].includes(item.foodId)).foodId, 'eggs');
  }
});

test('lentil substitution absorbs its protein by reducing chicken and preserves both major nutrients', () => {
  const main = makeMeal([{ foodId: 'pasta', grams: 80 }, { foodId: 'chicken', grams: 170 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 10 }]);
  const alternative = swapMealFood(main, 'pasta', 'lentil-pasta-lidl');
  close(alternative.macros.carbs, main.macros.carbs);
  close(alternative.macros.protein, main.macros.protein);
  assert.ok(grams(alternative, 'chicken') < 100);
  assert.ok(grams(alternative, 'lentil-pasta-lidl') > 80);
  assert.match(alternative.note, /proteine delle lenticchie/);
  checkMeal(alternative);
  const reverse = swapMealFood(alternative, 'lentil-pasta-lidl', 'pasta');
  close(grams(reverse, 'chicken'), 170);
  close(grams(reverse, 'pasta'), 80);
});

test('protein swap adjusts salmon carbohydrate and reduces added oil', () => {
  const main = makeMeal([{ foodId: 'rice', grams: 100 }, { foodId: 'chicken', grams: 150 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 25 }]);
  const salmon = swapMealFood(main, 'chicken', 'salmon');
  close(salmon.macros.carbs, main.macros.carbs);
  close(salmon.macros.protein, main.macros.protein);
  close(salmon.macros.fat, main.macros.fat);
  assert.ok(grams(salmon, 'rice') < 100);
  assert.ok(grams(salmon, 'olive-oil') < 25);
  checkMeal(salmon);
});

test('two eggs with whites are practical and consecutive swaps remove previous companions', () => {
  const main = makeMeal([{ foodId: 'rice', grams: 100 }, { foodId: 'chicken', grams: 150 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 15 }]);
  const eggs = swapMealFood(main, 'chicken', 'eggs');
  close(grams(eggs, 'eggs'), 100);
  assert.ok(grams(eggs, 'egg-whites') > 0 && grams(eggs, 'egg-whites') < 300);
  close(eggs.macros.protein, main.macros.protein);
  const tuna = swapMealFood(eggs, 'eggs', 'tuna');
  close(grams(tuna, 'egg-whites'), 0);
  close(grams(tuna, 'eggs'), 0);
  close(tuna.macros.protein, main.macros.protein);
});

test('extreme label overrides remain bounded and advertise tradeoffs without zero portions', () => {
  const main = makeMeal([{ foodId: 'rice', grams: 100 }, { foodId: 'chicken', grams: 150 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 15 }]);
  const overrides = { 'lentil-pasta-lidl': { kcal: 400, protein: 60, carbs: 20, fat: 9 } };
  const alternative = swapMealFood(main, 'rice', 'lentil-pasta-lidl', overrides);
  checkMeal(alternative, overrides);
  assert.ok(grams(alternative, 'chicken') >= 50);
  assert.match(alternative.note, /discostarsi/);
  assert.throws(() => swapMealFood(main, 'rice', 'lentil-pasta-lidl', { 'lentil-pasta-lidl': { kcal: 0, protein: 0, carbs: 0, fat: 0 } }), /Controlla le etichette/);
});

test('regenerated meal macros ignore stale totals and source arrays are not mutated', () => {
  const main = makeMeal([{ foodId: 'pasta', grams: 80 }, { foodId: 'chicken', grams: 100 }]);
  const copy = structuredClone(main);
  main.macros.protein = 999;
  close(mealFromIngredients(main).macros.protein, 34.1);
  swapMealFood(main, 'pasta', 'rice');
  assert.deepEqual(main.ingredients, copy.ingredients);
  assert.throws(() => swapMealFood(main, 'tuna', 'salmon'), /non è presente/);
  assert.throws(() => swapMealFood(main, 'pasta', 'chicken'), /stesso gruppo/);
});

test('generated plans and all alternatives have finite complete macros across representative profiles', () => {
  for (const change of [{}, { sex: 'female', weight: 58, height: 162, age: 29 }, { weight: 100, height: 190, goal: 'gain', activity: 'active' }, { age: 75, weight: 60, height: 160, activity: 'light', goal: 'maintain' }, { weight: 35, height: 130, age: 100 }, { weight: 250, height: 130 }]) {
    const subject = { ...profile, ...change };
    const targets = calculateTargets(subject);
    for (let day = 20; day <= 26; day++) {
      for (const meal of createDayPlan(subject, targets, `2026-10-${day}`)) {
        checkMeal(meal);
        for (const alternative of mealAlternatives(meal, targets)) checkMeal(alternative);
      }
    }
  }
});

test('ordinary adult plans stay within 5% of energy targets across goals, dates and activity', () => {
  const demo = { ...profile, age: 30, weight: 75, height: 178, goal: 'maintain' };
  const subjects = [demo, { ...demo, sex: 'female', weight: 58, height: 162 }, { ...demo, weight: 85, height: 185 }, { ...demo, age: 65, weight: 68, height: 175 }];
  for (const subject of subjects) for (const activity of ['light', 'moderate']) for (const goal of ['maintain', 'lose', 'gain']) for (let day = 20; day <= 26; day++) {
    const person = { ...subject, activity, goal };
    const targets = calculateTargets(person);
    const meals = createDayPlan(person, targets, `2026-10-${day}`);
    const actual = sumMacros(meals.map(meal => meal.macros));
    assert.ok(Math.abs(actual.kcal - targets.kcal) / targets.kcal <= 0.05,
      `${subject.sex}/${subject.weight}/${activity}/${goal}/${day}: ${actual.kcal} kcal against ${targets.kcal}`);
    for (const meal of meals) checkMeal(meal);
  }
});

test('lentils and eggs get an explicit counted bread side when energy is short', () => {
  const person = { ...profile, age: 30, weight: 75, height: 178, goal: 'maintain' };
  const meals = createDayPlan(person, calculateTargets(person), '2026-10-23');
  const lunch = meals.find(meal => meal.slot === 'lunch');
  assert.ok(grams(lunch, 'lentil-pasta-lidl') > 0 && grams(lunch, 'eggs') > 0);
  assert.ok(grams(lunch, 'bread') > 0);
  assert.equal(grams(lunch, 'egg-whites'), 0);
  assert.doesNotMatch(lunch.title, /albumi/);
  assert.doesNotMatch(lunch.note, /albumi indicati/);
  assert.match(lunch.note, /pane a parte/);
  checkMeal(lunch);
});
