import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_LEVELS, calculateTargets, sumMacros } from '../src/nutrition.js?v=20261023-activity';
import { FOODS, LIDL_FOOD_IDS, getFood, foodMacros } from '../src/foods.js?v=20261023-activity';
import { MEAL_SLOTS, createDayPlan, mealFromIngredients, mealAlternatives, swapMealFood } from '../src/planner.js?v=20261023-activity';
import { trainingForDate, validateTrainingPlan, TRAINING_LOG_TYPES, validateTrainingLog, trainingLogLabel } from '../src/training.js?v=20261023-activity';

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
  const required = ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl', 'lentil-pasta-lidl-fresh', 'chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin', 'olive-oil', 'vegetables', 'banana', 'rice-cakes', 'jam', 'oats', 'greek-yogurt', 'bread', 'protein-pudding-lidl', 'protein-pudding-lidl-vanilla', 'protein-mousse-lidl', 'protein-mousse-lidl-vanilla', 'dark-chocolate'];
  assert.equal(new Set(FOODS.map(food => food.id)).size, FOODS.length);
  for (const id of required) {
    const food = getFood(id);
    assert.ok(food.unitNote && /^https:\/\//.test(food.source));
    for (const key of ['kcal', 'protein', 'carbs', 'fat']) assert.ok(Number.isFinite(food[key]) && food[key] >= 0);
  }
  assert.match(getFood('tuna').unitNote, /sgocciolat/);
  assert.match(getFood('eggs').unitNote, /50 g/);
  assert.deepEqual(LIDL_FOOD_IDS, FOODS.filter(item => item.label).map(item => item.id));
  assert.equal(LIDL_FOOD_IDS.length, 6);
  for (const id of LIDL_FOOD_IDS) {
    assert.equal(getFood(id).estimated, false);
    assert.equal(getFood(id).label.verifiedOn, '2026-10-23');
    assert.equal(getFood(id).label.market, 'Italia');
    assert.ok(getFood(id).label.packGrams > 0);
    assert.match(getFood(id).label.evidenceUrl, /^https:\/\//);
  }
  assert.equal(getFood('protein-pudding-lidl').label.barcode, undefined);
  assert.match(getFood('lentil-pasta-lidl-fresh').unitNote, /Peso fresco/);
});

test('all four macros scale linearly, including protein in dry lentil pasta', () => {
  const lentil = foodMacros('lentil-pasta-lidl', 80);
  assert.deepEqual(lentil, { kcal: 268, protein: 20.8, carbs: 40, fat: 1.36 });
  assert.deepEqual(foodMacros('lentil-pasta-lidl-fresh', 200), { kcal: 518, protein: 38, carbs: 78, fat: 2 });
  close(foodMacros('protein-pudding-lidl', 200).kcal, 166);
  close(foodMacros('protein-mousse-lidl', 175).kcal, 150.5);
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
  assert.equal(training[0].time, '06:00');
  assert.equal(training[1].time, '07:30');
  assert.equal(training.at(-1).time, '19:30');
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
  assert.equal(midnight[0].time, '00:10');
  assert.doesNotMatch(midnight[0].note, /sera precedente/);
});

test('at least three practical breakfast and preworkout alternatives include all user preferences', () => {
  const targets = calculateTargets(profile);
  const plan = createDayPlan(profile, targets, '2026-10-23');
  const snacks = mealAlternatives(plan[0], targets);
  const breakfasts = mealAlternatives(plan[1], targets);
  assert.ok(snacks.length >= 3 && breakfasts.length >= 3);
  for (const meal of [...snacks, ...breakfasts]) checkMeal(meal);
  for (const id of ['protein-pudding-lidl', 'protein-pudding-lidl-vanilla', 'protein-mousse-lidl', 'protein-mousse-lidl-vanilla']) {
    const breakfast = breakfasts.find(meal => grams(meal, id));
    assert.ok(breakfast);
    close(grams(breakfast, id), getFood(id).label.packGrams);
  }
  assert.equal(new Set(breakfasts.map(meal => meal.title)).size, breakfasts.length);
  assert.ok(breakfasts.some(meal => grams(meal, 'greek-yogurt') && grams(meal, 'dark-chocolate')));
});

test('main alternatives cover every requested carb and protein with full macro totals', () => {
  const targets = calculateTargets(profile);
  const main = makeMeal([{ foodId: 'pasta', grams: 100 }, { foodId: 'chicken', grams: 150 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 15 }]);
  const alternatives = mealAlternatives(main, targets);
  assert.equal(alternatives.length, 48);
  for (const id of ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl', 'lentil-pasta-lidl-fresh', 'chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin']) assert.ok(alternatives.some(meal => grams(meal, id) > 0), id);
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

test('extreme label overrides remain bounded and preserve protein without zero portions', () => {
  const main = makeMeal([{ foodId: 'rice', grams: 100 }, { foodId: 'chicken', grams: 150 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 15 }]);
  const overrides = { 'lentil-pasta-lidl': { kcal: 400, protein: 60, carbs: 20, fat: 9 } };
  const alternative = swapMealFood(main, 'rice', 'lentil-pasta-lidl', overrides);
  checkMeal(alternative, overrides);
  assert.ok(grams(alternative, 'chicken') >= 50);
  close(alternative.macros.protein, main.macros.protein);
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
  const main = makeMeal([{ foodId: 'rice', grams: 120 }, { foodId: 'chicken', grams: 110 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 25 }]);
  const lunch = mealAlternatives(main).find(meal => grams(meal, 'lentil-pasta-lidl') && grams(meal, 'eggs'));
  assert.ok(grams(lunch, 'lentil-pasta-lidl') > 0 && grams(lunch, 'eggs') > 0);
  assert.ok(grams(lunch, 'bread') > 0);
  assert.equal(grams(lunch, 'egg-whites'), 0);
  assert.doesNotMatch(lunch.title, /albumi/);
  assert.doesNotMatch(lunch.note, /albumi indicati/);
  assert.match(lunch.note, /pane a parte/);
  checkMeal(lunch);
});

test('dry and fresh lentil swaps preserve all protein at the chicken minimum, including bread', () => {
  const per100 = { pasta: 13.5, chicken: 23.3, vegetables: 1.5, 'olive-oil': 0, bread: 8.5, 'lentil-pasta-lidl': 26, 'lentil-pasta-lidl-fresh': 19 };
  for (const [pasta, chicken] of [[80, 170], [100, 100], [120, 130]]) {
    const main = makeMeal([{ foodId: 'pasta', grams: pasta }, { foodId: 'chicken', grams: chicken }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 10 }]);
    const targetProtein = pasta * 0.135 + chicken * 0.233 + 3;
    for (const id of ['lentil-pasta-lidl', 'lentil-pasta-lidl-fresh']) {
      const swapped = swapMealFood(main, 'pasta', id);
      const independentProtein = swapped.ingredients.reduce((total, item) => total + item.grams * per100[item.foodId] / 100, 0);
      close(independentProtein, targetProtein);
      close(swapped.macros.protein, targetProtein);
      assert.ok(grams(swapped, 'chicken') < chicken);
      assert.ok(grams(swapped, 'chicken') >= 50 - 1e-8);
      if (pasta >= 100) assert.ok(grams(swapped, 'bread') > 0);
      if (id.endsWith('-fresh')) assert.ok(grams(swapped, id) >= 50 && grams(swapped, id) <= 300);
      checkMeal(swapped);
    }
  }
});

test('consecutive swaps rebalance bread without duplicate ingredients or protein drift', () => {
  let meal = makeMeal([{ foodId: 'pasta', grams: 100 }, { foodId: 'chicken', grams: 100 }, { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 10 }]);
  const targetProtein = 13.5 + 23.3 + 3;
  for (const [oldId, newId] of [['pasta', 'lentil-pasta-lidl'], ['lentil-pasta-lidl', 'rice'], ['rice', 'lentil-pasta-lidl-fresh'], ['lentil-pasta-lidl-fresh', 'pasta']]) {
    meal = swapMealFood(meal, oldId, newId);
    assert.equal(new Set(meal.ingredients.map(item => item.foodId)).size, meal.ingredients.length);
    assert.ok(grams(meal, 'bread') <= 150);
    close(meal.macros.protein, targetProtein);
    checkMeal(meal);
  }
});

test('impossible protein targets produce a specific warning rather than false equivalence', () => {
  const tiny = makeMeal([{ foodId: 'rice', grams: 10 }, { foodId: 'chicken', grams: 1 }, { foodId: 'vegetables', grams: 200 }]);
  const swapped = swapMealFood(tiny, 'rice', 'lentil-pasta-lidl-fresh');
  assert.ok(swapped.macros.protein > tiny.macros.protein);
  assert.match(swapped.note, /Proteine: .*rispetto a .*impedisce l’equivalenza esatta/);
});

test('verified label values retain each recipe and the 100 g basis independently of pack size', () => {
  const expected = {
    'lentil-pasta-lidl': [335, 26, 50, 1.7, 250],
    'lentil-pasta-lidl-fresh': [259, 19, 39, 1, 200],
    'protein-pudding-lidl': [83, 10.1, 6.5, 1.5, 200],
    'protein-pudding-lidl-vanilla': [75, 10, 5.2, 1.5, 200],
    'protein-mousse-lidl': [86, 10, 5.8, 2.2, 175],
    'protein-mousse-lidl-vanilla': [76, 10, 5.8, 1.4, 175],
  };
  for (const [id, values] of Object.entries(expected)) {
    const item = getFood(id);
    assert.deepEqual([item.kcal, item.protein, item.carbs, item.fat, item.label.packGrams], values);
    assert.ok(Object.isFrozen(item.label));
    const portion = foodMacros(id, item.label.packGrams);
    close(portion.protein, values[1] * values[4] / 100);
    close(portion.kcal, values[0] * values[4] / 100);
  }
});

test('explicit deficits 0, 250 and 500 are subtracted exactly from the same TDEE', () => {
  for (const deficitKcal of [0, 250, 500, 250.5]) {
    const result = calculateTargets({ ...profile, deficitKcal });
    close(result.bmr, 1755);
    close(result.tdee, 2720.25);
    close(result.kcal, 2720.25 - deficitKcal);
    close(result.tdee - result.kcal, deficitKcal);
    close(result.protein, deficitKcal === 0 ? 128 : 144);
    close(result.protein * 4 + result.carbs * 4 + result.fat * 9, result.kcal);
    assert.match(result.method, new RegExp(`TDEE − ${deficitKcal} kcal`));
  }
  for (const goal of ['maintain', 'gain']) {
    assert.deepEqual(calculateTargets({ ...profile, goal, deficitKcal: 500 }), calculateTargets({ ...profile, goal }));
  }
  close(calculateTargets(profile).kcal, 2720.25 * 0.9);
  close(calculateTargets({ ...profile, deficitKcal: undefined }).kcal, 2720.25 * 0.9);
});

test('invalid deficits and deficits at least as large as TDEE are rejected without clamping', () => {
  for (const deficitKcal of [-1, NaN, Infinity, -Infinity, '250', null, false, [], 2720.25, 3000]) {
    assert.throws(() => calculateTargets({ ...profile, deficitKcal }), /deficit/i);
  }
  const low = calculateTargets({ ...profile, deficitKcal: 2000 });
  close(low.kcal, 720.25);
  assert.ok(low.warnings.some(warning => warning.includes('stima calorica')));
  close(calculateTargets({ ...profile, deficitKcal: 2719.75 }).kcal, 0.5);
});

test('explicit deficits preserve the special-condition and underweight boundaries', () => {
  assert.throws(() => calculateTargets({ ...profile, specialCondition: true, deficitKcal: 0 }), /professionista/);
  assert.throws(() => calculateTargets({ ...profile, weight: 45, deficitKcal: 250 }), /sottopeso/);
  const underweight = calculateTargets({ ...profile, weight: 45, deficitKcal: 0 });
  close(underweight.kcal, underweight.tdee);
  assert.ok(underweight.warnings.some(warning => warning.includes('sottopeso')));
  const legacy = calculateTargets({ ...profile, weight: 45 });
  close(legacy.kcal, legacy.tdee);
  assert.ok(legacy.warnings.some(warning => warning.includes('disattivato')));
  const highBMI = calculateTargets({ ...profile, weight: 120, deficitKcal: 500 });
  close(highBMI.tdee - highBMI.kcal, 500);
  assert.ok(highBMI.warnings.some(warning => warning.includes('rapporto peso/altezza elevato')));
});

test('alternating sessions use calendar days across Sunday, Monday and month changes', () => {
  const alternating = { ...profile, trainingDays: [], trainingPlan: { mode: 'alternating', startDate: '2026-10-23', firstType: 'run' } };
  const expected = [
    ['2026-10-21', 'run'], ['2026-10-22', 'strength'], ['2026-10-23', 'run'],
    ['2026-10-24', 'strength'], ['2026-10-25', 'run'], ['2026-10-26', 'strength'],
    ['2026-10-31', 'run'], ['2026-11-01', 'strength'],
  ];
  for (const [date, type] of expected) {
    assert.equal(trainingForDate(alternating, date).type, type, date);
    assert.equal(trainingForDate(alternating, date).time, '06:00');
  }
  assert.deepEqual(trainingForDate(alternating, '2026-10-23'), { type: 'run', label: 'Corsa', time: '06:00' });
  assert.deepEqual(trainingForDate(alternating, '2026-10-24'), { type: 'strength', label: 'Sala attrezzi', time: '06:00' });
  const before = structuredClone(alternating);
  validateTrainingPlan(alternating.trainingPlan);
  calculateTargets(alternating);
  assert.deepEqual(alternating, before);
});

test('alternation crosses leap day, year boundaries, DST and the Unix epoch', () => {
  for (const [startDate, firstType, checks] of [
    ['2028-02-28', 'strength', [['2028-02-29', 'run'], ['2028-03-01', 'strength']]],
    ['2026-12-31', 'strength', [['2027-01-01', 'run'], ['2027-01-02', 'strength']]],
    ['2026-03-28', 'run', [['2026-03-29', 'strength'], ['2026-03-30', 'run']]],
    ['2026-10-24', 'strength', [['2026-10-25', 'run'], ['2026-10-26', 'strength']]],
    ['1969-12-31', 'run', [['1970-01-01', 'strength'], ['1969-12-30', 'strength']]],
  ]) {
    const person = { ...profile, trainingPlan: { mode: 'alternating', startDate, firstType } };
    for (const [date, expected] of checks) assert.equal(trainingForDate(person, date).type, expected, date);
  }
});

test('weekly and legacy schedules preserve their day mapping and neutral labels', () => {
  const weekly = { ...profile, trainingPlan: { mode: 'weekly', days: ['rest', 'run', 'strength', 'rest', 'run', 'strength', 'rest'] } };
  assert.deepEqual(trainingForDate(weekly, '2026-10-25'), { type: 'rest', label: 'Riposo', time: '' });
  assert.equal(trainingForDate(weekly, '2026-10-26').type, 'run');
  assert.equal(trainingForDate(weekly, '2026-10-27').type, 'strength');
  assert.deepEqual(trainingForDate(profile, '2026-10-23'), { type: 'strength', label: 'Sala attrezzi', time: '06:00' });
  assert.deepEqual(trainingForDate(profile, '2026-10-22'), { type: 'rest', label: 'Riposo', time: '' });
  assert.equal(trainingForDate({ trainingDays: [5] }, '2026-10-23').time, '06:00');
  assert.equal(trainingForDate({ ...weekly, trainingTime: '07:15' }, '2026-10-26').time, '07:15');
  assert.equal(validateTrainingPlan(undefined), undefined);
});

test('schedule validation rejects invalid shapes, activities, dates and sparse arrays', () => {
  for (const plan of [null, [], 'alternating', { mode: 'daily' },
    { mode: 'alternating', startDate: '2026-02-30', firstType: 'run' },
    { mode: 'alternating', startDate: '2101-01-01', firstType: 'run' },
    { mode: 'alternating', startDate: '2026-10-23', firstType: 'rest' },
    { mode: 'alternating', startDate: '2026-10-23', firstType: 'run', days: [] },
    { mode: 'weekly', days: ['run'] }, { mode: 'weekly', days: Array(7) },
    { mode: 'weekly', days: ['run', 'run', 'run', 'walk', 'run', 'run', 'rest'] },
  ]) {
    assert.throws(() => validateTrainingPlan(plan), Error);
    assert.throws(() => calculateTargets({ ...profile, trainingPlan: plan }), Error);
  }
  for (const date of ['2026-02-29', '2026-11-31', '2026-1-01', '1899-12-31', '2101-01-01']) assert.throws(() => trainingForDate(profile, date), Error);
  assert.throws(() => trainingForDate({ ...profile, trainingTime: '24:00' }, '2026-10-23'), /orario/);
  assert.throws(() => trainingForDate({ ...profile, trainingDays: Array(1) }, '2026-10-23'), /giorni/);
  assert.throws(() => calculateTargets({ ...profile, trainingDays: Array(1) }), /giorni/);
});

test('running and strength have identical targets and meal macros with no extra exercise calories', () => {
  const run = { ...profile, deficitKcal: 250, trainingPlan: { mode: 'alternating', startDate: '2026-10-23', firstType: 'run' } };
  const strength = { ...run, trainingPlan: { ...run.trainingPlan, firstType: 'strength' } };
  const targets = calculateTargets(run);
  assert.deepEqual(targets, calculateTargets(strength));
  assert.deepEqual(targets, calculateTargets({ ...profile, deficitKcal: 250, trainingDays: [] }));
  for (const date of ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']) {
    const runPlan = createDayPlan(run, targets, date);
    const strengthPlan = createDayPlan(strength, targets, date);
    assert.deepEqual(runPlan, strengthPlan);
    assert.deepEqual(runPlan.map(meal => meal.slot), ['preworkout', 'breakfast', 'lunch', 'dinner']);
    assert.equal(runPlan[0].time, '06:00');
    assert.equal(runPlan[1].time, '07:30');
    assert.ok(runPlan.every(meal => !/palestra/i.test(meal.note)));
    runPlan.forEach(meal => checkMeal(meal));
  }
  assert.ok(MEAL_SLOTS.every(slot => !/palestra/i.test(slot.label)));
  const weeklyRest = { ...run, trainingPlan: { mode: 'weekly', days: Array(7).fill('rest') } };
  assert.deepEqual(createDayPlan(weeklyRest, targets, '2026-10-23').map(meal => meal.slot), ['breakfast', 'lunch', 'dinner']);
});

test('activity-log choices are distinct and an absent log does not mean rest', () => {
  assert.deepEqual(TRAINING_LOG_TYPES, [
    { id: 'strength', label: 'Palestra' },
    { id: 'run', label: 'Corsa' },
    { id: 'both', label: 'Palestra + corsa' },
    { id: 'rest', label: 'Riposo' },
  ]);
  assert.ok(Object.isFrozen(TRAINING_LOG_TYPES));
  assert.ok(TRAINING_LOG_TYPES.every(Object.isFrozen));
  assert.equal(validateTrainingLog(undefined), undefined);
  assert.equal(trainingLogLabel(undefined), '');
  for (const item of TRAINING_LOG_TYPES) {
    const log = { type: item.id, source: 'manual', recordedAt: '2026-10-23T06:45:12.123Z' };
    assert.equal(validateTrainingLog(log), log);
    assert.equal(trainingLogLabel(log), item.label);
  }
});

test('activity logs require the complete supported-source schema and reject unknown fields', () => {
  const valid = { type: 'run', source: 'manual', recordedAt: '2026-10-23T06:45:12.123Z' };
  for (const log of [null, [], 'run', false, 0, {},
    { ...valid, type: 'walk' }, { ...valid, type: ['run', 'strength'] },
    { ...valid, source: 'strava' }, { ...valid, source: 'garmin_api' }, { ...valid, source: null },
    { type: 'run', source: 'manual' },
    { ...valid, calories: 500 }, { ...valid, unexpected: true },
    Object.create(valid),
  ]) {
    assert.throws(() => validateTrainingLog(log), Error);
    assert.throws(() => trainingLogLabel(log), Error);
  }
  const polluted = JSON.parse('{"type":"run","source":"manual","recordedAt":"2026-10-23T06:45:12.123Z","__proto__":{"polluted":true}}');
  assert.throws(() => validateTrainingLog(polluted));
  assert.equal({}.polluted, undefined);
  const imported = { ...valid, source: 'strava_csv' };
  assert.equal(validateTrainingLog(imported), imported);
  assert.equal(trainingLogLabel(imported), 'Corsa');
});

test('activity timestamps require real ISO instants with an explicit timezone', () => {
  for (const recordedAt of ['2026-10-23T06:00:00Z', '2026-10-23T08:00:00+02:00',
    '2026-10-23T01:00:00-05:00', '2028-02-29T23:59:59.123456Z']) {
    const log = { type: 'both', source: 'manual', recordedAt };
    assert.equal(validateTrainingLog(log).recordedAt, recordedAt);
  }
  for (const recordedAt of [undefined, null, NaN, Infinity, 0, new Date(), '',
    '2026-10-23', 'October 23, 2026', '2026-10-23T06:00:00',
    '2026-02-29T06:00:00Z', '2026-04-31T06:00:00Z', '2026-13-01T06:00:00Z',
    '2026-10-23T24:00:00Z', '2026-10-23T06:60:00Z', '2026-10-23T06:00:60Z',
    '2026-10-23T06:00:00+24:00']) {
    assert.throws(() => validateTrainingLog({ type: 'rest', source: 'manual', recordedAt }), /timestamp ISO/);
  }
});

test('validating actual activity leaves the planned session and nutrition snapshot unchanged', () => {
  const dateKey = '2026-10-23';
  const targets = calculateTargets(profile);
  const day = { profileSnapshot: structuredClone(profile), targets,
    meals: createDayPlan(profile, targets, dateKey), consumed: {}, skipped: [] };
  const before = structuredClone(day);
  const planned = trainingForDate(profile, dateKey);
  const actual = Object.freeze({ type: 'both', source: 'manual', recordedAt: '2026-10-23T10:00:00Z' });
  assert.equal(validateTrainingLog(actual), actual);
  assert.equal(trainingLogLabel(actual), 'Palestra + corsa');
  assert.deepEqual(day, before);
  assert.deepEqual(trainingForDate(profile, dateKey), planned);
  assert.equal(planned.type, 'strength');
  assert.deepEqual(calculateTargets(day.profileSnapshot), targets);
});
