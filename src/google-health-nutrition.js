const ROOT = 'https://health.googleapis.com/v4/';
const COLLECTION = 'users/me/dataTypes/nutrition-log/dataPoints';
const SELF = 'users/me/dataSourceFamilies/self-sources';
const PAGE_SIZE = 1000;
const PAGE_LIMIT = 16;
const BODY_LIMIT = 2 * 1024 * 1024;
const activeWrites = new Set();
const MESSAGES = Object.freeze({
  AUTH_REQUIRED: 'Ricollega Google Health per inviare i pasti.',
  ACCESS_DENIED: 'Google Health non ha autorizzato l’accesso ai pasti.',
  ACCOUNT_NOT_LINKED: 'Questo account non è collegato a Google Health.',
  ACCOUNT_CHANGED: 'La ricevuta appartiene a un altro account o client Google. Ricollega quello originale.',
  RATE_LIMITED: 'Google Health ha limitato le richieste. Riprova più tardi.',
  UNAVAILABLE: 'Google Health non è raggiungibile. Controlla lo stato prima di riprovare l’invio.',
  INVALID_RESPONSE: 'La risposta di Google Health non permette di verificare il pasto.',
  INVALID_INPUT: 'Il pasto consumato o i dati di invio non sono validi.',
  TIME_REQUIRED: 'L’orario salvato è ambiguo o inesistente in Europe/Rome. Specifica un istante di consumo valido.',
  LOCAL_STATE_ERROR: 'La ricevuta di invio non è stata salvata. Conserva lo stato prima di continuare.',
  BUSY: 'È già in corso una verifica o un invio per questo pasto.',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
function failure(code) { const error = new Error(MESSAGES[code]); error.code = code; return error; }
const safeError = error => ({ code: own(MESSAGES, error?.code) ? error.code : 'UNAVAILABLE',
  message: MESSAGES[own(MESSAGES, error?.code) ? error.code : 'UNAVAILABLE'] });
const civil = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', calendar: 'iso8601', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function parts(milliseconds) {
  return Object.fromEntries(civil.formatToParts(new Date(milliseconds)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
}
function calendar(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year < 1900 || year > 2101 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) throw failure('INVALID_INPUT');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw failure('INVALID_INPUT');
  return date.getTime();
}
function instant(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || /[1-9]/.test((match[7] ?? '').slice(3))) throw failure('INVALID_INPUT');
  let offset = 0;
  if (match[8] !== 'Z') {
    const h = +match[8].slice(1, 3), m = +match[8].slice(4, 6);
    if (h > 23 || m > 59) throw failure('INVALID_INPUT');
    offset = (h * 60 + m) * (match[8][0] === '+' ? 1 : -1);
  }
  return calendar(+match[1], +match[2], +match[3], +match[4], +match[5], +match[6])
    + +(match[7] ?? '').padEnd(3, '0').slice(0, 3) - offset * 60000;
}
function dateOf(milliseconds) {
  const p = parts(milliseconds);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function offsetAt(milliseconds) {
  const p = parts(milliseconds);
  return calendar(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(milliseconds / 1000) * 1000;
}
function localInstant(dateKey, time) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const clock = typeof time === 'string' && /^(\d{2}):(\d{2})$/.exec(time);
  if (!date || !clock) throw failure('TIME_REQUIRED');
  const target = calendar(+date[1], +date[2], +date[3], +clock[1], +clock[2]);
  const offsets = new Set([-86400000, 0, 86400000].map(delta => offsetAt(target + delta)));
  const matches = [...offsets].map(offset => target - offset).filter(candidate => {
    const p = parts(candidate);
    return calendar(p.year, p.month, p.day, p.hour, p.minute, p.second) === target;
  });
  if (matches.length !== 1) throw failure('TIME_REQUIRED');
  return matches[0];
}
async function digest(value) {
  if (!globalThis.crypto?.subtle) throw failure('UNAVAILABLE');
  try {
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { throw failure('UNAVAILABLE'); }
}
function clock(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure('INVALID_INPUT');
  return new Date(now.getTime());
}
function validText(value, length) { return typeof value === 'string' && value.trim().length > 0 && value.length <= length && !/[\x00-\x1f\x7f]/.test(value); }

export async function prepareGoogleHealthConsumedMeal(options = {}) {
  if (!record(options)) throw failure('INVALID_INPUT');
  const { dateKey, consumed, occurredAt, now = new Date() } = options;
  const current = clock(now);
  const date = typeof dateKey === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!date) throw failure('INVALID_INPUT');
  calendar(+date[1], +date[2], +date[3]);
  if (dateKey > dateOf(current.getTime()) || !record(consumed) || !own(consumed, 'consumedAt') || !record(consumed.meal)) throw failure('INVALID_INPUT');
  const recordedTime = instant(consumed.consumedAt);
  if (recordedTime > current.getTime()) throw failure('INVALID_INPUT');
  const meal = consumed.meal;
  const mealType = { preworkout: 'SNACK', breakfast: 'BREAKFAST', lunch: 'LUNCH', dinner: 'DINNER' }[meal.slot];
  if (typeof mealType !== 'string' || !validText(meal.id, 100) || !validText(meal.title, 300) || !record(meal.macros)) throw failure('INVALID_INPUT');
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) {
    if (typeof meal.macros[key] !== 'number' || !Number.isFinite(meal.macros[key]) || meal.macros[key] < 0 || meal.macros[key] > 100000) throw failure('INVALID_INPUT');
  }
  const time = occurredAt !== undefined ? instant(occurredAt)
    : dateOf(recordedTime) === dateKey ? recordedTime : localInstant(dateKey, meal.time);
  if (time > current.getTime() || dateOf(time) !== dateKey) throw failure('INVALID_INPUT');
  // A one-second bookkeeping interval, not a measured meal duration; keep it in the diary day.
  const start = Math.max(time - 1000, localInstant(dateKey, '00:00'));
  const end = start + 1000;
  if (end > current.getTime()) throw failure('INVALID_INPUT');
  const startStamp = new Date(start).toISOString(), endStamp = new Date(end).toISOString();
  const body = { nutritionLog: {
    interval: { startTime: startStamp, endTime: endStamp,
      startUtcOffset: `${offsetAt(start) / 1000}s`, endUtcOffset: `${offsetAt(end) / 1000}s` },
    foodDisplayName: meal.title.trim(), mealType, energy: { kcal: meal.macros.kcal },
    totalCarbohydrate: { grams: meal.macros.carbs }, totalFat: { grams: meal.macros.fat },
    nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: meal.macros.protein } }], serving: { amount: 1 },
  } };
  return { mealKey: await digest(JSON.stringify([dateKey, meal.id])), fingerprint: await digest(JSON.stringify(body)), body };
}

function requireCredentials(accessToken, clientId) {
  if (typeof accessToken !== 'string' || accessToken.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken)) throw failure('AUTH_REQUIRED');
  if (!validText(clientId, 300) || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw failure('INVALID_INPUT');
}
function classify(status, body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  if (status === 400 && details.some(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && item.reason === 'ACCOUNT_NOT_LINKED')) return 'ACCOUNT_NOT_LINKED';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 429) return 'RATE_LIMITED';
  return status >= 400 && status < 500 && status !== 408 && status !== 409 ? 'INVALID_RESPONSE' : 'UNAVAILABLE';
}
async function request(path, { accessToken, fetchImpl }, body) {
  const url = ROOT + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000); timer.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    } catch { throw failure('UNAVAILABLE'); }
    if (!response || !Number.isInteger(response.status) || typeof response.text !== 'function'
      || response.redirected || (response.url && response.url !== url)) throw failure('INVALID_RESPONSE');
    let value;
    try {
      const text = await response.text();
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > BODY_LIMIT) throw new Error();
      value = JSON.parse(text);
    } catch { if (response.status >= 200 && response.status < 300) throw failure('INVALID_RESPONSE'); }
    if (response.status < 200 || response.status >= 300) {
      const error = failure(classify(response.status, value));
      error.httpStatus = response.status;
      throw error;
    }
    if (!record(value)) throw failure('INVALID_RESPONSE');
    return value;
  } finally { clearTimeout(timer); }
}
function remoteId(point, accountId) {
  const match = typeof point?.name === 'string' && /^users\/([A-Za-z0-9-]{1,63})\/dataTypes\/nutrition-log\/dataPoints\/([A-Za-z0-9-]{1,128})$/.exec(point.name);
  if (!match || ![accountId, 'me'].includes(match[1])) throw failure('INVALID_RESPONSE');
  return match[2];
}
function ownedPoint(point, context) {
  const id = remoteId(point, context.accountId);
  if (point.dataSource?.application?.googleWebClientId !== context.clientId || !record(point.nutritionLog)) throw failure('INVALID_RESPONSE');
  return id;
}
const numberEqual = (a, b) => typeof a === 'number' && Number.isFinite(a) && a >= 0 && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
function quantity(value, key) {
  if (!record(value)) return null;
  return own(value, key) ? value[key] : 0;
}
function samePoint(point, expected) {
  const log = point.nutritionLog, target = expected.nutritionLog;
  let start, end;
  try { start = instant(log?.interval?.startTime); end = instant(log?.interval?.endTime); } catch { return false; }
  const proteins = Array.isArray(log.nutrients) ? log.nutrients.filter(item => item?.nutrient === 'PROTEIN') : [];
  return start === instant(target.interval.startTime) && end === instant(target.interval.endTime)
    && log.foodDisplayName === target.foodDisplayName && log.mealType === target.mealType
    && numberEqual(quantity(log.energy, 'kcal'), target.energy.kcal)
    && numberEqual(quantity(log.totalCarbohydrate, 'grams'), target.totalCarbohydrate.grams)
    && numberEqual(quantity(log.totalFat, 'grams'), target.totalFat.grams)
    && proteins.length === 1 && numberEqual(quantity(proteins[0].quantity, 'grams'), target.nutrients[0].quantity.grams)
    && numberEqual(quantity(log.serving, 'amount'), 1) && !log.food;
}
function relatedPoint(point, expected) {
  try { return instant(point.nutritionLog?.interval?.startTime) === instant(expected.nutritionLog.interval.startTime)
    && (point.nutritionLog.foodDisplayName === expected.nutritionLog.foodDisplayName || point.nutritionLog.mealType === expected.nutritionLog.mealType); }
  catch { return false; }
}
async function findOwn(prepared, context, receipt) {
  if (receipt?.remoteId) {
    let point;
    try { point = await request(`${COLLECTION}/${receipt.remoteId}`, context); }
    catch (error) { if (error.httpStatus === 404) return { status: 'not_found' }; throw error; }
    const id = ownedPoint(point, context);
    return { status: samePoint(point, prepared.body) ? 'existing' : 'changed', remoteId: id };
  }
  const matches = new Map(), related = new Set(), pageTokens = new Set();
  let pageToken;
  // No undocumented nutrition-specific time filter: search the capped, paginated self-sources collection.
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), dataSourceFamily: SELF });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await request(`${COLLECTION}?${params}`, context);
    const points = own(result, 'dataPoints') ? result.dataPoints : [];
    if (!Array.isArray(points) || points.length > PAGE_SIZE) throw failure('INVALID_RESPONSE');
    for (const point of points) {
      const id = ownedPoint(point, context);
      if (samePoint(point, prepared.body)) matches.set(id, point);
      else if (relatedPoint(point, prepared.body)) related.add(id);
    }
    if (result.nextPageToken === undefined || result.nextPageToken === '') {
      if (matches.size > 1 || (matches.size && related.size)) return { status: 'conflict' };
      if (matches.size === 1) return { status: 'existing', remoteId: [...matches.keys()][0] };
      return { status: related.size ? 'changed' : 'not_found' };
    }
    if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 16384 || pageTokens.has(result.nextPageToken)) throw failure('INVALID_RESPONSE');
    pageTokens.add(result.nextPageToken); pageToken = result.nextPageToken;
  }
  throw failure('INVALID_RESPONSE');
}
function validateReceipt(receipt) {
  if (receipt === null || receipt === undefined) return null;
  if (!record(receipt) || Object.keys(receipt).some(key => !['version', 'accountKey', 'mealKey', 'fingerprint', 'status', 'attemptedAt', 'remoteId'].includes(key))
    || receipt.version !== 1 || !['pending', 'sent', 'rejected'].includes(receipt.status)
    || ['accountKey', 'mealKey', 'fingerprint'].some(key => typeof receipt[key] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt[key]))
    || (receipt.remoteId !== undefined && (typeof receipt.remoteId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(receipt.remoteId)))) throw failure('INVALID_INPUT');
  instant(receipt.attemptedAt);
  return clone(receipt);
}
async function storeReceipt(callback, receipt, previous, required = false) {
  if (typeof callback !== 'function') { if (required) throw failure('LOCAL_STATE_ERROR'); return false; }
  try { await callback(clone(receipt), previous ? clone(previous) : null); return true; }
  catch { throw failure('LOCAL_STATE_ERROR'); }
}
function operationError(error) {
  const http = { 3: 400, 5: 404, 6: 409, 7: 403, 8: 429, 16: 401 }[error?.code] ?? 500;
  return safeError(failure(classify(http, { error })));
}

async function accountContext(accessToken, clientId, fetchImpl) {
  const identity = await request('users/me/identity', { accessToken, fetchImpl });
  if (typeof identity.healthUserId !== 'string' || !/^[A-Za-z0-9-]{1,63}$/.test(identity.healthUserId)) throw failure('INVALID_RESPONSE');
  return { accountId: identity.healthUserId, accountKey: await digest(JSON.stringify([clientId, identity.healthUserId])) };
}

export async function getGoogleHealthNutritionAccountKey(options = {}) {
  if (!record(options)) throw failure('INVALID_INPUT');
  const { accessToken, clientId, fetchImpl = globalThis.fetch } = options;
  requireCredentials(accessToken, clientId);
  if (typeof fetchImpl !== 'function') throw failure('INVALID_INPUT');
  return (await accountContext(accessToken, clientId, fetchImpl)).accountKey;
}

export async function syncGoogleHealthConsumedMeal(options = {}) {
  if (!record(options)) throw failure('INVALID_INPUT');
  const { accessToken, clientId, dateKey, consumed, occurredAt, allowCreate = false, recordReceipt,
    fetchImpl = globalThis.fetch, now = new Date() } = options;
  requireCredentials(accessToken, clientId);
  if (typeof fetchImpl !== 'function' || typeof allowCreate !== 'boolean') throw failure('INVALID_INPUT');
  const prepared = await prepareGoogleHealthConsumedMeal({ dateKey, consumed, occurredAt, now });
  const previous = validateReceipt(options.receipt);
  const { accountId, accountKey } = await accountContext(accessToken, clientId, fetchImpl);
  if (previous && previous.accountKey !== accountKey) throw failure('ACCOUNT_CHANGED');
  if (previous && previous.mealKey !== prepared.mealKey) throw failure('INVALID_INPUT');
  if (previous && previous.fingerprint !== prepared.fingerprint) return { status: 'changed', receipt: previous };
  const lock = accountKey + prepared.mealKey;
  if (activeWrites.has(lock)) throw failure('BUSY');
  activeWrites.add(lock);
  const context = { accessToken, fetchImpl, clientId, accountId };
  const receipt = { version: 1, accountKey, mealKey: prepared.mealKey, fingerprint: prepared.fingerprint,
    status: 'pending', attemptedAt: previous?.attemptedAt ?? clock(now).toISOString() };
  let storedPrevious = previous;
  const finish = async (status, next, error) => {
    let safe = error;
    if (next) {
      try { await storeReceipt(recordReceipt, next, storedPrevious); }
      catch (storageError) { safe = safeError(storageError); }
    }
    return { status, receipt: next ?? previous, ...(safe ? { error: safe } : {}) };
  };
  try {
    const found = await findOwn(prepared, context, previous);
    if (found.status === 'existing') return await finish('existing', { ...receipt, status: 'sent', remoteId: found.remoteId });
    if (found.status !== 'not_found') return { status: found.status, receipt: previous };
    if (previous && previous.status !== 'rejected') return { status: 'pending', receipt: previous };
    if (!allowCreate) return { status: 'not_found', receipt: previous };
    await storeReceipt(recordReceipt, receipt, previous, true);
    storedPrevious = receipt;
    let operation;
    try { operation = await request(COLLECTION, context, prepared.body); }
    catch (error) {
      const rejected = error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus);
      return await finish(rejected ? 'rejected' : 'pending', { ...receipt, status: rejected ? 'rejected' : 'pending' }, safeError(error));
    }
    if (operation.done === true && record(operation.error) && !operation.response) {
      const rejected = [3, 5, 7, 8, 16].includes(operation.error.code);
      return await finish(rejected ? 'rejected' : 'pending', { ...receipt, status: rejected ? 'rejected' : 'pending' }, operationError(operation.error));
    }
    if (operation.done === true && record(operation.response) && !operation.error) {
      try {
        const point = operation.response;
        const id = ownedPoint(point, context);
        if (!samePoint(point, prepared.body)) throw failure('INVALID_RESPONSE');
        return await finish('uploaded', { ...receipt, status: 'sent', remoteId: id });
      } catch (error) { return await finish('pending', receipt, safeError(error)); }
    }
    return await finish('pending', receipt);
  } finally { activeWrites.delete(lock); }
}
