import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  for (const item of FOODS) {
    const complete = mealFromIngredients({ ...lunch, ingredients: [{ foodId: item.id, grams: 10 }] });
    first.meals = first.meals.map(meal => meal.id === lunch.id ? complete : meal);
    assert.deepEqual(parseBackup(exportBackup(data)), data);
    assertMacrosClose(complete.macros, foodMacros(item.id, 10));
  }
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
  get isDisabled() { return Boolean(this.disabled || (this.parentNode && this.parentNode.isDisabled)); }
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
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this._text = ''; this.children = []; this.append(...children);
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const node of nodes) if (node.parentNode) node.remove();
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    parent.children.splice(index, 1, ...nodes);
    for (const node of nodes) node.parentNode = parent;
    this.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  removeEventListener(name, listener) {
    this.events.set(name, (this.events.get(name) || []).filter(item => item !== listener));
  }
  addEventListener(name, listener) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(listener);
  }
  dispatch(name, extra = {}) {
    const event = { target: this, bubbles: true, cancelBubble: false, preventDefault() {},
      stopPropagation() { this.cancelBubble = true; }, ...extra };
    let current = this;
    do {
      event.currentTarget = current;
      for (const listener of current.events.get(name) || []) listener(event);
      current = event.bubbles && !event.cancelBubble ? current.parentNode : null;
    } while (current);
  }
  click() { if (!this.isDisabled) this.dispatch('click'); }
  focus() { globalThis.document.activeElement = this; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close', { bubbles: false }); }
  checkValidity() {
    if (this.isDisabled) return true;
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
async function bootApp(t, store, hash = 'today', health = {}) {
  const body = new MemoryElement('body');
  const head = new MemoryElement('head');
  for (const id of ['main', 'notifications', 'app-dialog']) {
    const element = new MemoryElement(id === 'app-dialog' ? 'dialog' : 'div');
    element.id = id; body.append(element);
  }
  const documentEvents = new MemoryElement('document');
  const document = {
    body, head, activeElement: body, visibilityState: 'visible',
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    dispatch: documentEvents.dispatch.bind(documentEvents),
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
      this.pairs = form.querySelectorAll('input, select, textarea').filter(control => !control.isDisabled && control.attributes.name
        && !(control.attributes.type === 'checkbox' && !control.checked))
        .map(control => [control.attributes.name, control.attributes.type === 'checkbox' ? control.value || 'on' : control.value]);
    }
    get(name) { return this.pairs.find(pair => pair[0] === name)?.[1] ?? null; }
    getAll(name) { return this.pairs.filter(pair => pair[0] === name).map(pair => pair[1]); }
  }
  const globals = { document, window, location, Node: MemoryElement, FormData: MemoryFormData, localStorage: store,
    requestAnimationFrame: callback => callback(), setTimeout: () => 0, clearTimeout: () => {},
    google: { accounts: { oauth2: health.oauth } },
    fetch: health.fetchImpl ?? (() => { throw new Error('Unexpected network request from integration test'); }) };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(async () => {
    window.dispatch('pagehide');
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  // Keep the production app and modules intact; substitute only the public
  // deployment client ID so tests never depend on the developer's live setup.
  const appURL = new URL('../app.js', import.meta.url);
  let source = await readFile(appURL, 'utf8');
  const configImport = /^import \{ GOOGLE_HEALTH_CLIENT_ID \} from ['"]\.\/src\/google-health-config\.js[^'"]*['"];$/m;
  assert.match(source, configImport);
  source = source.replace(configImport, `const GOOGLE_HEALTH_CLIENT_ID = ${JSON.stringify(health.clientId ?? '')};`)
    .replace(/from (['"])(\.\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, appURL).href}${quote}`);
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#integration-${appImport += 1}`);
  await new Promise(resolve => setImmediate(resolve));
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

const trainingModule = () => import('../src/training.js');

function alternatingProfile(changes = {}) {
  return { ...profile(), goal: 'lose', deficitKcal: 250, trainingDays: [0, 1, 2, 3, 4, 5, 6],
    trainingPlan: { mode: 'alternating', startDate: '2026-10-23', firstType: 'run' }, ...changes };
}

test('explicit deficits survive storage and subtract exactly 0, 250 or 500 kcal from TDEE', () => {
  for (const deficitKcal of [0, 250, 500]) {
    const subject = alternatingProfile({ deficitKcal });
    const targets = calculateTargets(subject);
    assert.equal(targets.bmr, 1755);
    assert.equal(targets.tdee, 2720.25);
    assert.equal(targets.kcal, 2720.25 - deficitKcal);
    assert.equal(targets.tdee - targets.kcal, deficitKcal);
    assert.equal(targets.protein, deficitKcal === 0 ? 128 : 144);
    const data = createEmptyData(); data.profile = subject;
    const store = new MemoryStorage(); saveData(data, store);
    const restored = loadData(store).data;
    assert.deepEqual(restored.profile, subject);
    assert.equal(calculateTargets(restored.profile).kcal, targets.kcal);
  }
});

test('legacy v1 profiles and snapshots round-trip without acquiring new defaults', () => {
  const data = generatedDiary('2026-10-23');
  data.profile.goal = 'lose';
  const previous = clone(data);
  const store = new MemoryStorage(); saveData(data, store);
  const restored = parseBackup(exportBackup(loadData(store).data));
  assert.equal(restored.schemaVersion, 1);
  assert.deepEqual(restored, previous);
  assert.equal(Object.hasOwn(restored.profile, 'deficitKcal'), false);
  assert.equal(Object.hasOwn(restored.profile, 'trainingPlan'), false);
  assert.equal(Object.hasOwn(restored.days['2026-10-23'].profileSnapshot, 'trainingPlan'), false);
  assert.equal(calculateTargets(restored.profile).kcal, 2448.225);
  assert.deepEqual(data, previous);
});

test('new profile fields coexist with unchanged legacy historical snapshots in a v1 backup', () => {
  const data = generatedDiary('2026-10-22');
  const historical = clone(data.days['2026-10-22']);
  data.profile = alternatingProfile();
  const targets = calculateTargets(data.profile);
  data.days['2026-10-23'] = { ...day('2026-10-23'), profileSnapshot: clone(data.profile), targets,
    meals: createDayPlan(data.profile, targets, '2026-10-23') };
  const store = new MemoryStorage(); saveData(data, store);
  const restored = parseBackup(exportBackup(loadData(store).data));
  assert.equal(restored.schemaVersion, 1);
  assert.deepEqual(restored, data);
  assert.deepEqual(restored.days['2026-10-22'], historical);
});

test('invalid explicit deficits are rejected rather than clipped or persisted', () => {
  const store = new MemoryStorage();
  const original = generatedDiary(); saveData(original, store);
  const before = store.getItem(STORAGE_KEY);
  for (const value of [-1, NaN, Infinity, -Infinity, '250', null, 2720.25, 3000]) {
    assert.throws(() => calculateTargets(alternatingProfile({ deficitKcal: value })), String(value));
    for (const target of ['profile', 'snapshot']) {
      const invalid = clone(original);
      const changed = target === 'profile' ? invalid.profile : invalid.days['2026-10-23'].profileSnapshot;
      changed.goal = 'lose'; changed.deficitKcal = value;
      assert.throws(() => saveData(invalid, store));
      assert.equal(store.getItem(STORAGE_KEY), before);
    }
  }
  assert.equal(store.writes, 1);
  const clinical = alternatingProfile({ specialCondition: true });
  assert.throws(() => calculateTargets(clinical));
  const underweight = alternatingProfile({ weight: 45, height: 180, deficitKcal: 250 });
  let protectedTargets;
  try {
    protectedTargets = calculateTargets(underweight);
  } catch (error) {
    assert.ok(error instanceof Error);
    return;
  }
  assert.equal(protectedTargets.kcal, protectedTargets.tdee);
  assert.ok(protectedTargets.warnings.some(warning => /deficit|sottopeso/i.test(warning)));
});

test('weekly and alternating plans round-trip and malformed nested fields cannot replace stored data', () => {
  const store = new MemoryStorage();
  const initial = generatedDiary(); saveData(initial, store);
  for (const plan of [
    { mode: 'alternating', startDate: '2026-10-23', firstType: 'run' },
    { mode: 'weekly', days: ['rest', 'strength', 'run', 'rest', 'strength', 'run', 'rest'] },
  ]) {
    const data = clone(initial); data.profile.trainingPlan = plan;
    data.profile.trainingDays = plan.mode === 'weekly' ? [1, 2, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
    saveData(data, store);
    assert.deepEqual(parseBackup(exportBackup(loadData(store).data)), data);
  }
  const before = store.getItem(STORAGE_KEY);
  const writes = store.writes;
  for (const plan of [
    null, {}, { mode: 'other' },
    { mode: 'alternating', startDate: '2026-02-30', firstType: 'run' },
    { mode: 'alternating', startDate: '1899-12-31', firstType: 'run' },
    { mode: 'alternating', startDate: '2101-01-01', firstType: 'run' },
    { mode: 'alternating', startDate: '2026-10-23', firstType: 'rest' },
    { mode: 'alternating', startDate: '2026-10-23', firstType: 'run', extra: true },
    { mode: 'weekly', days: ['rest', 'run'] },
    { mode: 'weekly', days: ['rest', 'run', 'strength', 'run', 'rest', 'run', 'cycling'] },
  ]) {
    for (const target of ['profile', 'snapshot']) {
      const data = clone(initial);
      (target === 'profile' ? data.profile : data.days['2026-10-23'].profileSnapshot).trainingPlan = plan;
      assert.throws(() => saveData(data, store), JSON.stringify(plan));
      assert.equal(store.getItem(STORAGE_KEY), before);
    }
  }
  assert.equal(store.writes, writes);
});

test('alternation crosses Sunday, month and year boundaries and works before its anchor', async () => {
  const { trainingForDate, validateTrainingPlan } = await trainingModule();
  assert.doesNotThrow(() => validateTrainingPlan(undefined));
  const subject = alternatingProfile();
  for (const [date, type] of [
    ['2026-10-20', 'strength'], ['2026-10-21', 'run'], ['2026-10-22', 'strength'],
    ['2026-10-23', 'run'], ['2026-10-24', 'strength'], ['2026-10-25', 'run'], ['2026-10-26', 'strength'],
    ['2026-10-31', 'run'], ['2026-11-01', 'strength'],
  ]) {
    const session = trainingForDate(subject, date);
    assert.equal(session.type, type, date);
    assert.equal(session.time, '06:00');
    assert.equal(typeof session.label, 'string');
    assert.ok(session.label.length > 0);
  }
  const december = alternatingProfile({ trainingPlan: { mode: 'alternating', startDate: '2026-12-30', firstType: 'strength' } });
  for (const [date, type] of [['2026-12-29', 'run'], ['2026-12-30', 'strength'], ['2026-12-31', 'run'], ['2027-01-01', 'strength']]) {
    assert.equal(trainingForDate(december, date).type, type, date);
  }
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '1899-12-31', '2101-01-01']) {
    assert.throws(() => trainingForDate(subject, date), date);
  }
});

test('weekly plans distinguish run and strength while legacy trainingDays remain strength sessions', async () => {
  const { trainingForDate } = await trainingModule();
  const legacy = profile();
  assert.equal(trainingForDate(legacy, '2026-10-23').type, 'strength');
  assert.equal(trainingForDate(legacy, '2026-10-25').type, 'rest');
  const weekly = { ...profile(), trainingDays: [1, 2, 4, 5], trainingPlan:
    { mode: 'weekly', days: ['rest', 'strength', 'run', 'rest', 'strength', 'run', 'rest'] } };
  for (const [date, type] of [['2026-10-25', 'rest'], ['2026-10-26', 'strength'], ['2026-10-27', 'run'], ['2026-10-28', 'rest']]) {
    assert.equal(trainingForDate(weekly, date).type, type, date);
  }
});

test('calendar alternation is stable across the Italian daylight-saving transitions', async () => {
  await trainingModule();
  const cases = [
    { startDate: '2026-03-28', dates: ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'] },
    { startDate: '2026-10-24', dates: ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'] },
  ];
  const url = new URL('../src/training.js', import.meta.url).href;
  const script = `import {trainingForDate} from ${JSON.stringify(url)};
const base=${JSON.stringify(profile())};
const cases=${JSON.stringify(cases)};
console.log(JSON.stringify(cases.map(row=>row.dates.map(date=>trainingForDate({...base,trainingPlan:{mode:'alternating',startDate:row.startDate,firstType:'run'}},date).type))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'Europe/Rome' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    ['run', 'strength', 'run', 'strength'], ['run', 'strength', 'run', 'strength'],
  ]);
});

test('run and strength use the same TDEE and food quantities without exercise calories added twice', () => {
  const running = alternatingProfile({ trainingPlan: { mode: 'alternating', startDate: '2026-10-23', firstType: 'run' } });
  const strength = alternatingProfile({ trainingPlan: { mode: 'alternating', startDate: '2026-10-23', firstType: 'strength' } });
  const runTargets = calculateTargets(running);
  const strengthTargets = calculateTargets(strength);
  assert.equal(runTargets.tdee, 2720.25);
  assert.deepEqual(runTargets, strengthTargets);
  const quantities = meal => ({ slot: meal.slot, ingredients: meal.ingredients, macros: meal.macros });
  assert.deepEqual(createDayPlan(running, runTargets, '2026-10-23').map(quantities),
    createDayPlan(strength, strengthTargets, '2026-10-23').map(quantities));
});

test('weekly rest removes only the preworkout schedule without changing the energy target', () => {
  const subject = alternatingProfile({ trainingDays: [1, 2], trainingPlan:
    { mode: 'weekly', days: ['rest', 'run', 'strength', 'rest', 'rest', 'rest', 'rest'] } });
  const targets = calculateTargets(subject);
  const slots = date => createDayPlan(subject, targets, date).map(item => item.slot);
  assert.deepEqual(slots('2026-10-25'), ['breakfast', 'lunch', 'dinner']);
  assert.deepEqual(slots('2026-10-26'), ['preworkout', 'breakfast', 'lunch', 'dinner']);
  assert.deepEqual(slots('2026-10-27'), ['preworkout', 'breakfast', 'lunch', 'dinner']);
  assert.equal(targets.tdee, 2720.25);
  assert.equal(targets.kcal, 2470.25);
});

function setProfileControl(form, name, value) {
  const control = form.querySelector(`[name="${name}"]`);
  assert.ok(control, `Missing profile control: ${name}`);
  control.value = String(value); control.dispatch('change');
  return control;
}

function displayedEstimateNumbers(document) {
  return document.querySelectorAll('.estimate-steps strong').map(element => {
    const digits = element.textContent.replace(/[^0-9]/g, '');
    return digits === '' ? null : Number(digits);
  });
}

test('onboarding offers daily alternation and shows live rest, TDEE and explicit deficit estimates', async t => {
  const store = new MemoryStorage();
  const { document } = await bootApp(t, store);
  const form = document.querySelector('.profile-form');
  assert.equal(form.querySelector('[name="trainingMode"]').value, 'alternating');
  assert.equal(form.querySelector('[name="trainingTime"]').value, '06:00');
  for (const [name, value] of Object.entries({ age: 35, sex: 'male', weight: 80, height: 180, activity: 'moderate', goal: 'lose' })) {
    setProfileControl(form, name, value);
  }
  assert.deepEqual(displayedEstimateNumbers(document), [1755, 2720, null], document.querySelector('.live-estimates').textContent);
  form.dispatch('submit');
  assert.equal(store.getItem(STORAGE_KEY), null, 'A missing deficit cannot silently become a default');
  for (const deficit of [500, 250, 0]) {
    setProfileControl(form, 'deficitKcal', deficit);
    assert.deepEqual(displayedEstimateNumbers(document), [1755, 2720, Math.round(2720.25 - deficit)]);
    assert.equal(store.writes, 0, 'Live previews must not write the profile');
  }
  form.dispatch('submit');
  const result = loadData(store).data;
  assert.equal(result.profile.deficitKcal, 0);
  assert.deepEqual(result.profile.trainingPlan, { mode: 'alternating', startDate: todayKey(), firstType: 'run' });
  assert.deepEqual(result.profile.trainingDays, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result.days[todayKey()].targets.kcal, 2720.25);
});

test('opening a legacy profile preserves its weekly schedule and exposes the converted deficit before saving', async t => {
  const key = todayKey();
  const data = generatedDiary(key);
  data.profile = { ...profile(), goal: 'lose' };
  const historical = clone(data.days[key]);
  const store = new MemoryStorage(); saveData(data, store);
  const before = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'profile');
  const form = document.querySelector('.profile-form');
  assert.equal(form.querySelector('[name="trainingMode"]').value, 'weekly');
  assert.equal(form.querySelector('[name="deficitKcal"]').valueAsNumber, 272);
  for (let day = 0; day < 7; day += 1) {
    assert.equal(form.querySelector(`[name="trainingDay-${day}"]`).value, [1, 3, 5].includes(day) ? 'strength' : 'rest');
  }
  assert.equal(store.getItem(STORAGE_KEY), before);
  form.dispatch('submit');
  const result = loadData(store).data;
  assert.equal(result.profile.deficitKcal, 272);
  assert.deepEqual(result.profile.trainingDays, [1, 3, 5]);
  assert.deepEqual(result.profile.trainingPlan, { mode: 'weekly', days: ['rest', 'strength', 'rest', 'strength', 'rest', 'strength', 'rest'] });
  assert.deepEqual(result.days[key], historical);
});

test('weekly profile controls save run and strength separately and label newly opened days', async t => {
  const key = todayKey();
  const data = generatedDiary(key);
  const store = new MemoryStorage(); saveData(data, store);
  const { document, navigate } = await bootApp(t, store, 'profile');
  const form = document.querySelector('.profile-form');
  setProfileControl(form, 'trainingMode', 'weekly');
  for (let day = 0; day < 7; day += 1) setProfileControl(form, `trainingDay-${day}`, day === 0 ? 'run' : day === 1 ? 'strength' : 'rest');
  form.dispatch('submit');
  const saved = loadData(store).data;
  assert.deepEqual(saved.profile.trainingDays, [0, 1]);
  assert.deepEqual(saved.profile.trainingPlan, { mode: 'weekly', days: ['run', 'strength', 'rest', 'rest', 'rest', 'rest', 'rest'] });
  navigate('today');
  const { trainingForDate } = await trainingModule();
  for (const date of ['2027-01-03', '2027-01-04']) {
    const picker = document.querySelector('input[type="date"]');
    picker.value = date; picker.dispatch('change');
    const session = trainingForDate(saved.profile, date);
    assert.equal(document.querySelector('.day-badge').textContent, `${session.label} · ${session.time}`);
    assert.equal(loadData(store).data.days[date].targets.tdee, saved.days[key].targets.tdee);
  }
});

test('invalid deficit entries in the profile form leave the saved profile unchanged', async t => {
  const data = generatedDiary(todayKey());
  const store = new MemoryStorage(); saveData(data, store);
  const initialJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'profile');
  const form = document.querySelector('.profile-form');
  setProfileControl(form, 'goal', 'lose');
  for (const deficit of ['', '-1', '2720.25', '3000']) {
    setProfileControl(form, 'deficitKcal', deficit);
    form.dispatch('submit');
    assert.equal(store.getItem(STORAGE_KEY), initialJSON, deficit);
  }
  assert.equal(store.writes, 1);
});

function profileApplicationFixture() {
  const key = todayKey();
  const pastKey = dateOffset(key, -1);
  const futureKey = dateOffset(key, 1);
  const data = generatedDiary(key);
  data.days[pastKey] = generatedDiary(pastKey).days[pastKey];
  data.days[futureKey] = generatedDiary(futureKey).days[futureKey];
  data.foodOverrides.vegetables = { kcal: 23, protein: 2, carbs: 3, fat: 0.2 };
  const today = data.days[key];
  const breakfast = today.meals.find(item => item.slot === 'breakfast');
  today.consumed[breakfast.id] = { consumedAt: new Date().toISOString(), meal: clone(breakfast) };
  today.skipped = [today.meals.find(item => item.slot === 'preworkout').id];
  const futureLunch = data.days[futureKey].meals.find(item => item.slot === 'lunch');
  futureLunch.ingredients[0].grams += 12;
  Object.assign(futureLunch, mealFromIngredients(futureLunch));
  return { data, key, pastKey, futureKey, newProfile: { ...data.profile, goal: 'lose', deficitKcal: 500,
    trainingPlan: { mode: 'alternating', startDate: key, firstType: 'strength' } } };
}

test('saving an explicit deficit leaves existing days intact until profile application is confirmed', async t => {
  const { data, key, pastKey, futureKey, newProfile } = profileApplicationFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document, navigate } = await bootApp(t, store, 'profile');
  const form = document.querySelector('.profile-form');
  for (const [name, value] of Object.entries({ goal: 'lose', deficitKcal: 500, trainingMode: 'alternating',
    trainingStart: key, trainingFirst: 'strength' })) setProfileControl(form, name, value);
  form.dispatch('submit');
  const savedOnly = loadData(store).data;
  assert.deepEqual(savedOnly.profile, newProfile);
  assert.deepEqual(savedOnly.days, data.days);
  assert.deepEqual(savedOnly.foodOverrides, data.foodOverrides);
  document.querySelector('.profile-change-notice button').click();
  assert.equal(document.querySelector('#app-dialog').open, true);
  assert.deepEqual(loadData(store).data, savedOnly);
  document.querySelector('.dialog-actions button.secondary').click();
  assert.deepEqual(loadData(store).data, savedOnly);
  document.querySelector('.profile-change-notice button').click();
  document.querySelector('.dialog-actions button.primary').click();
  const actual = loadData(store).data;
  assert.deepEqual(Object.keys(actual.days).sort(), Object.keys(data.days).sort());
  assert.deepEqual(actual.days[pastKey], data.days[pastKey]);
  assert.deepEqual(actual.days[key].consumed, data.days[key].consumed);
  assert.deepEqual(actual.foodOverrides, data.foodOverrides);
  const targets = calculateTargets(newProfile);
  for (const date of [key, futureKey]) {
    const before = data.days[date];
    const after = actual.days[date];
    assert.deepEqual(after.profileSnapshot, newProfile);
    assert.deepEqual(after.targets, targets);
    assert.equal(after.createdAt, before.createdAt);
    assert.notEqual(after.updatedAt, before.updatedAt);
    const expectedPlan = createDayPlan(newProfile, targets, date, data.foodOverrides);
    for (const item of after.meals) {
      if (before.consumed[item.id]) {
        assert.deepEqual(item, before.meals.find(old => old.id === item.id));
      } else {
        const expectedMeal = expectedPlan.find(generated => generated.slot === item.slot);
        assert.deepEqual(item.ingredients, expectedMeal.ingredients);
        assertMacrosClose(item.macros, sumMacros(item.ingredients.map(ingredient => foodMacros(ingredient.foodId, ingredient.grams, data.foodOverrides))));
      }
    }
  }
  assert.deepEqual(actual.days[key].skipped, data.days[key].skipped);
  assert.notDeepEqual(actual.days[futureKey].meals, data.days[futureKey].meals);
  navigate('profile');
  const afterJSON = store.getItem(STORAGE_KEY);
  document.querySelector('.target-preview button').click();
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.equal(store.getItem(STORAGE_KEY), afterJSON, 'Applying an identical profile must preserve the current plan');
});

test('applying a profile skips fully consumed days even when their profile snapshot differs', async t => {
  const key = todayKey();
  const data = generatedDiary(key);
  for (const item of data.days[key].meals) data.days[key].consumed[item.id] = {
    consumedAt: new Date().toISOString(), meal: clone(item),
  };
  data.profile = alternatingProfile({ trainingPlan: { mode: 'alternating', startDate: key, firstType: 'run' } });
  const store = new MemoryStorage(); saveData(data, store);
  const beforeJSON = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'profile');
  document.querySelector('.target-preview button').click();
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.equal(store.getItem(STORAGE_KEY), beforeJSON);
  assert.equal(store.writes, 1);
});

test('a profile application conflict cannot overwrite consumption recorded by another tab', async t => {
  const { data, key, newProfile } = profileApplicationFixture();
  data.profile = newProfile;
  const store = new MemoryStorage(); saveData(data, store);
  const { document, window } = await bootApp(t, store, 'profile');
  document.querySelector('.target-preview button').click();
  const external = loadData(store).data;
  const dinner = external.days[key].meals.find(item => item.slot === 'dinner');
  external.days[key].consumed[dinner.id] = { consumedAt: new Date().toISOString(), meal: clone(dinner) };
  saveData(external, store);
  const externalJSON = store.getItem(STORAGE_KEY);
  window.dispatch('storage', { key: STORAGE_KEY });
  document.querySelector('.dialog-actions button.primary').click();
  assert.equal(store.getItem(STORAGE_KEY), externalJSON);
  assert.equal(store.writes, 2);
});

test('switching an existing day to rest preserves an already consumed preworkout', async t => {
  const key = todayKey();
  const data = generatedDiary(key);
  const snack = data.days[key].meals.find(item => item.slot === 'preworkout');
  data.days[key].consumed[snack.id] = { consumedAt: new Date().toISOString(), meal: clone(snack) };
  const consumed = clone(data.days[key].consumed);
  data.profile = alternatingProfile({ trainingDays: [], trainingPlan: { mode: 'weekly', days: Array(7).fill('rest') } });
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store, 'profile');
  document.querySelector('.target-preview button').click();
  document.querySelector('.dialog-actions button.primary').click();
  const after = loadData(store).data.days[key];
  assert.deepEqual(after.consumed, consumed);
  assert.deepEqual(after.meals.find(item => item.id === snack.id), snack);
  assert.deepEqual(after.profileSnapshot.trainingPlan.days, Array(7).fill('rest'));
});

const recordedTraining = type => ({ type, source: 'manual', recordedAt: '2026-10-22T08:00:00.000Z' });

function activityLogFixture() {
  const key = todayKey();
  const pastKey = dateOffset(key, -1);
  const futureKey = dateOffset(key, 1);
  const data = generatedDiary(key);
  data.days[pastKey] = generatedDiary(pastKey).days[pastKey];
  data.days[futureKey] = generatedDiary(futureKey).days[futureKey];
  data.days[pastKey].trainingLog = recordedTraining('run');
  const current = data.days[key];
  const breakfast = current.meals.find(item => item.slot === 'breakfast');
  current.consumed[breakfast.id] = { consumedAt: '2026-10-22T08:00:00.000Z', meal: clone(breakfast) };
  current.skipped = [current.meals.find(item => item.slot === 'preworkout').id];
  data.foodOverrides.vegetables = { kcal: 23, protein: 2, carbs: 3, fat: 0.2 };
  return { data, key, pastKey, futureKey };
}

function chooseDiaryDate(document, key) {
  const picker = document.querySelector('input[type="date"]');
  picker.value = key; picker.dispatch('change');
}

function assertOnlyActivityChanged(before, after, key, type, source = 'manual') {
  const expected = clone(before);
  expected.days[key].updatedAt = after.days[key].updatedAt;
  if (type === undefined) {
    delete expected.days[key].trainingLog;
    assert.equal(Object.hasOwn(after.days[key], 'trainingLog'), false);
  } else {
    assert.deepEqual(Object.keys(after.days[key].trainingLog).sort(), ['recordedAt', 'source', 'type']);
    assert.equal(after.days[key].trainingLog.type, type);
    assert.equal(after.days[key].trainingLog.source, source);
    assert.ok(Number.isFinite(Date.parse(after.days[key].trainingLog.recordedAt)));
    expected.days[key].trainingLog = after.days[key].trainingLog;
  }
  assert.ok(Number.isFinite(Date.parse(after.days[key].updatedAt)));
  assert.deepEqual(after, expected, 'Only trainingLog and updatedAt on the selected date may change');
}

test('legacy diaries retain an unregistered activity instead of silently acquiring rest', async t => {
  const data = generatedDiary(todayKey());
  const store = new MemoryStorage(); saveData(data, store);
  const before = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Non ancora registrato');
  assert.equal(document.querySelectorAll('.training-log-choice').length, 4);
  assert.ok(document.querySelectorAll('.training-log-choice').every(button => button.attributes['aria-pressed'] === 'false'));
  assert.equal(document.querySelector('.training-log-footer .text-button'), null);
  assert.equal(store.getItem(STORAGE_KEY), before);
  assert.deepEqual(parseBackup(exportBackup(data)), data);
});

for (const [type, label] of [['strength', 'Palestra'], ['run', 'Corsa'], ['both', 'Palestra + corsa'], ['rest', 'Riposo']]) {
  test(`recording ${type} changes only the selected day's activity and preserves nutrition and other dates`, async t => {
    const { data, key } = activityLogFixture();
    const store = new MemoryStorage(); saveData(data, store);
    const { document } = await bootApp(t, store);
    const planned = document.querySelector('.planned-training').textContent;
    const badge = document.querySelector('.day-badge').textContent;
    const energy = document.querySelector('[role="meter"]').attributes['aria-valuenow'];
    document.querySelector(`[data-training-type="${type}"]`).click();
    const after = loadData(store).data;
    assertOnlyActivityChanged(data, after, key, type);
    assert.notEqual(after.days[key].updatedAt, data.days[key].updatedAt);
    assert.equal(store.writes, 2);
    assert.equal(document.querySelector('.training-log-status').textContent, `Registrato: ${label}`);
    for (const button of document.querySelectorAll('.training-log-choice')) {
      assert.equal(button.attributes['aria-pressed'], String(button.attributes['data-training-type'] === type));
    }
    assert.equal(document.querySelector('.planned-training').textContent, planned);
    assert.equal(document.querySelector('.day-badge').textContent, badge);
    assert.equal(document.querySelector('[role="meter"]').attributes['aria-valuenow'], energy);
    assert.equal(document.activeElement.id, 'training-log-title');
    assert.deepEqual(parseBackup(exportBackup(after)), after);
  });
}

test('changing, repeating and undoing an activity preserve the plan and never rewrite a no-op', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('[data-training-type="run"]').click();
  const firstJSON = store.getItem(STORAGE_KEY);
  document.querySelector('[data-training-type="run"]').click();
  assert.equal(store.getItem(STORAGE_KEY), firstJSON);
  assert.equal(store.writes, 2);
  document.querySelector('[data-training-type="both"]').click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'both');
  assert.equal(store.writes, 3);
  document.querySelector('.training-log-footer .text-button').click();
  assertOnlyActivityChanged(data, loadData(store).data, key, undefined);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Non ancora registrato');
  assert.ok(document.querySelectorAll('.training-log-choice').every(button => button.attributes['aria-pressed'] === 'false'));
  assert.equal(document.querySelector('.training-log-footer .text-button'), null);
  assert.equal(store.writes, 4);
});

test('saved activity reopens on its own date and changes on a past date stay isolated', async t => {
  const { data, key, pastKey } = activityLogFixture();
  data.days[key].trainingLog = recordedTraining('both');
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Palestra + corsa');
  assert.equal(store.writes, 1);
  chooseDiaryDate(document, pastKey);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Corsa');
  document.querySelector('[data-training-type="strength"]').click();
  const changed = loadData(store).data;
  assertOnlyActivityChanged(data, changed, pastKey, 'strength');
  chooseDiaryDate(document, key);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Palestra + corsa');
  chooseDiaryDate(document, pastKey);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Palestra');
  assert.deepEqual(loadData(store).data, changed);
});

test('future activity controls are disabled and their event handlers reject forced clicks', async t => {
  const { data, key, futureKey } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  chooseDiaryDate(document, futureKey);
  const before = store.getItem(STORAGE_KEY);
  for (const button of document.querySelectorAll('.training-log-choice')) {
    assert.equal(button.disabled, true);
    button.click();
    button.dispatch('click');
    assert.equal(store.getItem(STORAGE_KEY), before);
  }
  assert.equal(document.querySelector('.training-log-status').textContent, 'Non ancora registrato');
  assert.match(document.querySelector('#notifications').textContent, /oggi.*passato/);
  chooseDiaryDate(document, key);
  assert.ok(document.querySelectorAll('.training-log-choice').every(button => !button.disabled));
  assert.deepEqual(loadData(store).data, data);
});

test('opening a new future date generates a plan but never an actual activity', async t => {
  const key = todayKey();
  const data = generatedDiary(key);
  data.days[key].trainingLog = recordedTraining('rest');
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  const futureKey = dateOffset(key, 2);
  chooseDiaryDate(document, futureKey);
  const after = loadData(store).data;
  assert.deepEqual(after.days[key], data.days[key]);
  assert.equal(Object.hasOwn(after.days[futureKey], 'trainingLog'), false);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Non ancora registrato');
  assert.ok(document.querySelectorAll('.training-log-choice').every(button => button.disabled));
});

test('invalid activity logs fail validation and backup parsing before replacing saved data', () => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const before = store.getItem(STORAGE_KEY);
  const valid = recordedTraining('run');
  const invalid = [null, [], {}, 'run',
    { ...valid, type: 'cycling' }, { ...valid, type: 'Run' }, { ...valid, source: 'strava' },
    { ...valid, recordedAt: '2026-02-30T08:00:00Z' }, { ...valid, recordedAt: '2026-10-22T08:00:00' },
    { ...valid, recordedAt: '2026-10-22T25:00:00Z' }, { ...valid, recordedAt: 1792656000000 },
    { ...valid, extra: true }, { type: 'run', source: 'manual' },
    { type: 'run', recordedAt: valid.recordedAt }, { source: 'manual', recordedAt: valid.recordedAt },
  ];
  for (const log of invalid) {
    const replacement = clone(data); replacement.days[key].trainingLog = log;
    assert.throws(() => validateData(replacement), JSON.stringify(log));
    assert.throws(() => saveData(replacement, store), JSON.stringify(log));
    assert.throws(() => parseBackup(JSON.stringify(replacement)), JSON.stringify(log));
    assert.equal(store.getItem(STORAGE_KEY), before);
  }
  assert.equal(store.writes, 1);
});

test('invalid activity backup imports show an error without opening confirmation or replacing the diary', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const before = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store, 'profile');
  for (const log of [null, { ...recordedTraining('both'), source: 'hevy' }, { ...recordedTraining('run'), recordedAt: '2026-02-30T00:00:00Z' }]) {
    const invalid = clone(data); invalid.days[key].trainingLog = log;
    const json = JSON.stringify(invalid);
    const input = document.querySelector('#backup-file');
    input.files = [{ size: Buffer.byteLength(json), text: async () => json }]; input.dispatch('change');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.querySelector('#app-dialog').open, false);
    assert.equal(document.querySelector('#notifications').children[0].attributes.role, 'alert');
    assert.equal(store.getItem(STORAGE_KEY), before);
  }
  assert.equal(store.writes, 1);
});

test('activity backup import remains cancellable and restores all recorded dates only after confirmation', async t => {
  const { data, key, pastKey } = activityLogFixture();
  const replacement = clone(data);
  replacement.days[key].trainingLog = recordedTraining('strength');
  replacement.days[pastKey].trainingLog = recordedTraining('rest');
  const store = new MemoryStorage(); saveData(data, store);
  const { document, navigate } = await bootApp(t, store, 'profile');
  const json = exportBackup(replacement);
  const openImport = async () => {
    const input = document.querySelector('#backup-file');
    input.files = [{ size: Buffer.byteLength(json), text: async () => json }]; input.dispatch('change');
    await new Promise(resolve => setImmediate(resolve));
  };
  await openImport();
  assert.equal(document.querySelector('#app-dialog').open, true);
  assert.deepEqual(loadData(store).data, data);
  document.querySelector('.dialog-actions button.secondary').click();
  assert.deepEqual(loadData(store).data, data);
  await openImport();
  document.querySelector('.dialog-actions button.primary').click();
  assert.deepEqual(loadData(store).data, replacement);
  navigate('today');
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Palestra');
  chooseDiaryDate(document, pastKey);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Riposo');
  assert.equal(store.writes, 2);
});

test('a failed activity save is visibly unsaved and can be retried without changing nutrition', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const before = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store);
  const setItem = store.setItem.bind(store);
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  document.querySelector('[data-training-type="run"]').click();
  assert.equal(store.getItem(STORAGE_KEY), before);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Corsa');
  assert.match(document.querySelector('.notice.danger').textContent, /non salvate/);
  assert.equal(document.querySelector('#notifications').children[0].attributes.role, 'alert');
  assert.doesNotMatch(document.querySelector('#notifications').textContent, /Attività registrata/);
  store.setItem = setItem;
  const retry = document.querySelectorAll('.notice.danger button').find(button => button.textContent === 'Riprova salvataggio');
  retry.click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'run');
  assert.equal(document.querySelector('.notice.danger'), null);
  assert.equal(store.writes, 2);
});

test('a clean cross-tab update refreshes the activity and a later change preserves external consumption', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document, window } = await bootApp(t, store);
  const external = clone(data);
  external.days[key].trainingLog = recordedTraining('run');
  const dinner = external.days[key].meals.find(item => item.slot === 'dinner');
  external.days[key].consumed[dinner.id] = { consumedAt: '2026-10-22T20:00:00Z', meal: clone(dinner) };
  saveData(external, store);
  window.dispatch('storage', { key: STORAGE_KEY });
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Corsa');
  assert.deepEqual(loadData(store).data, external);
  document.querySelector('[data-training-type="both"]').click();
  assertOnlyActivityChanged(external, loadData(store).data, key, 'both');
  assert.equal(store.writes, 3);
});

test('an activity change during a cross-tab conflict cannot overwrite newer training or meal data', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document, window } = await bootApp(t, store);
  const lunchIndex = data.days[key].meals.findIndex(item => item.slot === 'lunch');
  document.querySelectorAll('.meal-card')[lunchIndex].querySelector('.meal-actions button').click();
  assert.equal(document.querySelector('#app-dialog').open, true);
  const external = clone(data);
  external.days[key].trainingLog = recordedTraining('strength');
  const dinner = external.days[key].meals.find(item => item.slot === 'dinner');
  external.days[key].consumed[dinner.id] = { consumedAt: '2026-10-22T20:00:00Z', meal: clone(dinner) };
  saveData(external, store);
  const externalJSON = store.getItem(STORAGE_KEY);
  window.dispatch('storage', { key: STORAGE_KEY });
  document.querySelector('[data-training-type="run"]').click();
  assert.equal(store.getItem(STORAGE_KEY), externalJSON);
  assert.equal(store.writes, 2);
  assert.match(document.querySelector('#notifications').textContent, /altra scheda/);
});

test('applying a new planned profile retains today and historical actual activity', async t => {
  const { data, key, pastKey } = activityLogFixture();
  data.days[key].trainingLog = recordedTraining('both');
  data.profile = alternatingProfile({ trainingPlan: { mode: 'alternating', startDate: key, firstType: 'run' } });
  const store = new MemoryStorage(); saveData(data, store);
  const { document, navigate } = await bootApp(t, store, 'profile');
  document.querySelector('.target-preview button').click();
  document.querySelector('.dialog-actions button.primary').click();
  const after = loadData(store).data;
  assert.deepEqual(after.days[key].trainingLog, data.days[key].trainingLog);
  assert.deepEqual(after.days[pastKey], data.days[pastKey]);
  assert.notDeepEqual(after.days[key].profileSnapshot, data.days[key].profileSnapshot);
  navigate('today');
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Palestra + corsa');
  assert.equal(document.querySelector('.planned-training').textContent, 'Previsto: Corsa alle 06:00');
  assert.equal(document.querySelector('.day-badge').textContent, 'Corsa · 06:00');
});

const csvRows = rows => rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
const csvSubmit = document => document.querySelector('.csv-import-panel .dialog-actions button.primary');

async function loadActivityFile(document, text, properties = {}) {
  const input = document.querySelector('[name="activityCsv"]');
  input.files = [{ name: 'activities.csv', size: Buffer.byteLength(text), text: async () => text, ...properties }];
  input.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
}

function selectCsvValue(document, name, value) {
  const select = document.querySelector(`[name="${name}"]`);
  assert.ok(select, name);
  select.value = value; select.dispatch('change');
}

test('CSV import requires a time basis and confirmation, deduplicates IDs and persists only the selected date summary', async t => {
  const { data, key, pastKey } = activityLogFixture();
  const absentKey = dateOffset(key, -3);
  const text = csvRows([
    ['Activity ID', 'Activity Date', 'Activity Type', 'Activity Name'],
    ['9007199254740993', `${key}T06:00:00`, 'Run', 'PRIVATE RUN NAME'],
    ['9007199254740993', `${key}T06:00:00`, 'Run', 'PRIVATE RUN NAME'],
    ['9007199254740994', `${key}T18:00:00`, 'WeightTraining', 'PRIVATE HEVY NAME'],
    ['3', `${pastKey}T06:00:00`, 'Run', 'old session'],
    ['4', `${absentKey}T06:00:00`, 'Run', 'unvisited session'],
  ]);
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  assert.match(document.querySelector('.csv-sync-info').textContent, /Sincronizzazione automatica non attiva/);
  await loadActivityFile(document, text);
  assert.equal(document.querySelector('[name="csvTimeBasis"]').value, '');
  assert.equal(csvSubmit(document).disabled, true);
  assert.deepEqual(loadData(store).data, data);
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.equal(csvSubmit(document).disabled, false);
  assert.match(csvSubmit(document).textContent, /Registra Palestra \+ corsa/);
  assert.deepEqual(document.querySelectorAll('.csv-counts dd').map(node => node.textContent), ['2', '1', '0', '0']);
  assert.deepEqual(loadData(store).data, data);
  csvSubmit(document).click();
  const after = loadData(store).data;
  assertOnlyActivityChanged(data, after, key, 'both', 'strava_csv');
  assert.equal(Object.hasOwn(after.days, absentKey), false);
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.equal(document.querySelector('.training-log-status').textContent, 'Registrato: Palestra + corsa · CSV Strava');
  const backup = exportBackup(after);
  assert.doesNotMatch(backup, /PRIVATE|900719925474099|Activity Name/);
  assert.deepEqual(parseBackup(backup), after);
  assert.equal(store.writes, 2);
});

test('CSV summaries replace an existing manual log only through the explicitly labelled confirmation', async t => {
  const { data, key } = activityLogFixture();
  data.days[key].trainingLog = recordedTraining('rest');
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [key, 'TrailRun']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.match(csvSubmit(document).textContent, /Sostituisci Riposo con Corsa/);
  assert.match(document.querySelector('.csv-preview').textContent, /sostituirà la registrazione esistente: Riposo/);
  assert.deepEqual(loadData(store).data, data);
  csvSubmit(document).click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'run', 'strava_csv');
});

test('unknown activity types and invalid dates block a partial CSV proposal until a human chooses the day result', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([
    ['Activity Date', 'Activity Type'], [key, 'Run'], [key, 'Workout'], ['2026-02-30', 'WeightTraining'],
  ]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.deepEqual(document.querySelectorAll('.csv-counts dd').map(node => node.textContent), ['2', '0', '1', '1']);
  assert.equal(document.querySelector('[name="csvExplicitType"]').value, '');
  assert.equal(csvSubmit(document).disabled, true);
  csvSubmit(document).dispatch('click');
  assert.deepEqual(loadData(store).data, data);
  selectCsvValue(document, 'csvExplicitType', 'both');
  assert.equal(csvSubmit(document).disabled, false);
  csvSubmit(document).click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'both', 'strava_csv');
});

test('a CSV without activities on the chosen day never assumes rest', async t => {
  const { data, key, pastKey } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [pastKey, 'Run']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.equal(csvSubmit(document).disabled, true);
  assert.match(document.querySelector('.csv-preview').textContent, /non dimostra un giorno di riposo/);
  assert.equal(document.querySelector('[name="csvExplicitType"]').value, '');
  assert.deepEqual(loadData(store).data, data);
  selectCsvValue(document, 'csvExplicitType', 'rest');
  csvSubmit(document).click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'rest', 'strava_csv');
});

test('unrecognized CSV headers require explicit mapping and reject overlapping date, type and ID columns', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['When?', 'What?', 'Reference'], [key, 'Corsa', 'same'], [key, 'Corsa', 'same']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.equal(document.querySelector('[name="csvDateColumn"]').value, '-1');
  assert.equal(csvSubmit(document).disabled, true);
  selectCsvValue(document, 'csvDateColumn', '0');
  selectCsvValue(document, 'csvTypeColumn', '0');
  assert.equal(csvSubmit(document).disabled, true);
  assert.match(document.querySelector('.csv-import-panel .form-error').textContent, /distinte/);
  selectCsvValue(document, 'csvTypeColumn', '1');
  selectCsvValue(document, 'csvIdColumn', '0');
  assert.equal(csvSubmit(document).disabled, true);
  selectCsvValue(document, 'csvIdColumn', '2');
  assert.equal(csvSubmit(document).disabled, false);
  assert.deepEqual(document.querySelectorAll('.csv-counts dd').map(node => node.textContent), ['1', '1', '0', '0']);
  selectCsvValue(document, 'csvIdColumn', '-1');
  assert.deepEqual(document.querySelectorAll('.csv-counts dd').map(node => node.textContent), ['2', '0', '0', '0']);
  csvSubmit(document).click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'run', 'strava_csv');
});

test('the CSV time-basis selector changes the matched day at the UTC-to-Italy midnight boundary', async t => {
  const { data, key, pastKey } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [`${pastKey}T23:30:00`, 'Run']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.equal(csvSubmit(document).disabled, true);
  assert.equal(document.querySelectorAll('.csv-counts dd')[0].textContent, '0');
  selectCsvValue(document, 'csvTimeBasis', 'utc');
  assert.equal(csvSubmit(document).disabled, false);
  assert.equal(document.querySelectorAll('.csv-counts dd')[0].textContent, '1');
  csvSubmit(document).click();
  assertOnlyActivityChanged(data, loadData(store).data, key, 'run', 'strava_csv');
});

test('changing CSV mapping or time basis clears a previous manual answer to an ambiguous preview', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type', 'ID'], [key, 'Workout', '1']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  selectCsvValue(document, 'csvExplicitType', 'strength');
  assert.equal(csvSubmit(document).disabled, false);
  selectCsvValue(document, 'csvTimeBasis', 'utc');
  assert.equal(document.querySelector('[name="csvExplicitType"]').value, '');
  assert.equal(csvSubmit(document).disabled, true);
  selectCsvValue(document, 'csvExplicitType', 'strength');
  selectCsvValue(document, 'csvIdColumn', '-1');
  assert.equal(document.querySelector('[name="csvExplicitType"]').value, '');
  assert.equal(csvSubmit(document).disabled, true);
  assert.deepEqual(loadData(store).data, data);
});

test('replacing a valid CSV with malformed, oversized or non-CSV files cannot submit the old preview', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  const valid = csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]);
  let blockedReads = 0;
  for (const [text, properties] of [
    ['Activity Date,Activity Type\n"unterminated,Run', {}],
    [valid, { name: 'archive.zip', text: async () => { blockedReads++; return valid; } }],
    [valid, { size: 5 * 1024 * 1024 + 1, text: async () => { blockedReads++; return valid; } }],
  ]) {
    await loadActivityFile(document, valid);
    selectCsvValue(document, 'csvTimeBasis', 'local');
    assert.equal(csvSubmit(document).disabled, false);
    await loadActivityFile(document, text, properties);
    assert.equal(csvSubmit(document).disabled, true);
    assert.notEqual(document.querySelector('.csv-import-panel .form-error').textContent, '');
    csvSubmit(document).dispatch('click');
    assert.deepEqual(loadData(store).data, data);
  }
  assert.equal(blockedReads, 0);
  assert.equal(store.writes, 1);
});

test('cancelling a CSV replacement preserves the existing manual activity and discards the preview', async t => {
  const { data, key } = activityLogFixture();
  data.days[key].trainingLog = recordedTraining('both');
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.match(csvSubmit(document).textContent, /Sostituisci Palestra \+ corsa con Corsa/);
  document.querySelector('.csv-import-panel .dialog-actions button').click();
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.deepEqual(loadData(store).data, data);
  document.querySelector('.training-log-import button').click();
  assert.equal(csvSubmit(document).disabled, true);
  assert.equal(document.querySelector('.csv-preview').textContent, '');
  assert.equal(store.writes, 1);
});

test('a selected-date change after a CSV preview cannot apply it to either day', async t => {
  const { data, key, pastKey } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  chooseDiaryDate(document, pastKey);
  csvSubmit(document).click();
  assert.match(document.querySelector('.csv-import-panel .form-error').textContent, /data selezionata è cambiata/);
  assert.deepEqual(loadData(store).data, data);
  assert.equal(store.writes, 1);
});

test('a cross-tab write after a CSV preview preserves the external activity and meal consumption', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document, window } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  const external = clone(data);
  external.days[key].trainingLog = recordedTraining('strength');
  const dinner = external.days[key].meals.find(item => item.slot === 'dinner');
  external.days[key].consumed[dinner.id] = { consumedAt: '2026-10-23T20:00:00Z', meal: clone(dinner) };
  saveData(external, store);
  const before = store.getItem(STORAGE_KEY);
  window.dispatch('storage', { key: STORAGE_KEY });
  csvSubmit(document).click();
  assert.match(document.querySelector('.csv-import-panel .form-error').textContent, /dati locali sono cambiati/);
  assert.equal(store.getItem(STORAGE_KEY), before);
  assert.equal(store.writes, 2);
});

test('a slower previous CSV read cannot replace a newer selection or revive a cancelled import', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  let resolveSlow;
  const input = document.querySelector('[name="activityCsv"]');
  input.files = [{ name: 'slow.csv', size: 100, text: () => new Promise(resolve => { resolveSlow = resolve; }) }];
  input.dispatch('change');
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [key, 'WeightTraining']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  assert.match(csvSubmit(document).textContent, /Registra Palestra/);
  resolveSlow(csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(csvSubmit(document).textContent, /Registra Palestra/);
  document.querySelector('.csv-import-panel .dialog-actions button').click();
  assert.deepEqual(loadData(store).data, data);
  document.querySelector('.training-log-import button').click();
  const pending = document.querySelector('[name="activityCsv"]');
  pending.files = [{ name: 'cancelled.csv', size: 100, text: () => new Promise(resolve => { resolveSlow = resolve; }) }];
  pending.dispatch('change');
  document.querySelector('.csv-import-panel .dialog-actions button').click();
  resolveSlow(csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.deepEqual(loadData(store).data, data);
  assert.equal(store.writes, 1);
});

test('CSV import is disabled on future dates and forced events cannot open its dialog', async t => {
  const { data, futureKey } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document } = await bootApp(t, store);
  chooseDiaryDate(document, futureKey);
  const button = document.querySelector('.training-log-import button');
  assert.equal(button.disabled, true);
  button.click(); button.dispatch('click');
  assert.equal(document.querySelector('#app-dialog').open, false);
  assert.deepEqual(loadData(store).data, data);
});

test('a CSV save failure keeps the previous persisted diary and exposes an unsaved recoverable result', async t => {
  const { data, key } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const before = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store);
  document.querySelector('.training-log-import button').click();
  await loadActivityFile(document, csvRows([['Activity Date', 'Activity Type'], [key, 'Run']]));
  selectCsvValue(document, 'csvTimeBasis', 'local');
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  csvSubmit(document).click();
  assert.equal(store.getItem(STORAGE_KEY), before);
  assert.match(document.querySelector('.notice.danger').textContent, /non salvate/);
  assert.equal(document.querySelector('#notifications').children[0].attributes.role, 'alert');
  assert.doesNotMatch(document.querySelector('#notifications').textContent, /Registrato da CSV/);
  assert.equal(store.writes, 1);
});

const HEALTH_TEST_TOKEN = 'synthetic-health-ui-token';
const HEALTH_TEST_SCOPE = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
const healthReply = (body, status = 200) => ({ status, url: '', redirected: false, text: async () => JSON.stringify(body) });

function standardHealthReply(url, init, total = 321, active = 0) {
  if (url.endsWith('/identity')) return healthReply({ healthUserId: 'private-ui-test-health-id' });
  const { range } = JSON.parse(init.body);
  const field = url.includes('/total-calories/') ? 'totalCalories' : 'activeEnergyBurned';
  return healthReply({ rollupDataPoints: [{ startTime: range.startTime,
    endTime: new Date(Date.parse(range.startTime) + 60000).toISOString(),
    [field]: { kcalSum: field === 'totalCalories' ? total : active } }] });
}

async function bootHealthApp(t, data, handler = standardHealthReply) {
  const store = new MemoryStorage(); saveData(data, store);
  const configs = [];
  const requests = [];
  const calls = [];
  const app = await bootApp(t, store, 'today', {
    clientId: 'public-ui-test.apps.googleusercontent.com',
    oauth: { initTokenClient(config) {
      configs.push(config);
      return { requestAccessToken(request) { requests.push(request); } };
    } },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
  });
  const script = app.document.head.querySelector('script');
  assert.ok(script);
  assert.equal(script.src, 'https://accounts.google.com/gsi/client');
  script.dispatch('load');
  await new Promise(resolve => setImmediate(resolve));
  const authorize = async () => {
    app.document.querySelector('.health-actions button.primary').click();
    assert.ok(configs.length);
    await configs.at(-1).callback({ access_token: HEALTH_TEST_TOKEN, expires_in: 3600, scope: HEALTH_TEST_SCOPE });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { ...app, store, configs, requests, calls, authorize };
}

test('an unconfigured Google Health panel has no fake values, consent or network activity', async t => {
  const { data } = activityLogFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const original = store.getItem(STORAGE_KEY);
  const { document } = await bootApp(t, store);
  assert.match(document.querySelector('.google-health-panel').textContent, /In configurazione/);
  assert.equal(document.querySelector('.health-metrics'), null);
  assert.equal(document.querySelector('.health-actions button'), null);
  assert.equal(document.head.querySelector('script'), null);
  assert.equal(store.getItem(STORAGE_KEY), original);
});

test('Google Health consent, partial calorie display and disconnection leave the entire diary and backup unchanged', async t => {
  const { data } = activityLogFixture();
  const { document, store, configs, requests, calls, authorize } = await bootHealthApp(t, data, (url, init) =>
    url.includes('/active-energy-burned/') ? healthReply({}) : standardHealthReply(url, init, 0));
  const original = store.getItem(STORAGE_KEY);
  const backup = exportBackup(data);
  const meter = document.querySelector('[role="meter"]').attributes['aria-valuenow'];
  assert.equal(calls.length, 0);
  assert.equal(configs.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(document.querySelector('.health-status').textContent, 'Non collegato');
  assert.equal(document.querySelector('.health-metrics'), null);
  await authorize();
  assert.equal(configs[0].scope, HEALTH_TEST_SCOPE);
  assert.equal(configs[0].include_granted_scopes, false);
  assert.deepEqual(requests, [{ prompt: 'select_account' }]);
  assert.equal(calls.length, 3);
  assert.equal(document.querySelector('.health-status').textContent, 'Sessione collegata');
  assert.deepEqual(document.querySelectorAll('.health-metrics strong').map(node => node.textContent), ['0 kcal', 'Non disponibile']);
  assert.match(document.querySelector('.health-metrics').textContent, /Copertura parziale/);
  assert.match(document.querySelector('.health-timestamps').textContent, /Ultima lettura/);
  assert.match(document.querySelector('.google-health-panel').textContent, /Fonti aggregate/);
  assert.doesNotMatch(document.body.textContent, /synthetic-health-ui-token|private-ui-test-health-id/);
  assert.equal(document.querySelector('[role="meter"]').attributes['aria-valuenow'], meter);
  assert.equal(store.getItem(STORAGE_KEY), original);
  assert.equal(exportBackup(loadData(store).data), backup);
  document.querySelectorAll('.health-actions button').find(button => button.textContent === 'Scollega questa sessione').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('.health-status').textContent, 'Non collegato');
  assert.equal(document.querySelector('.health-metrics'), null);
  assert.equal(store.getItem(STORAGE_KEY), original);
  assert.equal(store.writes, 1);
});

test('a Google Health API revocation removes displayed calories and offers explicit reconnection', async t => {
  const { data } = activityLogFixture();
  let revoked = false;
  const { document, store, calls, authorize } = await bootHealthApp(t, data, (url, init) => revoked
    ? healthReply({ error: { message: HEALTH_TEST_TOKEN } }, 401) : standardHealthReply(url, init));
  await authorize();
  const original = store.getItem(STORAGE_KEY);
  revoked = true;
  document.querySelector('.health-actions button.primary').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('.health-status').textContent, 'Sessione scaduta');
  assert.equal(document.querySelector('.health-metrics'), null);
  assert.equal(document.querySelector('.health-actions button.primary').textContent, 'Ricollega Google Health');
  assert.match(document.querySelector('.health-error').textContent, /scaduta/);
  assert.doesNotMatch(document.body.textContent, /synthetic-health-ui-token/);
  assert.equal(calls.length, 4);
  assert.equal(store.getItem(STORAGE_KEY), original);
  assert.equal(store.writes, 1);
});

test('an unavailable second Health metric never becomes a fake zero or a usable first total', async t => {
  const { data } = activityLogFixture();
  const { document, store, authorize } = await bootHealthApp(t, data, (url, init) => url.includes('/active-energy-burned/')
    ? healthReply({ error: { message: HEALTH_TEST_TOKEN } }, 503) : standardHealthReply(url, init));
  const original = store.getItem(STORAGE_KEY);
  await authorize();
  assert.equal(document.querySelector('.health-metrics'), null);
  assert.match(document.querySelector('.health-error').textContent, /non è raggiungibile/);
  assert.doesNotMatch(document.querySelector('.google-health-panel').textContent, /321 kcal|0 kcal|synthetic-health-ui-token/);
  assert.equal(store.getItem(STORAGE_KEY), original);
});

test('a late Google Health response cannot appear on the newly selected diary date or write its data', async t => {
  const { data, key, pastKey } = activityLogFixture();
  let releaseOld;
  let oldRequest;
  const { document, store, configs } = await bootHealthApp(t, data, (url, init) => {
    if (url.includes('/total-calories/') && JSON.parse(init.body).range.startTime.includes(dateOffset(key, -1))) {
      oldRequest = { url, init };
      return new Promise(resolve => { releaseOld = resolve; });
    }
    return standardHealthReply(url, init, 123, 0);
  });
  const original = store.getItem(STORAGE_KEY);
  document.querySelector('.health-actions button.primary').click();
  const authorization = configs[0].callback({ access_token: HEALTH_TEST_TOKEN, expires_in: 3600, scope: HEALTH_TEST_SCOPE });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(oldRequest);
  chooseDiaryDate(document, pastKey);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(document.querySelectorAll('.health-metrics strong').map(node => node.textContent), ['123 kcal', '0 kcal']);
  releaseOld(standardHealthReply(oldRequest.url, oldRequest.init, 999, 0));
  await authorization;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(document.querySelectorAll('.health-metrics strong').map(node => node.textContent), ['123 kcal', '0 kcal']);
  assert.equal(store.getItem(STORAGE_KEY), original);
  assert.equal(store.writes, 1);
});

for (const outcome of ['success', 'error']) {
  test(`a background Health ${outcome} preserves the meal dialog, edited grams and keyboard focus`, async t => {
    const { data, key } = activityLogFixture();
    let nextPending = false;
    let pending;
    const { document, store, authorize } = await bootHealthApp(t, data, (url, init) => {
      if (nextPending && url.includes('/total-calories/')) {
        nextPending = false;
        return new Promise(resolve => { pending = { url, init, resolve }; });
      }
      return standardHealthReply(url, init);
    });
    await authorize();
    const original = store.getItem(STORAGE_KEY);
    nextPending = true;
    document.querySelector('.health-actions button.primary').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(pending);
    const list = document.querySelector('.meal-list');
    const lunchIndex = data.days[key].meals.findIndex(item => item.slot === 'lunch');
    const editButton = document.querySelectorAll('.meal-card')[lunchIndex].querySelector('.meal-actions button');
    editButton.focus(); editButton.click();
    const dialog = document.querySelector('#app-dialog');
    const content = dialog.children[0];
    const grams = dialog.querySelector('.edit-ingredients input');
    const newGrams = grams.valueAsNumber + 7;
    grams.value = String(newGrams); grams.dispatch('input'); grams.focus();
    pending.resolve(outcome === 'success' ? standardHealthReply(pending.url, pending.init, 456)
      : healthReply({ error: { message: HEALTH_TEST_TOKEN } }, 503));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.querySelector('.meal-list'), list, 'A calorie refresh must not rebuild meal controls');
    assert.equal(document.querySelector('#app-dialog'), dialog);
    assert.equal(dialog.open, true);
    assert.equal(dialog.children[0], content);
    assert.equal(dialog.querySelector('.edit-ingredients input'), grams);
    assert.equal(grams.valueAsNumber, newGrams);
    assert.equal(document.activeElement, grams);
    assert.equal(grams.isConnected, true);
    assert.equal(editButton.isConnected, true);
    assert.equal(store.getItem(STORAGE_KEY), original);
    if (outcome === 'success') assert.match(document.querySelector('.health-metrics').textContent, /456 kcal/);
    else assert.match(document.querySelector('.health-error').textContent, /non è raggiungibile/);
    dialog.querySelector('.dialog-actions button.secondary').click();
    assert.equal(document.activeElement, editButton, 'Cancel must return focus to the same connected meal control');
    assert.equal(store.getItem(STORAGE_KEY), original);
    assert.equal(store.writes, 1);
  });
}

test('personal menu selection saves fixed targets and applies only to uneaten current and future meals', async t => {
  const { data, key, pastKey, futureKey } = profileApplicationFixture();
  const store = new MemoryStorage(); saveData(data, store);
  const { document, navigate } = await bootApp(t, store, 'profile');
  const form = document.querySelector('.profile-form');
  setProfileControl(form, 'mealPlan', 'chocolate-2200');
  setProfileControl(form, 'routineNotes', 'Passi e allenamenti annotati localmente.');
  assert.equal(form.querySelector('[name="targetMode"]').value, 'fixed');
  assert.equal(displayedEstimateNumbers(document)[2],2200);
  form.dispatch('submit');
  let actual=loadData(store).data;
  assert.deepEqual(actual.profile.nutritionTargets,{kcal:2200,protein:144,fat:80});
  assert.equal(actual.profile.routineNotes,'Passi e allenamenti annotati localmente.');
  assert.deepEqual(actual.days,data.days);
  document.querySelector('.profile-change-notice button').click();
  document.querySelector('.dialog-actions button.primary').click();
  actual=loadData(store).data;
  assert.deepEqual(actual.days[pastKey],data.days[pastKey]);
  assert.deepEqual(actual.days[key].consumed,data.days[key].consumed);
  assert.equal(actual.days[futureKey].targets.kcal,2200);
  assert.ok(actual.days[futureKey].meals.find(x=>x.slot==='breakfast').ingredients.some(x=>x.foodId==='skim-milk'&&x.grams===250));
  navigate('profile');
  assert.equal(document.querySelector('[name="targetMode"]').value,'fixed');
  assert.equal(document.querySelector('[name="routineNotes"]').textContent,'Passi e allenamenti annotati localmente.');
});

test('personal product can be saved, added, consumed and deleted without changing diary snapshots', async t => {
  const key = todayKey(), initial = generatedDiary(key), store = new MemoryStorage();
  saveData(initial, store);
  const { document, navigate } = await bootApp(t, store, 'foods');
  const buttonWith = text => document.querySelectorAll('button').find(b => b.textContent === text);
  buttonWith('Inserisci prodotto a mano').click();
  const form = document.querySelector('.portion-editor');
  const inputs = form.querySelectorAll('input');
  for (const [input, value] of inputs.map((input, i) => [input, ['Mousse test', 'Marca test', '76', '10', '5.8', '1.4', '175'][i]])) { input.value = value; input.dispatch('input'); }
  assert.match(document.querySelector('.portion-totals').textContent, /133 kcal/);
  form.dispatch('submit');
  const saved = loadData(store).data.personalPortions[0]; assert.equal(saved.grams, 175);
  buttonWith('Aggiungi a un pasto').click();
  const select = document.querySelector('#app-dialog select');
  const lunch = initial.days[key].meals.find(m => m.slot === 'lunch'); select.value = lunch.id; select.dispatch('change');
  buttonWith('Aggiungi porzione').click();
  let updated = loadData(store).data.days[key].meals.find(m => m.id === lunch.id);
  assert.equal(updated.ingredients.at(-1).foodSnapshot.name, 'Mousse test');
  assert.ok(Math.abs(updated.macros.kcal - lunch.macros.kcal - 133) < 1e-7);
  navigate('today');
  const card = document.querySelectorAll('.meal-card').find(c => c.textContent.includes('Mousse test'));
  card.querySelectorAll('button').find(b => b.textContent === 'Modifica porzioni e alternative').click();
  const quantity = document.querySelectorAll('.edit-ingredients input').at(-1); quantity.value = '150'; quantity.dispatch('input');
  buttonWith('Salva questo pasto').click();
  const editedCard = document.querySelectorAll('.meal-card').find(c => c.textContent.includes('Mousse test'));
  editedCard.querySelectorAll('button').find(b => b.textContent === 'Segna mangiato').click();
  const consumed = structuredClone(loadData(store).data.days[key].consumed[lunch.id]);
  assert.equal(consumed.meal.ingredients.at(-1).grams, 150);
  navigate('foods'); buttonWith('Elimina').click(); buttonWith('Elimina porzione').click();
  const final = loadData(store).data;
  assert.equal(final.personalPortions.length, 0); assert.deepEqual(final.days[key].consumed[lunch.id], consumed);
  assert.deepEqual(parseBackup(exportBackup(final)), final);
});

test('opening a saved plan updates upcoming meal times without changing food or recorded history', async t => {
  const key = todayKey();
  const pastKey = dateOffset(key, -1);
  const initial = generatedDiary(key);
  initial.days[pastKey] = generatedDiary(pastKey).days[pastKey];
  for (const current of Object.values(initial.days)) {
    current.meals.find(item => item.slot === 'preworkout').time = '05:45';
    current.meals.find(item => item.slot === 'dinner').time = '20:00';
  }
  const breakfast = initial.days[key].meals.find(item => item.slot === 'breakfast');
  initial.days[key].consumed[breakfast.id] = { consumedAt: new Date().toISOString(), meal: clone(breakfast) };
  const store = new MemoryStorage(); saveData(initial, store);
  await bootApp(t, store);
  const result = loadData(store).data;
  const expected = clone(initial.days[key]);
  expected.meals.find(item => item.slot === 'preworkout').time = '06:00';
  expected.meals.find(item => item.slot === 'dinner').time = '19:30';
  expected.updatedAt = result.days[key].updatedAt;
  assert.deepEqual(result.days[key], expected);
  assert.deepEqual(result.days[pastKey], initial.days[pastKey]);
});

test('opening a plan keeps the original schedule of meals already consumed', async t => {
  const key = todayKey();
  const initial = generatedDiary(key);
  for (const item of initial.days[key].meals) {
    if (item.slot === 'preworkout') item.time = '05:45';
    if (item.slot === 'dinner') item.time = '20:00';
    initial.days[key].consumed[item.id] = { consumedAt: new Date().toISOString(), meal: clone(item) };
  }
  const store = new MemoryStorage(); saveData(initial, store);
  await bootApp(t, store);
  assert.deepEqual(loadData(store).data, initial);
});
