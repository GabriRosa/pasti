import { calculateTargets } from './nutrition.js?v=20261023-deficit';
import { validateTrainingPlan } from './training.js?v=20261023-deficit';

/** Local-only, versioned persistence. All writes validate before replacing data. */
export const STORAGE_KEY = 'pasti.data.v1';
export const SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MACRO_KEYS = ['kcal', 'protein', 'carbs', 'fat'];

export function createEmptyData() {
  return { schemaVersion: SCHEMA_VERSION, profile: null, foodOverrides: {}, days: {} };
}

function fail(message) { throw new Error(`Backup non valido: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label);
}
function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}, campi inattesi.`);
}
function safeTree(value, depth = 0) {
  if (depth > 20) fail('struttura troppo profonda.');
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN.has(key)) fail('chiave non consentita.');
      safeTree(value[key], depth + 1);
    }
  }
}
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label);
}
function text(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(label);
}
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('data del diario.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('data inesistente.');
}
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || value.length > 40) fail('data di salvataggio.');
}
function macros(value) {
  keys(value, MACRO_KEYS, 'valori nutrizionali');
  for (const key of MACRO_KEYS) number(value[key], 0, key === 'kcal' ? 100000 : 10000, key);
}
export function validateProfile(profile) {
  keys(profile, ['age', 'sex', 'weight', 'height', 'activity', 'goal', 'trainingTime', 'trainingDays', 'specialCondition', 'deficitKcal', 'trainingPlan'], 'profilo');
  number(profile.age, 18, 100, 'età (18–100 anni).');
  number(profile.weight, 35, 250, 'peso (35–250 kg).');
  number(profile.height, 130, 230, 'altezza (130–230 cm).');
  if (!['male', 'female'].includes(profile.sex)) fail('sesso usato nella formula.');
  if (!['lose', 'maintain', 'gain'].includes(profile.goal)) fail('obiettivo.');
  text(profile.activity, 60, 'attività.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(profile.trainingTime)) fail('orario di allenamento.');
  if (!Array.isArray(profile.trainingDays) || profile.trainingDays.length > 7 ||
      new Set(profile.trainingDays).size !== profile.trainingDays.length ||
      profile.trainingDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) fail('giorni di allenamento.');
  if (typeof profile.specialCondition !== 'boolean') fail('condizioni particolari.');
  if (Object.hasOwn(profile, 'deficitKcal')) {
    number(profile.deficitKcal, 0, Number.MAX_VALUE, 'deficit calorico.');
    try { calculateTargets(profile); } catch (error) { fail(error.message); }
  }
  try { validateTrainingPlan(profile.trainingPlan); } catch (error) { fail(error.message); }
  if (profile.trainingPlan !== undefined) {
    const expected = profile.trainingPlan.mode === 'alternating' ? [0, 1, 2, 3, 4, 5, 6] : profile.trainingPlan.days.flatMap((type, index) => type === 'rest' ? [] : [index]);
    if (expected.length !== profile.trainingDays.length || expected.some(value => !profile.trainingDays.includes(value))) fail('giorni non coerenti con il calendario di allenamento.');
  }
  return profile;
}
function meal(value) {
  keys(value, ['id', 'slot', 'title', 'time', 'ingredients', 'macros', 'note'], 'pasto');
  text(value.id, 100, 'identificativo pasto.');
  if (!['preworkout', 'breakfast', 'lunch', 'dinner'].includes(value.slot)) fail('tipo pasto.');
  text(value.title, 300, 'titolo pasto.');
  text(value.time, 30, 'orario pasto.', true);
  text(value.note, 2000, 'nota pasto.', true);
  if (!Array.isArray(value.ingredients) || value.ingredients.length < 1 || value.ingredients.length > 30) fail('ingredienti.');
  value.ingredients.forEach(item => {
    keys(item, ['foodId', 'grams'], 'ingrediente');
    text(item.foodId, 100, 'alimento.');
    number(item.grams, 0, 10000, 'grammi.');
  });
  macros(value.macros);
}
function targets(value) {
  keys(value, [...MACRO_KEYS, 'bmr', 'tdee', 'warnings', 'method'], 'obiettivi');
  for (const key of [...MACRO_KEYS, 'bmr', 'tdee']) number(value[key], 0, 100000, key);
  text(value.method, 2000, 'metodo.', true);
  if (!Array.isArray(value.warnings) || value.warnings.length > 50) fail('avvisi.');
  value.warnings.forEach(warning => text(warning, 2000, 'avviso.', true));
}
function day(value, key) {
  keys(value, ['dateKey', 'createdAt', 'updatedAt', 'profileSnapshot', 'targets', 'meals', 'consumed', 'skipped'], 'giorno');
  dateKey(key);
  if (value.dateKey !== key) fail('data non corrispondente.');
  timestamp(value.createdAt); timestamp(value.updatedAt);
  validateProfile(value.profileSnapshot); targets(value.targets);
  if (!Array.isArray(value.meals) || value.meals.length < 1 || value.meals.length > 4) fail('pasti del giorno.');
  value.meals.forEach(meal);
  const ids = value.meals.map(item => item.id);
  if (new Set(ids).size !== ids.length || new Set(value.meals.map(item => item.slot)).size !== value.meals.length) fail('pasti duplicati.');
  object(value.consumed, 'pasti consumati.');
  for (const [id, entry] of Object.entries(value.consumed)) {
    if (!ids.includes(id)) fail('pasto consumato sconosciuto.');
    keys(entry, ['consumedAt', 'meal'], 'registrazione');
    timestamp(entry.consumedAt); meal(entry.meal);
    if (entry.meal.id !== id) fail('registrazione non corrispondente.');
  }
  if (!Array.isArray(value.skipped) || new Set(value.skipped).size !== value.skipped.length ||
      value.skipped.some(id => !ids.includes(id) || value.consumed[id] || value.meals.find(item => item.id === id).slot !== 'preworkout')) fail('spuntini saltati.');
}
export function validateData(data) {
  safeTree(data);
  keys(data, ['schemaVersion', 'profile', 'foodOverrides', 'days'], 'documento');
  if (data.schemaVersion !== SCHEMA_VERSION) fail('versione non supportata.');
  if (data.profile !== null) validateProfile(data.profile);
  object(data.foodOverrides, 'etichette alimentari.');
  if (Object.keys(data.foodOverrides).length > 50) fail('troppe etichette.');
  for (const [id, values] of Object.entries(data.foodOverrides)) {
    text(id, 100, 'alimento personalizzato.'); macros(values);
    if (values.protein > 100 || values.carbs > 100 || values.fat > 100 || values.kcal > 1000) fail('etichetta per 100 g.');
  }
  object(data.days, 'diario.');
  if (Object.keys(data.days).length > 10000) fail('diario troppo grande.');
  for (const [key, value] of Object.entries(data.days)) day(value, key);
  return data;
}
export function parseBackup(json) {
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > MAX_BACKUP_BYTES) fail('file superiore a 5 MB.');
  let data;
  try { data = JSON.parse(json); } catch { fail('il file deve contenere JSON leggibile.'); }
  return validateData(data);
}
export function loadData(storage) {
  try {
    const json = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
    return { data: json ? parseBackup(json) : createEmptyData(), error: null };
  } catch (error) {
    return { data: createEmptyData(), error: new Error(`I dati locali non sono disponibili. ${error.message}`) };
  }
}
export function saveData(data, storage) {
  validateData(data);
  const json = JSON.stringify(data);
  if (new TextEncoder().encode(json).byteLength > MAX_BACKUP_BYTES) throw new Error('Il diario supera 5 MB. Esporta un backup prima di continuare.');
  try { (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, json); }
  catch { throw new Error('Salvataggio non riuscito: spazio esaurito o archiviazione bloccata. Scarica un backup e riprova.'); }
  return data;
}
export function exportBackup(data) {
  validateData(data);
  const pretty = JSON.stringify(data, null, 2);
  return new TextEncoder().encode(pretty).byteLength <= MAX_BACKUP_BYTES ? pretty : JSON.stringify(data);
}
export function clearData(storage) {
  try { (storage ?? globalThis.localStorage).removeItem(STORAGE_KEY); }
  catch { throw new Error('Impossibile cancellare i dati locali: archiviazione bloccata.'); }
  return createEmptyData();
}
