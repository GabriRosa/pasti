import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { syncGoogleHealthConsumedMeal, prepareGoogleHealthConsumedMeal, getGoogleHealthNutritionAccountKey } from '../src/google-health-nutrition.js';
import { createGoogleHealthSession, GOOGLE_HEALTH_SCOPE, GOOGLE_HEALTH_NUTRITION_SCOPE } from '../src/google-health-session.js';
import { verifyGoogleHealthAccount } from '../src/google-health.js';
import { createGoogleHealthReceiptStore, GOOGLE_HEALTH_RECEIPTS_KEY } from '../src/google-health-receipts.js';
import { createEmptyData, saveData, loadData, exportBackup, STORAGE_KEY } from '../src/storage.js';
import { calculateTargets } from '../src/nutrition.js';
import { createDayPlan } from '../src/planner.js';

const CLIENT = 'independent-review.apps.googleusercontent.com';
const READ = 'synthetic-read-only-token';
const WRITE = 'synthetic-read-and-write-token';
const ACCOUNT = 'review-health-account';
const DAY = '2026-10-23';
const NOW = new Date('2026-10-23T19:00:00Z');
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ status, url: '', redirected: false, text: async () => JSON.stringify(body) });
const eaten = () => ({ consumedAt: '2026-10-23T11:30:00Z', meal: {
  id: 'review-lunch', slot: 'lunch', title: 'Pasto di prova', time: '13:30',
  macros: { kcal: 420.5, protein: 32.25, carbs: 48.75, fat: 9.5 },
  ingredients: [{ foodId: 'private-ingredient', grams: 85 }], note: 'DO NOT EXPORT PRIVATE NOTE',
} });
const base = () => ({ clientId: CLIENT, accessToken: WRITE, dateKey: DAY, now: NOW, consumed: eaten() });

function locks() {
  const tails = new Map();
  return { request(name, options, callback) {
    if (options.ifAvailable && tails.has(name)) return Promise.resolve(callback(null));
    const prior = tails.get(name) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => callback({ name }));
    const finished = task.finally(() => { if (tails.get(name) === finished) tails.delete(name); });
    tails.set(name, finished);
    return finished;
  } };
}

function ledger(shared = {}) {
  const storage = shared.storage ?? { values: new Map(), getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { this.values.set(key, value); } };
  const lockManager = shared.lockManager ?? locks();
  return { storage, lockManager, store: createGoogleHealthReceiptStore({ storage, locks: lockManager }) };
}

function apiFixture() {
  const api = { calls: [], posts: [], points: [], visible: true, onList: null, onPost: null,
    tokens: new Map([[READ, { account: ACCOUNT, scopes: [GOOGLE_HEALTH_SCOPE] }],
      [WRITE, { account: ACCOUNT, scopes: [GOOGLE_HEALTH_SCOPE, GOOGLE_HEALTH_NUTRITION_SCOPE] }]]) };
  api.point = (body, id = `server-${api.posts.length + 1}`, account = ACCOUNT, clientId = CLIENT) => ({
    name: `users/${account}/dataTypes/nutrition-log/dataPoints/${id}`,
    dataSource: { application: { googleWebClientId: clientId }, platform: 'GOOGLE_WEB_API' }, ...clone(body),
  });
  api.fetch = async (url, init) => {
    const parsed = new URL(url);
    const token = init.headers.Authorization?.slice(7);
    const auth = api.tokens.get(token);
    api.calls.push({ url, method: init.method, body: init.body, token });
    if (!auth) return response({ error: { message: 'bad credentials' } }, 401);
    if (parsed.pathname === '/v4/users/me/identity') {
      // The official getIdentity contract lists read scopes, not nutrition.writeonly.
      if (!auth.scopes.some(scope => [GOOGLE_HEALTH_SCOPE, 'https://www.googleapis.com/auth/googlehealth.nutrition.readonly'].includes(scope))) return response({ error: { message: 'MISSING_OAUTH_SCOPE' } }, 403);
      return response({ healthUserId: auth.account });
    }
    if (parsed.pathname.endsWith('/dataPoints:rollUp')) {
      assert.ok(auth.scopes.includes(GOOGLE_HEALTH_SCOPE));
      return response({});
    }
    const collection = '/v4/users/me/dataTypes/nutrition-log/dataPoints';
    assert.ok(parsed.pathname.startsWith(collection));
    assert.ok(auth.scopes.includes(GOOGLE_HEALTH_NUTRITION_SCOPE));
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      const point = api.point(body, `server-${api.posts.length + 1}`, auth.account);
      api.posts.push(clone(body)); api.points.push(point);
      return api.onPost ? api.onPost(body, point) : response({ done: true, response: point });
    }
    assert.equal(init.method, 'GET');
    if (parsed.pathname === collection) {
      assert.equal(parsed.searchParams.get('dataSourceFamily'), 'users/me/dataSourceFamilies/self-sources');
      return api.onList ? api.onList(parsed) : response({ dataPoints: api.visible ? api.points.filter(point => point.name.startsWith(`users/${auth.account}/`)) : [] });
    }
    const id = parsed.pathname.split('/').at(-1);
    const point = api.points.find(item => item.name === `users/${auth.account}/dataTypes/nutrition-log/dataPoints/${id}`);
    return point ? response(point) : response({}, 404);
  };
  return api;
}

async function sendWithStore(api, book, options = {}, connector = syncGoogleHealthConsumedMeal) {
  const input = { ...base(), ...options };
  const key = await getGoogleHealthNutritionAccountKey({ accessToken: input.accessToken, clientId: CLIENT, fetchImpl: api.fetch });
  const prepared = await prepareGoogleHealthConsumedMeal(input);
  return book.store.withMealLock(key, prepared.mealKey, () => connector({ ...input, fetchImpl: api.fetch,
    receipt: book.store.read(key, prepared.mealKey),
    recordReceipt: (next, previous) => book.store.compareAndSet(next, previous, { isActive: options.isActive ?? (() => true) }),
  }));
}

test('review: nutrition authorization must also authorize identity verification', async t => {
  const api = apiFixture(); const book = ledger(); const configs = [];
  const session = createGoogleHealthSession({ clientId: CLIENT, receiptStore: book.store, now: () => NOW,
    setTimer: () => 1, clearTimer: () => {},
    loadOAuth: async () => ({ initTokenClient(config) { configs.push(config); return { requestAccessToken() {} }; } }),
    verifyAccount: options => verifyGoogleHealthAccount({ ...options, fetchImpl: api.fetch }),
    readDay: async ({ dateKey }) => ({ source: 'google_health', dateKey, timeZone: 'Europe/Rome',
      rangeStart: '2026-10-22T22:00:00Z', rangeEnd: '2026-10-23T19:00:00Z', fetchedAt: NOW.toISOString(),
      totalKcal: null, activeKcal: null, coverage: { totalSeconds: 0, activeSeconds: 0, requestedSeconds: 75600 } }),
  });
  t.after(() => session.dispose());
  session.setContext({ dateKey: DAY, active: true, visible: true });
  await session.prepare(); session.connect();
  await configs[0].callback({ access_token: READ, expires_in: 3600, scope: configs[0].scope });
  assert.equal(session.getState().status, 'connected');
  assert.equal(session.requestNutritionAccess(), true);
  const requested = configs[1].scope.split(/\s+/).filter(Boolean);
  api.tokens.set(WRITE, { account: ACCOUNT, scopes: requested });
  await configs[1].callback({ access_token: WRITE, expires_in: 3600, scope: configs[1].scope });
  assert.equal(session.getState().nutrition.status, 'ready', 'The upload token must pass the documented read-scope requirement of getIdentity');
  assert.ok(requested.includes(GOOGLE_HEALTH_NUTRITION_SCOPE));
  assert.ok(requested.includes(GOOGLE_HEALTH_SCOPE));
  assert.equal(configs[1].include_granted_scopes, false);
  assert.equal(api.posts.length, 0);
});

test('review: durable pending survives reload and delayed visibility without repeating a POST', async () => {
  const api = apiFixture(), book = ledger();
  api.onPost = () => { api.visible = false; throw new Error(WRITE); };
  const initial = await sendWithStore(api, book, { allowCreate: true });
  assert.equal(initial.status, 'pending');
  const restored = ledger(book);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await sendWithStore(api, restored, { allowCreate: true });
    assert.equal(result.status, 'pending');
  }
  assert.equal(api.posts.length, 1);
  api.visible = true;
  const final = await sendWithStore(api, restored, { allowCreate: true });
  assert.equal(final.status, 'existing');
  assert.equal(api.posts.length, 1);
  const text = restored.storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY);
  assert.doesNotMatch(text, /synthetic-|review-health-account|Pasto di prova|PRIVATE NOTE|private-ingredient|420\.5/);
});

test('review: a rejected local receipt write prevents every remote create', async () => {
  const api = apiFixture(), book = ledger();
  let active = true;
  api.onList = () => { active = false; return response({ dataPoints: [] }); };
  await assert.rejects(sendWithStore(api, book, { allowCreate: true, isActive: () => active }), { code: 'LOCAL_STATE_ERROR' });
  assert.equal(api.posts.length, 0);
  assert.equal(book.storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), null);
});

test('review: independent connector instances share the durable per-meal lock', async () => {
  const api = apiFixture(), first = ledger(), second = ledger(first);
  const reloaded = await import(`../src/google-health-nutrition.js?independent-review=${Date.now()}`);
  let release; let started;
  const arrived = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  api.onList = async () => { started(); await blocked; return response({ dataPoints: [] }); };
  const one = sendWithStore(api, first, { allowCreate: true });
  await arrived;
  await assert.rejects(sendWithStore(api, second, { allowCreate: true }, reloaded.syncGoogleHealthConsumedMeal), { code: 'BUSY' });
  release(); await one;
  assert.equal(api.posts.length, 1);
});

test('review: changing the local payload while a receipt is pending cannot create an alternative copy', async () => {
  const api = apiFixture(), book = ledger();
  api.onPost = () => { api.visible = false; return response({ name: 'operations/pending', done: false }); };
  assert.equal((await sendWithStore(api, book, { allowCreate: true })).status, 'pending');
  const consumed = eaten(); consumed.meal.macros.protein += 4; consumed.meal.title = 'Nome corretto';
  const result = await sendWithStore(api, book, { consumed, occurredAt: '2026-10-23T11:35:00Z', allowCreate: true });
  assert.equal(result.status, 'changed'); assert.equal(api.posts.length, 1);
  assert.ok(api.calls.every(call => !['PATCH', 'DELETE'].includes(call.method) && !call.url.includes('batchDelete')));
});

test('review: contradictory copies of one remote ID across pages cannot be confirmed as sent', async () => {
  const api = apiFixture(), prepared = await prepareGoogleHealthConsumedMeal(base());
  const point = api.point(prepared.body, 'same-id');
  const changed = clone(point); changed.nutritionLog.totalFat.grams += 1;
  api.onList = url => url.searchParams.has('pageToken')
    ? response({ dataPoints: [changed] }) : response({ dataPoints: [point], nextPageToken: 'second' });
  const result = await syncGoogleHealthConsumedMeal({ ...base(), fetchImpl: api.fetch, allowCreate: true });
  assert.equal(result.status, 'conflict'); assert.equal(api.posts.length, 0);
});

test('review: foreign-client data in an own-source response stops rather than authorizing a new create', async () => {
  const api = apiFixture(), prepared = await prepareGoogleHealthConsumedMeal(base());
  api.points.push(api.point(prepared.body, 'foreign', ACCOUNT, 'another-client.apps.googleusercontent.com'));
  await assert.rejects(sendWithStore(api, ledger(), { allowCreate: true }), { code: 'INVALID_RESPONSE' });
  assert.equal(api.posts.length, 0);
});

test('review: changing account after a pending result rejects the original receipt before data lookup', async () => {
  const api = apiFixture(), book = ledger();
  api.onPost = () => { throw new Error('response lost'); };
  const pending = await sendWithStore(api, book, { allowCreate: true });
  api.calls.length = 0;
  api.tokens.set(WRITE, { account: 'different-health-account', scopes: [GOOGLE_HEALTH_SCOPE, GOOGLE_HEALTH_NUTRITION_SCOPE] });
  await assert.rejects(syncGoogleHealthConsumedMeal({ ...base(), receipt: pending.receipt,
    fetchImpl: api.fetch, allowCreate: true, recordReceipt: async () => assert.fail('must not store') }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(api.calls.length, 1);
  assert.ok(api.calls[0].url.endsWith('/identity'));
  assert.equal(api.posts.length, 1);
});

test('review: empty ProtoJSON quantities are zero only when their quantity object is present', async () => {
  const input = base(); input.consumed.meal.macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const prepared = await prepareGoogleHealthConsumedMeal(input);
  const api = apiFixture();
  const point = api.point(prepared.body, 'zero');
  point.nutritionLog.energy = {};
  point.nutritionLog.totalCarbohydrate = {};
  point.nutritionLog.totalFat = {};
  point.nutritionLog.nutrients[0].quantity = {};
  api.points.push(point);
  assert.equal((await syncGoogleHealthConsumedMeal({ ...input, fetchImpl: api.fetch })).status, 'existing');
  delete point.nutritionLog.energy;
  assert.equal((await syncGoogleHealthConsumedMeal({ ...input, fetchImpl: api.fetch, allowCreate: true })).status, 'changed');
  assert.equal(api.posts.length, 0);
});

test('review: official energy and gram limits apply before any remote lookup', async () => {
  for (const field of ['kcal', 'protein', 'carbs', 'fat']) {
    const valid = base(); valid.consumed.meal.macros[field] = 100000;
    await assert.doesNotReject(prepareGoogleHealthConsumedMeal(valid));
    const invalid = clone(valid); invalid.consumed.meal.macros[field] = 100000.001;
    let network = 0;
    await assert.rejects(syncGoogleHealthConsumedMeal({ ...invalid, fetchImpl: () => { network++; } }), { code: 'INVALID_INPUT' });
    assert.equal(network, 0);
  }
});

test('review: the conventional interval computes both offsets across exact DST transitions', async () => {
  for (const [dateKey, occurredAt, from, to] of [
    ['2026-03-29', '2026-03-29T01:00:00Z', '3600s', '7200s'],
    ['2026-10-25', '2026-10-25T01:00:00Z', '7200s', '3600s'],
  ]) {
    const prepared = await prepareGoogleHealthConsumedMeal({ ...base(), dateKey, occurredAt, now: new Date('2026-10-26T12:00:00Z') });
    const interval = prepared.body.nutritionLog.interval;
    assert.equal(interval.startUtcOffset, from);
    assert.equal(interval.endUtcOffset, to);
    assert.equal(Date.parse(interval.endTime) - Date.parse(interval.startTime), 1000);
  }
});

// Minimal DOM for the real app; it models events and identity, not layout.
class ReviewNode {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = new Map(); this.parentNode = null; this.className = ''; this._text = text; this._value = null; this.open = false; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get id() { return this.attributes.id ?? ''; } set id(value) { this.attributes.id = value; }
  get value() { return this._value ?? (this.tagName === 'SELECT' ? (this.querySelectorAll('option').find(node => node.selected) ?? this.querySelector('option'))?.value ?? '' : this.attributes.value ?? ''); }
  set value(value) { this._value = String(value); }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  get isConnected() { return this.tagName === 'BODY' || Boolean(this.parentNode?.isConnected); }
  get isDisabled() { return Boolean(this.disabled || this.parentNode?.isDisabled); }
  get classList() { return { contains: value => this.className.split(/\s+/).includes(value), toggle: (value, enabled) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled) names.add(value); else names.delete(value); this.className = [...names].join(' '); } }; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'value') this.value = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
  replaceWith(node) { const parent = this.parentNode; if (!parent) return; const index = parent.children.indexOf(this); parent.children.splice(index, 1, node); node.parentNode = parent; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  addEventListener(event, listener, options = {}) { if (!this.events.has(event)) this.events.set(event, []); this.events.get(event).push({ listener, once: options.once }); }
  removeEventListener(event, listener) { this.events.set(event, (this.events.get(event) ?? []).filter(item => item.listener !== listener)); }
  dispatch(name, extra = {}) { const event = { target: this, bubbles: true, cancelBubble: false, preventDefault() {}, stopPropagation() { this.cancelBubble = true; }, ...extra }; let node = this; do { event.currentTarget = node; for (const item of [...(node.events.get(name) ?? [])]) { if (item.once) node.removeEventListener(name, item.listener); item.listener(event); } node = event.bubbles && !event.cancelBubble ? node.parentNode : null; } while (node); }
  click() { if (!this.isDisabled) this.dispatch('click'); }
  focus() { globalThis.document.activeElement = this; }
  showModal() { this.open = true; } close() { this.open = false; this.dispatch('close', { bubbles: false }); }
  scrollIntoView() {} checkValidity() { return !this.required || this.value !== ''; }
  matches(selector) { const attr = selector.match(/^([a-z]*)\[([^=\]]+)(?:="([^"]*)")?\]$/); if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase()) && (attr[3] === undefined ? this.attributes[attr[2]] !== undefined || Boolean(this[attr[2]]) : this.attributes[attr[2]] === attr[3]); if (selector.startsWith('#')) return this.id === selector.slice(1); const [tag, ...classes] = selector.split('.'); return (!tag || this.tagName === tag.toUpperCase()) && classes.every(value => this.classList.contains(value)); }
  querySelectorAll(selector) { const groups = selector.split(',').map(group => group.trim().split(/\s+/)); const matches = (node, parts) => { if (!node.matches(parts.at(-1))) return false; let parent = node.parentNode; for (let index = parts.length - 2; index >= 0; index--) { while (parent && !parent.matches(parts[index])) parent = parent.parentNode; if (!parent) return false; parent = parent.parentNode; } return true; }; const found = []; const visit = node => { for (const child of node.children) { if (groups.some(parts => matches(child, parts))) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await tick(); }
  assert.fail('The expected asynchronous UI state was not reached');
}

let appVersion = 0;
async function nutritionApp(t, api) {
  const date = new Date();
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const data = createEmptyData();
  data.profile = { age: 35, sex: 'male', weight: 80, height: 180, activity: 'moderate', goal: 'maintain', trainingTime: '06:00', trainingDays: [0, 1, 2, 3, 4, 5, 6], specialCondition: false };
  const targets = calculateTargets(data.profile), meals = createDayPlan(data.profile, targets, key);
  const stamp = new Date(Date.now() - 60000).toISOString();
  data.days[key] = { dateKey: key, createdAt: stamp, updatedAt: stamp, profileSnapshot: clone(data.profile), targets, meals, consumed: {}, skipped: [meals[0].id] };
  for (const item of meals.filter(meal => ['breakfast', 'dinner'].includes(meal.slot))) data.days[key].consumed[item.id] = { consumedAt: stamp, meal: clone(item) };
  const book = ledger(); saveData(data, book.storage);
  const body = new ReviewNode('body'), head = new ReviewNode('head'), events = new ReviewNode('document');
  for (const id of ['main', 'notifications', 'app-dialog']) { const node = new ReviewNode(id === 'app-dialog' ? 'dialog' : 'div'); node.id = id; body.append(node); }
  const document = { body, head, activeElement: body, visibilityState: 'visible', querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), createElement: tag => new ReviewNode(tag), createTextNode: text => new ReviewNode('#text', String(text)), createDocumentFragment: () => new ReviewNode('#fragment'), addEventListener: events.addEventListener.bind(events), dispatch: events.dispatch.bind(events) };
  const window = new ReviewNode('window'); window.scrollTo = () => {};
  const configs = [];
  const globals = { document, window, location: { hash: '#today' }, Node: ReviewNode, localStorage: book.storage, navigator: { locks: book.lockManager },
    requestAnimationFrame: callback => callback(), setTimeout: () => 1, clearTimeout: () => {}, fetch: api.fetch,
    google: { accounts: { oauth2: { initTokenClient(config) { configs.push(config); return { requestAccessToken() {} }; } } } },
  };
  const previous = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.after(async () => { window.dispatch('pagehide'); await tick(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const url = new URL('../app.js', import.meta.url);
  const source = (await readFile(url, 'utf8')).replace(/^import \{ GOOGLE_HEALTH_CLIENT_ID \} from [^;]+;$/m, `const GOOGLE_HEALTH_CLIENT_ID = ${JSON.stringify(CLIENT)};`)
    .replace(/from (['"])(\.\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#nutrition-review-${++appVersion}`);
  await tick(); head.querySelector('script').dispatch('load'); await tick();
  document.querySelector('#health-connect').click();
  await configs[0].callback({ access_token: READ, expires_in: 3600, scope: configs[0].scope }); await tick();
  const authorizeNutrition = async () => {
    document.querySelector('#nutrition-permission').click();
    await configs.at(-1).callback({ access_token: WRITE, expires_in: 3600, scope: configs.at(-1).scope }); await tick();
  };
  const openReview = async () => { document.querySelector('#nutrition-review').click(); await waitFor(() => document.querySelectorAll('.nutrition-row-state strong').length === 2 && document.querySelectorAll('.nutrition-row-state strong').every(node => node.textContent === 'Non inviato')); };
  return { key, data, book, document, window, configs, authorizeNutrition, openReview };
}

test('review UI: authorization and preview send nothing until one consumed meal is selected and confirmed', async t => {
  const api = apiFixture(); const app = await nutritionApp(t, api);
  const original = app.book.storage.getItem(STORAGE_KEY);
  const backup = exportBackup(loadData(app.book.storage).data);
  assert.equal(api.posts.length, 0);
  await app.authorizeNutrition();
  assert.equal(api.posts.length, 0);
  await app.openReview();
  assert.equal(api.posts.length, 0);
  const rows = app.document.querySelectorAll('.nutrition-meal-row');
  assert.equal(rows.length, 2, 'The skipped snack and planned-only lunch must not be candidates');
  assert.ok(rows.every(row => !row.querySelector('input[type="checkbox"]').checked));
  const send = app.document.querySelector('.nutrition-review .dialog-actions button.primary');
  assert.equal(send.disabled, true);
  const selected = rows[0].querySelector('input[type="checkbox"]'); selected.checked = true; selected.dispatch('change');
  send.click();
  await waitFor(() => rows[0].querySelector('.nutrition-row-state strong').textContent === 'Inviato');
  assert.equal(api.posts.length, 1);
  const consumed = Object.values(app.data.days[app.key].consumed)[0];
  assert.equal(api.posts[0].nutritionLog.foodDisplayName, consumed.meal.title);
  assert.equal(api.posts[0].nutritionLog.energy.kcal, consumed.meal.macros.kcal);
  assert.equal(app.book.storage.getItem(STORAGE_KEY), original);
  assert.equal(exportBackup(loadData(app.book.storage).data), backup);
  assert.doesNotMatch(app.book.storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), /synthetic-|review-health-account|foodDisplayName|nutritionLog|consumedAt/);
});

test('review UI: cancelling a nutrition preview creates no remote record or receipt', async t => {
  const api = apiFixture(); const app = await nutritionApp(t, api);
  await app.authorizeNutrition(); await app.openReview();
  app.document.querySelector('.nutrition-review .dialog-actions button').click();
  assert.equal(api.posts.length, 0);
  assert.equal(app.book.storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), null);
  assert.deepEqual(loadData(app.book.storage).data, app.data);
});

test('review UI: an uncertain send offers verification without another create', async t => {
  const api = apiFixture(); const app = await nutritionApp(t, api);
  await app.authorizeNutrition(); await app.openReview();
  api.onPost = () => { api.visible = false; throw new Error('connection lost'); };
  const row = app.document.querySelector('.nutrition-meal-row');
  const checkbox = row.querySelector('input[type="checkbox"]'); checkbox.checked = true; checkbox.dispatch('change');
  app.document.querySelector('.nutrition-review .dialog-actions button.primary').click();
  await waitFor(() => row.querySelector('.nutrition-row-state strong').textContent.startsWith('Esito incerto'));
  assert.equal(checkbox.disabled, true);
  row.querySelector('button').click();
  await waitFor(() => row.querySelector('.nutrition-row-state strong').textContent.startsWith('Esito incerto'));
  assert.equal(api.posts.length, 1);
  assert.deepEqual(loadData(app.book.storage).data, app.data);
});

test('review UI: a cross-tab consumption change after preview blocks the selected upload', async t => {
  const api = apiFixture(); const app = await nutritionApp(t, api);
  await app.authorizeNutrition(); await app.openReview();
  const selected = app.document.querySelector('.nutrition-meal-row input[type="checkbox"]'); selected.checked = true; selected.dispatch('change');
  const external = clone(app.data); Object.values(external.days[app.key].consumed)[0].meal.macros.kcal += 10;
  saveData(external, app.book.storage); app.window.dispatch('storage', { key: STORAGE_KEY });
  app.document.querySelector('.nutrition-review .dialog-actions button.primary').click(); await tick();
  assert.equal(api.posts.length, 0);
  assert.deepEqual(loadData(app.book.storage).data, external);
});

for (const reason of ['denied', 'other-account']) {
  test(`review UI: nutrition access ${reason} preserves calorie reading and creates nothing`, async t => {
    const api = apiFixture(); const app = await nutritionApp(t, api);
    const original = app.book.storage.getItem(STORAGE_KEY);
    if (reason === 'denied') {
      app.document.querySelector('#nutrition-permission').click();
      await app.configs.at(-1).callback({ error: 'access_denied' }); await tick();
    } else {
      api.tokens.set(WRITE, { account: 'different-health-account', scopes: [GOOGLE_HEALTH_SCOPE, GOOGLE_HEALTH_NUTRITION_SCOPE] });
      await app.authorizeNutrition();
    }
    assert.equal(app.document.querySelector('.health-status').textContent, 'Sessione collegata');
    assert.ok(app.document.querySelector('#health-refresh'));
    assert.equal(app.document.querySelector('#nutrition-review'), null);
    assert.equal(api.posts.length, 0);
    assert.equal(app.book.storage.getItem(STORAGE_KEY), original);
    assert.doesNotMatch(app.document.body.textContent, /synthetic-|different-health-account/);
  });
}

test('review UI: undoing an uploaded consumption warns and leaves the remote record intact', async t => {
  const api = apiFixture(); const app = await nutritionApp(t, api);
  await app.authorizeNutrition(); await app.openReview();
  const row = app.document.querySelector('.nutrition-meal-row');
  const checkbox = row.querySelector('input[type="checkbox"]'); checkbox.checked = true; checkbox.dispatch('change');
  app.document.querySelector('.nutrition-review .dialog-actions button.primary').click();
  await waitFor(() => row.querySelector('.nutrition-row-state strong').textContent === 'Inviato');
  app.document.querySelector('.nutrition-review .dialog-actions button').click();
  const beforeRemote = clone(api.points);
  const undo = app.document.querySelectorAll('.meal-card button').find(button => button.textContent === 'Annulla registrazione');
  assert.ok(undo); undo.click();
  await waitFor(() => app.document.querySelector('#app-dialog').open);
  assert.match(app.document.querySelector('#app-dialog').textContent, /Google/);
  app.document.querySelector('.dialog-actions button.primary').click(); await tick();
  assert.equal(Object.keys(loadData(app.book.storage).data.days[app.key].consumed).length, 1);
  assert.deepEqual(api.points, beforeRemote);
  assert.equal(api.posts.length, 1);
  assert.ok(api.calls.every(call => !['PATCH', 'DELETE'].includes(call.method) && !call.url.includes('batchDelete')));
  assert.ok(app.book.storage.getItem(GOOGLE_HEALTH_RECEIPTS_KEY), 'The receipt must survive the local undo');
});
