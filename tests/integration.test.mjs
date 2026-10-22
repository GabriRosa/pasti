import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTargets, sumMacros } from '../src/nutrition.js';
import { FOODS, LIDL_FOOD_IDS, getFood, foodMacros } from '../src/foods.js';
import { createDayPlan, mealFromIngredients, mealAlternatives, swapMealFood } from '../src/planner.js';
import {
  STORAGE_KEY, SCHEMA_VERSION, MAX_BACKUP_BYTES, createEmptyData,
  validateData, parseBackup, loadData, saveData, exportBackup, clearData,
} from '../src/storage.js';

class MemoryStorage {
  constructor(entries = []) { this.entries = new Map(entries); this.writes = 0; }
  getItem(key) { return this.entries.get(key) ?? null; }
  setItem(key, value) { this.writes += 1; this.entries.set(key, String(value)); }
  removeItem(key) { this.entries.delete(key); }
}

const clone = value => structuredClone(value);
const profile = () => ({
  age: 35, sex: 'male', weight: 80, height: 180, activity: 'moderate',
  goal: 'maintain', trainingTime: '06:00', trainingDays: [1, 3, 5], specialCondition: false,
});
const macros = () => ({ kcal: 400, protein: 30, carbs: 50, fat: 9 });
const meal = (id = 'breakfast', slot = 'breakfast') => ({
  id, slot, title: 'Colazione', time: '07:15',
  ingredients: [{ foodId: 'greek-yogurt', grams: 200 }], macros: macros(), note: '',
});
function day(dateKey = '2026-10-22') {
  return {
    dateKey, createdAt: '2026-10-22T08:00:00Z', updatedAt: '2026-10-22T08:00:00Z',
    profileSnapshot: profile(),
    targets: { kcal: 2400, protein: 128, carbs: 292, fat: 80, bmr: 1755, tdee: 2400, warnings: [], method: 'Stima' },
    meals: [meal()], consumed: {}, skipped: [],
  };
}
function diary() {
  const data = createEmptyData();
  data.profile = profile();
  data.days['2026-10-22'] = day();
  data.days['2026-10-23'] = day('2026-10-23');
  return data;
}

test('empty persistence has an explicit schema and does not invent a profile', () => {
  const store = new MemoryStorage();
  assert.deepEqual(loadData(store), { data: { schemaVersion: SCHEMA_VERSION, profile: null, foodOverrides: {}, days: {} }, error: null });
  assert.equal(store.writes, 0);
});

test('save, reload and backup round-trip preserve separate dates and consumed snapshots', () => {
  const data = diary();
  const first = data.days['2026-10-22'];
  first.consumed.breakfast = { consumedAt: '2026-10-22T08:10:00Z', meal: clone(first.meals[0]) };
  data.days['2026-10-23'].meals[0].ingredients[0].grams = 150;
  data.days['2026-10-23'].meals[0].macros = { kcal: 300, protein: 22.5, carbs: 37.5, fat: 6.75 };
  const store = new MemoryStorage();
  saveData(data, store);
  assert.deepEqual(loadData(store), { data, error: null });
  assert.deepEqual(parseBackup(exportBackup(data)), data);
  assert.equal(loadData(store).data.days['2026-10-22'].consumed.breakfast.meal.ingredients[0].grams, 200);
  assert.deepEqual(loadData(store).data.days['2026-10-23'].consumed, {});
});

test('changing the profile and food labels preserves earlier day snapshots', () => {
  const data = diary();
  const historical = clone(data.days['2026-10-22']);
  historical.consumed.breakfast = { consumedAt: '2026-10-22T08:10:00Z', meal: clone(historical.meals[0]) };
  data.days['2026-10-22'] = clone(historical);
  data.profile.weight = 76;
  data.profile.goal = 'gain';
  data.profile.trainingDays = [2, 4];
  data.foodOverrides['protein-pudding-lidl'] = { kcal: 88, protein: 12, carbs: 6, fat: 1.2 };
  const restored = parseBackup(exportBackup(data));
  assert.deepEqual(restored.days['2026-10-22'], historical);
  assert.equal(restored.profile.weight, 76);
});

test('invalid replacements never overwrite a saved diary', () => {
  const store = new MemoryStorage();
  const original = diary();
  saveData(original, store);
  const before = store.getItem(STORAGE_KEY);
  const invalid = clone(original);
  invalid.days['2026-10-22'].meals[0].ingredients[0].grams = -1;
  assert.throws(() => saveData(invalid, store));
  assert.equal(store.getItem(STORAGE_KEY), before);
  assert.equal(store.writes, 1);
});

test('malformed JSON, unknown schemas and extra fields are rejected', () => {
  assert.throws(() => parseBackup('{'));
  for (const mutate of [
    data => { data.schemaVersion += 1; },
    data => { data.unexpected = true; },
    data => { delete data.days; },
    data => { data.profile = []; },
  ]) {
    const data = diary(); mutate(data);
    assert.throws(() => parseBackup(JSON.stringify(data)));
  }
});

test('prototype keys are rejected without altering object prototypes', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const json = `{"schemaVersion":1,"profile":null,"foodOverrides":{"${key}":{"polluted":true}},"days":{}}`;
    assert.throws(() => parseBackup(json));
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('invalid dates, duplicate meals and invalid consumption links are rejected', () => {
  const cases = [
    data => { data.days['2026-02-30'] = day('2026-02-30'); },
    data => { data.days['2026-10-22'].dateKey = '2026-10-23'; },
    data => { data.days['2026-10-22'].meals.push(meal()); },
    data => { data.days['2026-10-22'].meals.push(meal('other-breakfast')); },
    data => { data.days['2026-10-22'].consumed.unknown = { consumedAt: '2026-10-22T08:10:00Z', meal: meal('unknown') }; },
    data => { data.days['2026-10-22'].consumed.breakfast = { consumedAt: '2026-10-22T08:10:00Z', meal: meal('different-id') }; },
    data => { data.days['2026-10-22'].skipped = ['breakfast']; },
  ];
  for (const mutate of cases) {
    const data = diary(); mutate(data);
    assert.throws(() => validateData(data));
  }
});

test('a preworkout can be skipped or consumed, but not both', () => {
  const data = diary();
  const first = data.days['2026-10-22'];
  first.meals.unshift(meal('preworkout', 'preworkout'));
  first.skipped = ['preworkout'];
  assert.doesNotThrow(() => validateData(data));
  first.consumed.preworkout = { consumedAt: '2026-10-22T05:30:00Z', meal: clone(first.meals[0]) };
  assert.throws(() => validateData(data));
  first.skipped = [];
  assert.doesNotThrow(() => validateData(data));
});

test('non-finite quantities, targets and labels cannot enter persistent state', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, '100']) {
    for (const mutate of [
      data => { data.days['2026-10-22'].meals[0].ingredients[0].grams = value; },
      data => { data.days['2026-10-22'].targets.kcal = value; },
      data => { data.foodOverrides['protein-pudding-lidl'] = { ...macros(), protein: value }; },
    ]) {
      const data = diary(); mutate(data);
      assert.throws(() => validateData(data));
    }
  }
});

test('an unreadable local diary is retained for recovery and is reported to the caller', () => {
  const raw = '{invalid backup';
  const store = new MemoryStorage([[STORAGE_KEY, raw]]);
  const result = loadData(store);
  assert.deepEqual(result.data, createEmptyData());
  assert.ok(result.error instanceof Error);
  assert.equal(store.getItem(STORAGE_KEY), raw);
  assert.equal(store.writes, 0);
});

test('read and write failures leave the previous storage content intact', () => {
  const readFailure = loadData({ getItem() { throw new Error('Blocked'); } });
  assert.ok(readFailure.error instanceof Error);
  const store = new MemoryStorage([[STORAGE_KEY, 'previous']]);
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => saveData(diary(), store), /Salvataggio non riuscito/);
  assert.equal(store.getItem(STORAGE_KEY), 'previous');
});

test('backup size is measured in UTF-8 bytes, including multibyte input', () => {
  const tooLarge = 'é'.repeat(Math.floor(MAX_BACKUP_BYTES / 2) + 1);
  assert.ok(tooLarge.length < MAX_BACKUP_BYTES);
  assert.throws(() => parseBackup(tooLarge), /5 MB/);
});

test('clearing this app leaves unrelated localStorage entries intact', () => {
  const store = new MemoryStorage([['other-app', 'preserve']]);
  saveData(diary(), store);
  assert.deepEqual(clearData(store), createEmptyData());
  assert.equal(store.getItem(STORAGE_KEY), null);
  assert.equal(store.getItem('other-app'), 'preserve');
});

test('blocked access to the localStorage property is returned as a recoverable load error', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Accesso negato'); } });
  try {
    const result = loadData();
    assert.deepEqual(result.data, createEmptyData());
    assert.ok(result.error instanceof Error);
    assert.throws(() => saveData(diary()), /Salvataggio non riuscito/);
    assert.throws(() => clearData(), /Impossibile cancellare/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('every successfully saved diary exports a backup that can be imported', () => {
  const data = createEmptyData();
  data.profile = profile();
  for (let index = 0; index < 1800; index += 1) {
    const date = new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
    data.days[date] = day(date);
    data.days[date].meals[0].note = 'N'.repeat(1800);
  }
  const store = new MemoryStorage();
  assert.doesNotThrow(() => saveData(data, store));
  const backup = exportBackup(data);
  assert.doesNotThrow(() => parseBackup(backup));
  assert.deepEqual(parseBackup(backup), data);
});

function generatedDiary(dateKey = '2026-10-23') {
  const data = createEmptyData();
  data.profile = { ...profile(), trainingDays: [0, 1, 2, 3, 4, 5, 6] };
  const targets = calculateTargets(data.profile);
  data.days[dateKey] = {
    ...day(dateKey), profileSnapshot: clone(data.profile), targets,
    meals: createDayPlan(data.profile, targets, dateKey),
  };
  return data;
}

function assertMacrosClose(actual, expected) {
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${key}: ${actual[key]} vs ${expected[key]}`);
  }
}

test('generated meals, all alternatives and every requested main-food swap survive backup import', () => {
  const data = generatedDiary();
  const dateKey = '2026-10-23';
  const original = data.days[dateKey];
  for (const originalMeal of original.meals) {
    const alternatives = mealAlternatives(originalMeal, original.targets);
    assert.ok(alternatives.length >= 3);
    for (const alternative of alternatives) {
      const changed = clone(data);
      changed.days[dateKey].meals = original.meals.map(item => item.id === originalMeal.id ? alternative : item);
      assert.deepEqual(parseBackup(exportBackup(changed)), changed);
      assertMacrosClose(alternative.macros, sumMacros(alternative.ingredients.map(item => foodMacros(item.foodId, item.grams))));
    }
    if (!['lunch', 'dinner'].includes(originalMeal.slot)) continue;
    for (const ids of [
      ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl'],
      ['chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin'],
    ]) {
      const old = originalMeal.ingredients.find(item => ids.includes(item.foodId));
      assert.ok(old);
      for (const foodId of ids) {
        const swapped = swapMealFood(originalMeal, old.foodId, foodId);
        const changed = clone(data);
        changed.days[dateKey].meals = original.meals.map(item => item.id === originalMeal.id ? swapped : item);
        assert.deepEqual(parseBackup(exportBackup(changed)), changed);
        assert.ok(swapped.ingredients.some(item => item.foodId === foodId));
      }
    }
  }
});

test('preferred breakfasts are selectable and persist with editable package grams', () => {
  const data = generatedDiary();
  const first = data.days['2026-10-23'];
  const breakfast = first.meals.find(item => item.slot === 'breakfast');
  const alternatives = mealAlternatives(breakfast, first.targets);
  for (const id of ['protein-pudding-lidl', 'protein-mousse-lidl', 'greek-yogurt']) {
    const choice = alternatives.find(item => item.ingredients.some(ingredient => ingredient.foodId === id)
      && (id !== 'greek-yogurt' || item.ingredients.some(ingredient => ingredient.foodId === 'dark-chocolate')));
    assert.ok(choice, id);
    const resized = mealFromIngredients({ ...choice, ingredients: choice.ingredients.map(item => item.foodId === id ? { ...item, grams: 150 } : item) });
    const changed = clone(data);
    changed.days['2026-10-23'].meals = first.meals.map(item => item.id === breakfast.id ? resized : item);
    assert.deepEqual(parseBackup(exportBackup(changed)), changed);
  }
});

test('new label values recalculate edited plans while stored consumption stays unchanged', () => {
  const data = generatedDiary();
  const first = data.days['2026-10-23'];
  const original = first.meals.find(item => item.slot === 'breakfast');
  const pudding = mealAlternatives(original, first.targets).find(item => item.ingredients.some(ingredient => ingredient.foodId === 'protein-pudding-lidl'));
  first.meals = first.meals.map(item => item.id === pudding.id ? pudding : item);
  first.consumed[pudding.id] = { consumedAt: '2026-10-23T08:00:00Z', meal: clone(pudding) };
  const historical = clone(first.consumed[pudding.id]);
  data.foodOverrides['protein-pudding-lidl'] = { kcal: 90, protein: 12, carbs: 7, fat: 2 };
  const recalculated = mealFromIngredients(pudding, data.foodOverrides);
  assert.notEqual(recalculated.macros.kcal, pudding.macros.kcal);
  const restored = parseBackup(exportBackup(data));
  assert.deepEqual(restored.days['2026-10-23'].consumed[pudding.id], historical);
  assertMacrosClose(sumMacros(Object.values(restored.days['2026-10-23'].consumed).map(item => item.meal.macros)), historical.meal.macros);
});

test('all catalog foods provide persistable ingredient quantities and finite contributions', () => {
  const data = generatedDiary();
  const first = data.days['2026-10-23'];
  const lunch = first.meals.find(item => item.slot === 'lunch');
  const complete = mealFromIngredients({ ...lunch, ingredients: FOODS.map(item => ({ foodId: item.id, grams: 10 })) });
  first.meals = first.meals.map(item => item.id === lunch.id ? complete : item);
  assert.deepEqual(parseBackup(exportBackup(data)), data);
  assertMacrosClose(complete.macros, sumMacros(FOODS.map(item => foodMacros(item.id, 10))));
});

// Exercise the app's real event handlers without a browser or a layout engine.
// This surface implements only the DOM operations used by app.js; visual and
// native accessibility behavior remain part of the coordinator's browser pass.
class MemoryElement {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
    this.events = new Map(); this.className = ''; this.parentNode = null;
    this._text = text; this._value = null; this.open = false;
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  get value() {
    if (this._value !== null) return this._value;
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      return (options.find(option => option.selected) || options[0])?.value ?? '';
    }
    return this.attributes.value ?? '';
  }
  set value(value) { this._value = String(value); }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  get isConnected() { return this.tagName === 'BODY' || Boolean(this.parentNode?.isConnected); }
  get classList() {
    return {
      contains: value => this.className.split(/\s+/).includes(value),
      toggle: (value, on) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (on) classes.add(value); else classes.delete(value);
        this.className = [...classes].join(' ');
      },
    };
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'value') this.value = value;
  }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) {
    for (const child of children) { child.parentNode = this; this.children.push(child); }
  }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(name, listener) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(listener);
  }
  dispatch(name, extra = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    for (const listener of this.events.get(name) || []) listener(event);
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { globalThis.document.activeElement = this; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  checkValidity() {
    if (this.required && this.value === '') return false;
    if (this.attributes.type === 'number' && this.value !== '') {
      const value = this.valueAsNumber;
      if (!Number.isFinite(value)) return false;
      if (this.attributes.min !== undefined && value < Number(this.attributes.min)) return false;
      if (this.attributes.max !== undefined && value > Number(this.attributes.max)) return false;
    }
    return true;
  }
  reportValidity() { return this.querySelectorAll('input, select').every(control => control.checkValidity()); }
  matchesSimple(selector) {
    const attr = selector.match(/^([a-z]*)\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase())
      && (attr[3] === undefined ? this.attributes[attr[2]] !== undefined || Boolean(this[attr[2]]) : this.attributes[attr[2]] === attr[3]);
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const [tag, ...classes] = selector.split('.');
    return (!tag || this.tagName === tag.toUpperCase()) && classes.every(value => this.classList.contains(value));
  }
  querySelectorAll(selector) {
    const groups = selector.split(',').map(group => group.trim().split(/\s+/));
    const matches = (node, parts) => {
      if (!node.matchesSimple(parts.at(-1))) return false;
      let ancestor = node.parentNode;
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        while (ancestor && !ancestor.matchesSimple(parts[index])) ancestor = ancestor.parentNode;
        if (!ancestor) return false;
        ancestor = ancestor.parentNode;
      }
      return true;
    };
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (groups.some(parts => matches(child, parts))) result.push(child);
        visit(child);
      }
    };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

let appImport = 0;
async function bootApp(t, store, hash = 'today') {
  const body = new MemoryElement('body');
  for (const id of ['main', 'notifications', 'app-dialog']) {
    const element = new MemoryElement(id === 'app-dialog' ? 'dialog' : 'div');
    element.id = id; body.append(element);
  }
  const document = {
    body, activeElement: body,
    querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector),
    createElement: tag => new MemoryElement(tag),
    createTextNode: text => new MemoryElement('#text', String(text)),
    createDocumentFragment: () => new MemoryElement('#fragment'),
  };
  const window = new MemoryElement('window'); window.scrollTo = () => {};
  const location = { hash: `#${hash}` };
  class MemoryFormData {
    constructor(form) {
      this.pairs = form.querySelectorAll('input, select').filter(control => control.attributes.name
        && !(control.attributes.type === 'checkbox' && !control.checked))
        .map(control => [control.attributes.name, control.attributes.type === 'checkbox' ? control.value || 'on' : control.value]);
    }
    get(name) { return this.pairs.find(pair => pair[0] === name)?.[1] ?? null; }
    getAll(name) { return this.pairs.filter(pair => pair[0] === name).map(pair => pair[1]); }
  }
  const globals = { document, window, location, Node: MemoryElement, FormData: MemoryFormData, localStorage: store,
    requestAnimationFrame: callback => callback(), setTimeout: () => 0, clearTimeout: () => {} };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await import(`../app.js?integration=${appImport += 1}`);
  return { document, window, location, navigate(page) { location.hash = `#${page}`; window.dispatch('hashchange'); } };
}

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('app handlers persist portion edits, register consumption and undo it without changing the plan', async t => {
  const key = todayKey();
  const initial = generatedDiary(key);
  const store = new MemoryStorage(); saveData(initial, store);
  const { document } = await bootApp(t, store);
  const lunchIndex = initial.days[key].meals.findIndex(item => item.slot === 'lunch');
  const original = initial.days[key].meals[lunchIndex];
  document.querySelectorAll('.meal-card')[lunchIndex].querySelector('.meal-actions button').click();
  const grams = document.querySelector('.edit-ingredients input');
  grams.value = String(original.ingredients[0].grams + 10); grams.dispatch('input');
  document.querySelector('.dialog-actions button.primary').click();
  const changed = loadData(store).data.days[key].meals[lunchIndex];
  assert.equal(changed.ingredients[0].grams, original.ingredients[0].grams + 10);
  const addition = foodMacros(original.ingredients[0].foodId, 10);
  assertMacrosClose(changed.macros, sumMacros([original.macros, addition]));
  document.querySelectorAll('.meal-card')[lunchIndex].querySelector('button.primary').click();
  const consumed = loadData(store).data.days[key].consumed;
  assert.deepEqual(consumed[original.id].meal, changed);
  assertMacrosClose(sumMacros(Object.values(consumed).map(entry => entry.meal.macros)), changed.macros);
  document.querySelectorAll('.meal-card')[lunchIndex].querySelector('button.secondary').click();
  assert.deepEqual(loadData(store).data.days[key].consumed, {});
  assert.deepEqual(loadData(store).data.days[key].meals[lunchIndex], changed);
});

test('a storage update while a meal dialog is open cannot overwrite another tab consumption', async t => {
  const key = todayKey();
  const initial = generatedDiary(key);
  const store = new MemoryStorage(); saveData(initial, store);
  const { document, window } = await bootApp(t, store);
  const lunchIndex = initial.days[key].meals.findIndex(item => item.slot === 'lunch');
  document.querySelectorAll('.meal-card')[lunchIndex].querySelector('.meal-actions button').click();
  const external = loadData(store).data;
  const dinner = external.days[key].meals.find(item => item.slot === 'dinner');
  external.days[key].consumed[dinner.id] = { consumedAt: new Date().toISOString(), meal: clone(dinner) };
  saveData(external, store);
  window.dispatch('storage', { key: STORAGE_KEY });
  document.querySelector('.dialog-actions button.primary').click();
  assert.deepEqual(loadData(store).data.days[key].consumed[dinner.id], external.days[key].consumed[dinner.id]);
});

test('app import waits for confirmation and keeps existing data when a backup contains unknown foods', async t => {
  const key = todayKey();
  const initial = generatedDiary(key);
  const store = new MemoryStorage(); saveData(initial, store);
  const { document } = await bootApp(t, store, 'profile');
  const input = document.querySelector('#backup-file');
  for (const invalidate of [
    data => { data.days[key].meals[0].ingredients[0].foodId = 'unknown-food'; },
    data => { data.profile.age = 17; },
    data => { data.profile.specialCondition = true; },
  ]) {
    const invalid = clone(initial); invalidate(invalid);
    const invalidJSON = JSON.stringify(invalid);
    input.files = [{ size: Buffer.byteLength(invalidJSON), text: async () => invalidJSON }]; input.dispatch('change');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.querySelector('#app-dialog').open, false);
    assert.deepEqual(loadData(store).data, initial);
  }
  const replacement = clone(initial); replacement.profile.weight = 79;
  const validJSON = exportBackup(replacement);
  input.files = [{ size: Buffer.byteLength(validJSON), text: async () => validJSON }]; input.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('#app-dialog').open, true);
  assert.deepEqual(loadData(store).data, initial);
  document.querySelector('.dialog-actions button.primary').click();
  assert.deepEqual(loadData(store).data, replacement);
});

test('profile and label form edits retain historical data and apply to newly opened dates', async t => {
  const key = todayKey();
  const initial = generatedDiary(key);
  const first = initial.days[key];
  const breakfast = first.meals.find(item => item.slot === 'breakfast');
  first.consumed[breakfast.id] = { consumedAt: new Date().toISOString(), meal: clone(breakfast) };
  const historical = clone(first);
  const store = new MemoryStorage(); saveData(initial, store);
  const app = await bootApp(t, store, 'profile');
  const form = app.document.querySelector('.profile-form');
  form.querySelector('[name="weight"]').value = '75';
  form.querySelector('[name="goal"]').value = 'gain';
  form.dispatch('submit');
  assert.equal(loadData(store).data.profile.weight, 75);
  assert.equal(loadData(store).data.profile.goal, 'gain');
  assert.deepEqual(loadData(store).data.days[key], historical);
  app.navigate('foods');
  const product = app.document.querySelector('.label-form select');
  product.value = 'protein-pudding-lidl'; product.dispatch('change');
  const labelForm = app.document.querySelector('.label-form');
  const override = { kcal: 90, protein: 12, carbs: 7, fat: 2 };
  for (const [name, value] of Object.entries(override)) labelForm.querySelector(`[name="${name}"]`).value = String(value);
  labelForm.dispatch('submit');
  assert.deepEqual(loadData(store).data.foodOverrides['protein-pudding-lidl'], override);
  assert.deepEqual(loadData(store).data.days[key], historical);
  app.navigate('today');
  const nextDate = new Date(`${key}T12:00:00`); nextDate.setDate(nextDate.getDate() + 1);
  const futureKey = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
  const picker = app.document.querySelector('input[type="date"]');
  picker.value = futureKey; picker.dispatch('change');
  const final = loadData(store).data;
  assert.equal(final.days[futureKey].profileSnapshot.weight, 75);
  assert.deepEqual(final.days[futureKey].meals, createDayPlan(final.profile, final.days[futureKey].targets, futureKey, final.foodOverrides));
  assert.deepEqual(final.days[key], historical);
});

test('consumption above the target remains visible in the energy meter', async t => {
  const key = todayKey();
  const initial = generatedDiary(key);
  const first = initial.days[key];
  for (const item of first.meals) {
    const larger = mealFromIngredients({ ...item, ingredients: item.ingredients.map(ingredient => ({ ...ingredient, grams: ingredient.grams * 3 })) });
    first.consumed[item.id] = { consumedAt: new Date().toISOString(), meal: larger };
  }
  const store = new MemoryStorage(); saveData(initial, store);
  const { document } = await bootApp(t, store);
  const energy = sumMacros(Object.values(first.consumed).map(entry => entry.meal.macros)).kcal;
  assert.ok(energy > first.targets.kcal);
  const meter = document.querySelector('[role="meter"]');
  assert.equal(Number(meter.attributes['aria-valuenow']), energy);
  assert.ok(Number(meter.attributes['aria-valuemax']) >= energy);
});

test('dates before the Unix epoch within the planner range still generate persistable meals', () => {
  for (const dateKey of ['1900-01-01', '1969-12-31', '1970-01-01']) {
    const data = generatedDiary(dateKey);
    assert.deepEqual(parseBackup(exportBackup(data)), data);
  }
});

function dateOffset(key, days) {
  const date = new Date(`${key}T12:00:00`); date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function pastaAndChickenDiary() {
  const key = todayKey();
  const data = generatedDiary(key);
  const lunch = data.days[key].meals.find(item => item.slot === 'lunch');
  data.days[key].meals = data.days[key].meals.map(item => item.id === lunch.id ? mealFromIngredients({
    ...lunch, ingredients: [{ foodId: 'pasta', grams: 80 }, { foodId: 'chicken', grams: 170 },
      { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 10 }],
  }) : item);
  return { data, key, lunchId: lunch.id };
}

function openMeal(document, data, key, id) {
  const index = data.days[key].meals.findIndex(item => item.id === id);
  document.querySelectorAll('.meal-card')[index].querySelector('.meal-actions button').click();
}

test('pasta-to-lentil UI swap shows the lower chicken portion and counts every protein source', async t => {
  const { data, key, lunchId } = pastaAndChickenDiary();
  const original = data.days[key].meals.find(item => item.id === lunchId);
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  openMeal(document, data, key, lunchId);
  const select = document.querySelector('.swap-fields select');
  select.value = 'lentil-pasta-lidl'; select.dispatch('change');
  const expected = swapMealFood(original, 'pasta', 'lentil-pasta-lidl');
  const chicken = expected.ingredients.find(item => item.foodId === 'chicken');
  assert.ok(chicken.grams < 170);
  const comparison = document.querySelector('.portion-update');
  assert.equal(comparison.hidden, false);
  assert.equal(comparison.attributes['aria-live'], 'polite');
  const chickenRow = comparison.querySelectorAll('li').find(row => row.children[0].textContent === getFood('chicken').name);
  assert.ok(chickenRow, 'The adapted chicken portion must be included in the comparison');
  const portion = document.querySelectorAll('.edit-ingredients input').find(input => input.attributes['aria-label'] === `${getFood('chicken').name}, grammi`);
  assert.equal(portion.valueAsNumber, Number(chicken.grams.toFixed(1)));
  assert.equal(store.writes, 1, 'Changing the draft must not persist before Save');
  document.querySelector('.dialog-actions button.primary').click();
  const result = loadData(store).data.days[key].meals.find(item => item.id === lunchId);
  assert.deepEqual(result, expected);
  const protein = result.ingredients.reduce((sum, item) => sum + foodMacros(item.foodId, item.grams).protein, 0);
  assert.ok(protein > foodMacros('chicken', chicken.grams).protein);
  assertMacrosClose(result.macros, sumMacros(result.ingredients.map(item => foodMacros(item.foodId, item.grams))));
});

test('manual portion edits clear the previous swap comparison and Cancel writes nothing', async t => {
  const { data, key, lunchId } = pastaAndChickenDiary();
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store);
  openMeal(document, data, key, lunchId);
  const select = document.querySelector('.swap-fields select');
  select.value = 'lentil-pasta-lidl'; select.dispatch('change');
  assert.equal(document.querySelector('.portion-update').hidden, false);
  const portion = document.querySelector('.edit-ingredients input');
  portion.value = '120'; portion.dispatch('input');
  assert.equal(document.querySelector('.portion-update').hidden, true);
  document.querySelector('.dialog-actions button.secondary').click();
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  assert.equal(store.writes, 1);
});

function refreshFixture() {
  const key = todayKey();
  const pastKey = dateOffset(key, -1);
  const futureKey = dateOffset(key, 1);
  const data = generatedDiary(key);
  data.days[pastKey] = generatedDiary(pastKey).days[pastKey];
  data.days[futureKey] = generatedDiary(futureKey).days[futureKey];
  for (const current of Object.values(data.days)) for (const item of current.meals) item.note = 'Nota del diario da conservare.';
  data.foodOverrides['protein-pudding-lidl'] = { kcal: 95, protein: 12, carbs: 7, fat: 2.1 };
  const today = data.days[key];
  const consumed = today.meals.find(item => item.slot === 'breakfast');
  consumed.macros = Object.fromEntries(Object.entries(consumed.macros).map(([metric, value]) => [metric, value * 0.8]));
  today.consumed[consumed.id] = { consumedAt: new Date().toISOString(), meal: clone(consumed) };
  today.skipped = [today.meals.find(item => item.slot === 'preworkout').id];
  const lunch = today.meals.find(item => item.slot === 'lunch');
  lunch.macros = Object.fromEntries(Object.entries(lunch.macros).map(([metric, value]) => [metric, value * 0.8]));
  const future = data.days[futureKey];
  const breakfast = future.meals.find(item => item.slot === 'breakfast');
  const pudding = mealAlternatives(breakfast, future.targets, data.foodOverrides).find(item => item.ingredients.some(ingredient => ingredient.foodId === 'protein-pudding-lidl'));
  pudding.note = 'Nota del diario da conservare.';
  pudding.macros = Object.fromEntries(Object.entries(pudding.macros).map(([metric, value]) => [metric, value * 0.8]));
  future.meals = future.meals.map(item => item.id === breakfast.id ? pudding : item);
  const past = data.days[pastKey].meals[0];
  past.macros = Object.fromEntries(Object.entries(past.macros).map(([metric, value]) => [metric, value * 0.8]));
  return { data, key, pastKey, futureKey, changedIds: [lunch.id, pudding.id] };
}

test('refresh updates only eligible macros, respects overrides and preserves grams and history', async t => {
  const { data, key, pastKey, futureKey, changedIds } = refreshFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'foods');
  document.querySelector('.refresh-panel button').click();
  assert.equal(document.querySelector('#app-dialog').open, true);
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  document.querySelector('.dialog-actions button.primary').click();
  const result = loadData(store).data;
  const expected = clone(data);
  for (const date of [key, futureKey]) {
    for (const item of expected.days[date].meals) {
      if (changedIds.includes(item.id)) item.macros = mealFromIngredients(item, expected.foodOverrides).macros;
    }
    assert.notEqual(result.days[date].updatedAt, data.days[date].updatedAt);
    expected.days[date].updatedAt = result.days[date].updatedAt;
  }
  assert.deepEqual(result, expected);
  assert.deepEqual(result.days[pastKey], data.days[pastKey]);
  const pudding = result.days[futureKey].meals.find(item => changedIds.includes(item.id));
  assertMacrosClose(pudding.macros, mealFromIngredients(pudding, data.foodOverrides).macros);
  assert.equal(store.writes, 2, 'The approved refresh must use one atomic replacement');
});

test('refresh cancellation and a later no-op leave storage untouched', async t => {
  const { data } = refreshFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'foods');
  document.querySelector('.refresh-panel button').click();
  document.querySelector('.dialog-actions button.secondary').click();
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  assert.equal(store.writes, 1);
  document.querySelector('.refresh-panel button').click();
  document.querySelector('.dialog-actions button.primary').click();
  const afterUpdate = store.getItem(STORAGE_KEY);
  document.querySelector('.refresh-panel button').click();
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.equal(store.getItem(STORAGE_KEY), afterUpdate);
  assert.equal(store.writes, 2);
});

test('a cross-tab conflict between refresh preview and confirmation cannot replace newer data', async t => {
  const { data } = refreshFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document, window } = await bootApp(t, store, 'foods');
  document.querySelector('.refresh-panel button').click();
  const external = loadData(store).data;
  external.profile.weight = 79;
  saveData(external, store);
  const latestJSON = store.getItem(STORAGE_KEY);
  window.dispatch('storage', { key: STORAGE_KEY });
  document.querySelector('.dialog-actions button.primary').click();
  assert.equal(store.getItem(STORAGE_KEY), latestJSON);
  assert.equal(store.writes, 2);
});

test('refresh confirms obsolete reference notes and preserves consumed notes and current macros', async t => {
  const { data, key, lunchId } = pastaAndChickenDiary();
  const lunch = data.days[key].meals.find(item => item.id === lunchId);
  const lentil = swapMealFood(lunch, 'pasta', 'lentil-pasta-lidl');
  lentil.note = 'Nota precedente. Valori Lidl da verificare sulla confezione.';
  data.days[key].meals = data.days[key].meals.map(item => item.id === lunchId ? lentil : item);
  for (const item of data.days[key].meals) if (item.id !== lunchId) item.note = 'Nota da conservare.';
  const breakfast = data.days[key].meals.find(item => item.slot === 'breakfast');
  const pudding = mealAlternatives(breakfast, data.days[key].targets).find(item => item.ingredients.some(ingredient => ingredient.foodId === 'protein-pudding-lidl'));
  pudding.note = 'Un vasetto da 200 g è solo un esempio: modifica grammi e valori con la confezione.';
  data.days[key].meals = data.days[key].meals.map(item => item.id === breakfast.id ? pudding : item);
  data.days[key].consumed[pudding.id] = { consumedAt: new Date().toISOString(), meal: clone(pudding) };
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'foods');
  document.querySelector('.refresh-panel button').click();
  assert.equal(document.querySelector('#app-dialog').open, true);
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  document.querySelector('.dialog-actions button.secondary').click();
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  assert.equal(store.writes, 1);
  document.querySelector('.refresh-panel button').click();
  document.querySelector('.dialog-actions button.primary').click();
  const actual = loadData(store).data;
  const changed = actual.days[key].meals.find(item => item.id === lunchId);
  assert.notEqual(changed.note, lentil.note);
  const expected = clone(data);
  expected.days[key].meals.find(item => item.id === lunchId).note = changed.note;
  expected.days[key].updatedAt = actual.days[key].updatedAt;
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.days[key].consumed, data.days[key].consumed);
  const afterUpdate = store.getItem(STORAGE_KEY);
  document.querySelector('.refresh-panel button').click();
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.equal(store.getItem(STORAGE_KEY), afterUpdate);
  assert.equal(store.writes, 2);
});

test('a failed recalculation cannot apply the partially refreshed copy', async t => {
  const { data, futureKey } = refreshFixture();
  data.days[futureKey].meals.at(-1).ingredients[0].foodId = 'unknown-food';
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'foods');
  document.querySelector('.refresh-panel button').click();
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  assert.equal(store.writes, 1);
});

test('verified Lidl desserts have distinct label values, package sizes and evidence', () => {
  const desserts = LIDL_FOOD_IDS.map(id => getFood(id)).filter(item => item.group === 'breakfast');
  assert.equal(desserts.length, 4);
  const actual = desserts.map(item => [item.kcal, item.protein, item.carbs, item.fat, item.label.packGrams]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(actual, [[75, 10, 5.2, 1.5, 200], [76, 10, 5.8, 1.4, 175], [83, 10.1, 6.5, 1.5, 200], [86, 10, 5.8, 2.2, 175]]);
  for (const item of desserts) {
    assert.equal(item.estimated, false);
    assert.equal(item.label.market, 'Italia');
    assert.match(item.label.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(item.label.evidenceUrl, /^https:\/\//);
  }
  const fresh = getFood('lentil-pasta-lidl-fresh');
  const dry = getFood('lentil-pasta-lidl');
  assert.notEqual(fresh.label.barcode, dry.label.barcode);
  assert.equal(fresh.label.packGrams, 200);
  assert.equal(dry.label.packGrams, 250);
  assert.notEqual(fresh.carbs, dry.carbs);
});

test('the food form exposes each verified variant, evidence and user overrides', async t => {
  const initial = generatedDiary(todayKey());
  initial.foodOverrides['protein-pudding-lidl'] = { kcal: 94, protein: 13, carbs: 5, fat: 2 };
  const store = new MemoryStorage(); saveData(initial, store);
  const { document } = await bootApp(t, store, 'foods');
  const formIds = new Set(document.querySelector('.label-form select').querySelectorAll('option').map(option => option.value));
  for (const id of LIDL_FOOD_IDS) assert.ok(formIds.has(id));
  const cards = document.querySelectorAll('.food-card');
  for (const id of LIDL_FOOD_IDS) {
    const food = getFood(id);
    const card = cards.find(item => item.querySelector('h3').textContent === food.name);
    assert.ok(card);
    assert.equal(card.querySelector('.label-reference a').attributes.href, food.label.evidenceUrl);
    assert.equal(Boolean(card.querySelector('.verified-tag')), id !== 'protein-pudding-lidl');
  }
  const product = document.querySelector('.label-form select');
  product.value = 'protein-pudding-lidl'; product.dispatch('change');
  for (const [key, value] of Object.entries(initial.foodOverrides['protein-pudding-lidl'])) {
    assert.equal(document.querySelector(`input[name="${key}"]`).valueAsNumber, value);
  }
  assert.deepEqual(loadData(store).data, initial);
});

test('fresh lentil pasta and all four dessert variants are selectable with their label package size', async t => {
  const { data, key, lunchId } = pastaAndChickenDiary();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  openMeal(document, data, key, lunchId);
  const carb = document.querySelector('.swap-fields select');
  assert.ok(carb.querySelectorAll('option').some(option => option.value === 'lentil-pasta-lidl-fresh'));
  carb.value = 'lentil-pasta-lidl-fresh'; carb.dispatch('change');
  const freshPortion = document.querySelectorAll('.edit-ingredients input').find(input => input.attributes['aria-label'] === `${getFood('lentil-pasta-lidl-fresh').name}, grammi`);
  assert.ok(freshPortion && freshPortion.valueAsNumber > 0);
  document.querySelector('.dialog-actions button.secondary').click();
  const breakfast = data.days[key].meals.find(item => item.slot === 'breakfast');
  openMeal(document, data, key, breakfast.id);
  const alternatives = mealAlternatives(breakfast, data.days[key].targets);
  const variantSelect = document.querySelector('.dialog-content select');
  const desserts = LIDL_FOOD_IDS.map(id => getFood(id)).filter(item => item.group === 'breakfast');
  assert.equal(desserts.length, 4);
  for (const dessert of desserts) {
    const index = alternatives.findIndex(item => item.ingredients.some(ingredient => ingredient.foodId === dessert.id));
    assert.ok(index >= 0, dessert.id);
    variantSelect.value = String(index); variantSelect.dispatch('change');
    const portion = document.querySelectorAll('.edit-ingredients input').find(input => input.attributes['aria-label'] === `${dessert.name}, grammi`);
    assert.ok(portion, `${dessert.id}: ${JSON.stringify(document.querySelectorAll('.edit-ingredients input').map(input => input.attributes['aria-label']))}`);
    assert.equal(portion.valueAsNumber, dessert.label.packGrams);
  }
  document.querySelector('.dialog-actions button.secondary').click();
  assert.deepEqual(loadData(store).data, data);
  assert.equal(store.writes, 1);
});

test('successive UI swaps preserve protein while rebalancing the counted bread', async t => {
  const { data, key, lunchId } = pastaAndChickenDiary();
  data.days[key].meals = data.days[key].meals.map(item => item.id === lunchId ? mealFromIngredients({
    ...item, ingredients: [{ foodId: 'pasta', grams: 100 }, { foodId: 'chicken', grams: 100 },
      { foodId: 'vegetables', grams: 200 }, { foodId: 'olive-oil', grams: 10 }],
  }) : item);
  const targetProtein = 13.5 + 23.3 + 3;
  const per100 = { pasta: 13.5, rice: 6.7, chicken: 23.3, vegetables: 1.5, 'olive-oil': 0,
    bread: 8.5, 'lentil-pasta-lidl': 26, 'lentil-pasta-lidl-fresh': 19 };
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  let current = data;
  let sawBread = false;
  for (const id of ['lentil-pasta-lidl', 'lentil-pasta-lidl-fresh', 'rice', 'pasta']) {
    openMeal(document, current, key, lunchId);
    const control = document.querySelector('.swap-fields select');
    control.value = id; control.dispatch('change');
    document.querySelector('.dialog-actions button.primary').click();
    current = loadData(store).data;
    const meal = current.days[key].meals.find(item => item.id === lunchId);
    assert.ok(meal.ingredients.some(item => item.foodId === id));
    assert.equal(new Set(meal.ingredients.map(item => item.foodId)).size, meal.ingredients.length);
    const independentProtein = meal.ingredients.reduce((sum, item) => sum + item.grams * per100[item.foodId] / 100, 0);
    assert.ok(Math.abs(independentProtein - targetProtein) < 1e-6);
    assert.ok(Math.abs(meal.macros.protein - targetProtein) < 1e-6);
    sawBread ||= meal.ingredients.some(item => item.foodId === 'bread' && item.grams > 0);
  }
  assert.ok(sawBread, 'This fixture exercises bread in the protein balance');
});

test('a quota failure during refresh preserves stored data and displays an unsaved error', async t => {
  const { data } = refreshFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'foods');
  document.querySelector('.refresh-panel button').click();
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  document.querySelector('.dialog-actions button.primary').click();
  assert.equal(store.getItem(STORAGE_KEY), initialJSON);
  assert.equal(store.writes, 1);
  assert.equal(document.querySelector('#notifications').children[0].attributes.role, 'alert');
  assert.ok(document.querySelector('.notice.danger'));
});
