import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateTargets } from '../src/nutrition.js';
import { createDayPlan } from '../src/planner.js';
import { STORAGE_KEY, createEmptyData, saveData, exportBackup } from '../src/storage.js';
import { GOOGLE_HEALTH_RECEIPTS_KEY } from '../src/google-health-receipts.js';
import { GOOGLE_HEALTH_SCOPE, GOOGLE_HEALTH_NUTRITION_SCOPE } from '../src/google-health-session.js';

// Exercise actual DOM handlers and real session/connector code with synthetic OAuth,
// storage, locks and HTTP. The DOM stand-in does not test rendering or accessibility.
class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async check => { for (let i = 0; i < 500 && !check(); i++) await tick(); assert.ok(check(), 'Expected asynchronous UI state'); };
const copy = value => structuredClone(value);
const buttonNamed = (node, text) => node.querySelectorAll('button').find(button => button.textContent === text);
const CLIENT = 'nutrition-ui-test.apps.googleusercontent.com';
const ACCOUNT = 'synthetic-health-user';
const TOKEN = 'synthetic-nutrition-ui-token';
const response = (body, status = 200) => ({ status, url: '', redirected: false, text: async () => JSON.stringify(body) });
function fixture() {
  const date = new Date();
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const data = createEmptyData();
  data.profile = { age: 35, sex: 'male', weight: 80, height: 180, activity: 'moderate', goal: 'maintain', trainingTime: '06:00', trainingDays: [1, 3, 5], specialCondition: false };
  const targets = calculateTargets(data.profile), meals = createDayPlan(data.profile, targets, key);
  const consumed = { consumedAt: new Date(Date.now() - 2000).toISOString(), meal: copy(meals[0]) };
  data.days[key] = { dateKey: key, createdAt: consumed.consumedAt, updatedAt: consumed.consumedAt, profileSnapshot: copy(data.profile), targets, meals, consumed: { [meals[0].id]: consumed }, skipped: [] };
  return { data, key, consumed };
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

class MemoryElement {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
    this.events = new Map(); this.className = ''; this.parentNode = null;
    this._text = text; this._value = null; this.open = false; this.checked = false;
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
const appCleanups = new WeakMap();
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
      this.pairs = form.querySelectorAll('input, select').filter(control => !control.isDisabled && control.attributes.name
        && !(control.attributes.type === 'checkbox' && !control.checked))
        .map(control => [control.attributes.name, control.attributes.type === 'checkbox' ? control.value || 'on' : control.value]);
    }
    get(name) { return this.pairs.find(pair => pair[0] === name)?.[1] ?? null; }
    getAll(name) { return this.pairs.filter(pair => pair[0] === name).map(pair => pair[1]); }
  }
  const globals = { document, window, location, Node: MemoryElement, FormData: MemoryFormData, localStorage: store,
    requestAnimationFrame: callback => callback(), setTimeout: () => 0, clearTimeout: () => {},
    navigator: { locks: health.locks },
    google: { accounts: { oauth2: health.oauth } },
    fetch: health.fetchImpl ?? (() => { throw new Error('Unexpected network request from integration test'); }) };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  if (!appCleanups.has(t)) {
    appCleanups.set(t, []);
    t.after(async () => { for (const cleanup of appCleanups.get(t).toReversed()) await cleanup(); });
  }
  appCleanups.get(t).push(async () => {
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
  const configImport = /^import \{ GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_PERSISTENT \} from ['"]\.\/src\/google-health-config\.js[^'"]*['"];$/m;
  assert.match(source, configImport);
  source = source.replace(configImport, `const GOOGLE_HEALTH_CLIENT_ID = ${JSON.stringify(health.clientId ?? '')}; const GOOGLE_HEALTH_PERSISTENT = false;`)
    .replace(/from (['"])(\.\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, appURL).href}${quote}`);
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#integration-${appImport += 1}`);
  await new Promise(resolve => setImmediate(resolve));
  return { document, window, location, navigate(page) { location.hash = `#${page}`; window.dispatch('hashchange'); } };
}


async function bootNutrition(t, { initial = fixture(), store = new MemoryStorage(), pending = false, quota = false, lockApi = locks() } = {}) {
  if (!store.getItem(STORAGE_KEY)) saveData(initial.data, store);
  const diaryBefore = store.getItem(STORAGE_KEY), calls = [], configs = [], points = [];
  let posts = 0;
  const setItem = store.setItem.bind(store);
  store.setItem = (key, value) => { if (quota && key === GOOGLE_HEALTH_RECEIPTS_KEY) throw new Error('synthetic quota'); setItem(key, value); };
  const app = await bootApp(t, store, 'today', {
    clientId: CLIENT, locks: lockApi,
    oauth: { initTokenClient(config) { configs.push(config); return { requestAccessToken() {} }; } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/identity')) return response({ healthUserId: ACCOUNT });
      if (url.includes('/nutrition-log/')) {
        if (init.method === 'POST') {
          posts++;
          const receipts = Object.values(JSON.parse(store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY)).receipts);
          assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'pending');
          if (pending) return response({ done: false });
          const point = { name: `users/${ACCOUNT}/dataTypes/nutrition-log/dataPoints/point-1`, dataSource: { application: { googleWebClientId: CLIENT }, platform: 'GOOGLE_WEB_API' }, ...JSON.parse(init.body) };
          points.push(point); return response({ done: true, response: { '@type': 'type.googleapis.com/google.devicesandservices.health.v4.DataPoint', ...point } });
        }
        if (new URL(url).pathname.endsWith('/point-1')) return response(points[0]);
        return response({ dataPoints: points });
      }
      const { range } = JSON.parse(init.body);
      const field = url.includes('/total-calories/') ? 'totalCalories' : 'activeEnergyBurned';
      return response({ rollupDataPoints: [{ startTime: range.startTime, endTime: new Date(Date.parse(range.startTime) + 60000).toISOString(), [field]: { kcalSum: 100 } }] });
    },
  });
  const authorize = async () => {
    app.document.head.querySelector('script').dispatch('load'); await tick();
    app.document.querySelector('.health-actions button.primary').click();
    await configs.at(-1).callback({ access_token: TOKEN, expires_in: 3600, scope: GOOGLE_HEALTH_SCOPE }); await tick();
  };
  const permit = async () => {
    app.document.querySelector('#nutrition-permission').click();
    assert.equal(configs.at(-1).scope, `${GOOGLE_HEALTH_SCOPE} ${GOOGLE_HEALTH_NUTRITION_SCOPE}`);
    await configs.at(-1).callback({ access_token: TOKEN, expires_in: 3600, scope: `${GOOGLE_HEALTH_SCOPE} ${GOOGLE_HEALTH_NUTRITION_SCOPE}` }); await tick();
  };
  const review = async () => {
    app.document.querySelector('#nutrition-review').click();
    await waitFor(() => app.document.querySelector('.nutrition-row-state') && !app.document.querySelector('.nutrition-row-state').textContent.includes('corso'));
    return app.document.querySelector('#nutrition-review-dialog');
  };
  const sendSelected = async () => {
    const box = app.document.querySelector('.nutrition-meal-title input');
    assert.equal(box.disabled, false); box.checked = true; box.dispatch('change');
    const send = app.document.querySelector('#nutrition-review-dialog .dialog-actions button.primary');
    assert.equal(send.disabled, false); send.click();
    await waitFor(() => !app.document.querySelector('.nutrition-row-state').textContent.includes('corso'));
  };
  return { ...app, store, calls, configs, authorize, permit, review, sendSelected, initial, diaryBefore, posts: () => posts };
}

test('nutrition review uses only consumed snapshots and requires an unchecked explicit selection before POST', async t => {
  const app = await bootNutrition(t);
  assert.equal(app.calls.length, 0);
  await app.authorize(); await app.permit();
  assert.equal(app.posts(), 0);
  const review = await app.review();
  assert.equal(review.querySelectorAll('.nutrition-meal-row').length, 1);
  assert.match(review.textContent, /Non inviato/); assert.match(review.textContent, /Orario per Google/);
  assert.equal(review.querySelector('input').checked, false);
  assert.equal(review.querySelector('.dialog-actions button.primary').disabled, true);
  assert.equal(app.posts(), 0); assert.equal(app.store.getItem(STORAGE_KEY), app.diaryBefore);
  await app.sendSelected();
  assert.match(review.textContent, /Inviato/); assert.equal(app.posts(), 1);
  const post = app.calls.find(call => call.url.includes('/nutrition-log/') && call.init.method === 'POST');
  assert.equal(JSON.parse(post.init.body).nutritionLog.energy.kcal, app.initial.consumed.meal.macros.kcal);
  assert.equal(app.store.getItem(STORAGE_KEY), app.diaryBefore);
  const receipt = Object.values(JSON.parse(app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY)).receipts)[0];
  assert.equal(receipt.status, 'sent');
  assert.equal(app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY).includes(TOKEN), false);
  assert.equal(app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY).includes(ACCOUNT), false);
  assert.equal(exportBackup(JSON.parse(app.diaryBefore)).includes(receipt.accountKey), false);
});

test('uncertain upload stays pending across verification and reload without a second POST', async t => {
  const app = await bootNutrition(t, { pending: true });
  await app.authorize(); await app.permit(); await app.review(); await app.sendSelected();
  assert.equal(app.posts(), 1); assert.match(app.document.querySelector('.nutrition-row-state').textContent, /Esito incerto/);
  buttonNamed(app.document, 'Verifica stato su Google').click();
  await waitFor(() => app.document.querySelector('.nutrition-row-state').textContent.includes('Esito incerto'));
  assert.equal(app.posts(), 1); assert.equal(app.document.querySelector('.nutrition-meal-title input').disabled, true);
  app.window.dispatch('pagehide');
  const reloaded = await bootNutrition(t, { store: app.store, initial: app.initial, pending: true });
  await reloaded.authorize(); await reloaded.permit(); await reloaded.review();
  assert.match(reloaded.document.querySelector('.nutrition-row-state').textContent, /Esito incerto/);
  assert.equal(reloaded.document.querySelector('.nutrition-meal-title input').disabled, true);
  assert.equal(reloaded.posts(), 0); assert.equal(app.store.getItem(STORAGE_KEY), app.diaryBefore);
});

test('receipt quota failure prevents POST and keeps the diary unchanged', async t => {
  const app = await bootNutrition(t, { quota: true });
  await app.authorize(); await app.permit(); await app.review(); await app.sendSelected();
  assert.equal(app.posts(), 0); assert.equal(app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), null);
  assert.match(app.document.querySelector('.nutrition-row-state').textContent, /non.*salvat|non.*disponibil/i);
  assert.equal(app.store.getItem(STORAGE_KEY), app.diaryBefore);
});

test('undo of an uploaded meal requires a local-only confirmation and keeps the receipt', async t => {
  const app = await bootNutrition(t);
  await app.authorize(); await app.permit(); await app.review(); await app.sendSelected();
  const receipt = app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY);
  buttonNamed(app.document, 'Chiudi senza altri invii').click();
  buttonNamed(app.document, 'Annulla registrazione').click();
  await waitFor(() => Boolean(buttonNamed(app.document, 'Annulla nel diario')));
  assert.match(app.document.querySelector('#app-dialog').textContent, /non la cancella/);
  assert.equal(app.store.getItem(STORAGE_KEY), app.diaryBefore);
  buttonNamed(app.document, 'Annulla nel diario').click();
  assert.deepEqual(JSON.parse(app.store.getItem(STORAGE_KEY)).days[app.initial.key].consumed, {});
  assert.equal(app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), receipt);
  assert.equal(app.calls.some(call => call.init.method === 'DELETE'), false); assert.equal(app.posts(), 1);
});

test('missing Web Locks keeps reading available and does not offer upload authorization', async t => {
  const app = await bootNutrition(t, { lockApi: null }); await app.authorize();
  assert.equal(app.document.querySelector('#nutrition-permission'), null);
  assert.match(app.document.querySelector('.nutrition-controls').textContent, /blocchi tra schede|blocco tra schede/);
  assert.equal(app.configs.length, 1); assert.equal(app.posts(), 0);
});

test('marking another meal eaten after nutrition consent never uploads it automatically', async t => {
  const app = await bootNutrition(t); await app.authorize(); await app.permit();
  const before = app.calls.length;
  buttonNamed(app.document, 'Segna mangiato').click(); await tick();
  assert.equal(app.calls.length, before); assert.equal(app.posts(), 0);
  assert.equal(Object.keys(JSON.parse(app.store.getItem(STORAGE_KEY)).days[app.initial.key].consumed).length, 2);
});

test('a diary conflict after review blocks the selected upload before any POST', async t => {
  const app = await bootNutrition(t); await app.authorize(); await app.permit(); await app.review();
  const box = app.document.querySelector('.nutrition-meal-title input'); box.checked = true; box.dispatch('change');
  app.window.dispatch('storage', { key: STORAGE_KEY });
  app.document.querySelector('#nutrition-review-dialog .dialog-actions button.primary').click(); await tick();
  assert.equal(app.posts(), 0); assert.equal(app.store.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), null);
  assert.match(app.document.querySelector('#nutrition-review-dialog').textContent, /Invio fermato/);
});

test('an impossible retroactive clock time requires an explicit offset without changing the diary', async t => {
  const initial = fixture(), past = '2026-03-29';
  const historical = copy(initial.data.days[initial.key]); historical.dateKey = past;
  const entry = historical.consumed[historical.meals[0].id]; entry.meal.time = '02:30';
  initial.data.days[past] = historical;
  const app = await bootNutrition(t, { initial }); await app.authorize(); await app.permit();
  const dateInput = app.document.querySelector('input[type="date"]'); dateInput.value = past; dateInput.dispatch('change'); await tick();
  const review = await app.review();
  assert.match(review.querySelector('.nutrition-row-state').textContent, /ambiguo o inesistente/);
  const timeInput = review.querySelectorAll('input').find(input => input.attributes.type === 'text');
  assert.equal(timeInput.parentNode.hidden, false);
  timeInput.value = 'invalid'; timeInput.dispatch('input'); buttonNamed(review, 'Verifica stato su Google').click();
  await waitFor(() => review.querySelector('.nutrition-row-state').textContent.includes('Controlla i dati'));
  assert.equal(timeInput.parentNode.hidden, false);
  timeInput.value = '2026-03-29T03:30:00+02:00'; timeInput.dispatch('input'); buttonNamed(review, 'Verifica stato su Google').click();
  await waitFor(() => review.querySelector('.nutrition-row-state').textContent.includes('Non inviato'));
  assert.equal(app.posts(), 0); assert.equal(app.store.getItem(STORAGE_KEY), app.diaryBefore);
});
