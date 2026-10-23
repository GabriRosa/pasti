export const GOOGLE_HEALTH_RECEIPTS_KEY = 'pasti.googleHealthReceipts.v1';
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 5 * 1024 * 1024;
const FIELDS = ['version', 'accountKey', 'mealKey', 'fingerprint', 'status', 'attemptedAt', 'remoteId'];
const clone = value => JSON.parse(JSON.stringify(value));
const MESSAGES = {
  LOCKS_UNAVAILABLE: 'Questo browser non offre il blocco tra schede necessario per inviare i pasti in sicurezza.',
  BUSY: 'Un’altra scheda sta verificando o inviando questo pasto. Attendi e verifica lo stato.',
  RECEIPTS_UNAVAILABLE: 'Le ricevute locali non sono disponibili. Nessun nuovo invio può iniziare.',
  RECEIPTS_INVALID: 'Le ricevute locali non sono leggibili. Non verranno sovrascritte.',
  RECEIPT_CHANGED: 'La ricevuta è cambiata in un’altra operazione. Verifica di nuovo lo stato del pasto.',
  SESSION_CHANGED: 'La sessione, la data o il pasto sono cambiati. Riapri la verifica prima di inviare.',
};
function fail(code) { const error = new Error(MESSAGES[code]); error.code = code; throw error; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function validateKey(value) { if (typeof value !== 'string' || !HASH.test(value)) fail('RECEIPTS_INVALID'); }
export function validateGoogleHealthReceipt(receipt) {
  if (!object(receipt) || Object.keys(receipt).some(key => !FIELDS.includes(key)) || receipt.version !== 1) fail('RECEIPTS_INVALID');
  for (const key of ['accountKey', 'mealKey', 'fingerprint']) validateKey(receipt[key]);
  if (!['pending', 'sent', 'rejected'].includes(receipt.status)) fail('RECEIPTS_INVALID');
  if (typeof receipt.attemptedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(receipt.attemptedAt) || receipt.attemptedAt.length > 40 || !Number.isFinite(Date.parse(receipt.attemptedAt))) fail('RECEIPTS_INVALID');
  if (new Date(`${receipt.attemptedAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== receipt.attemptedAt.slice(0, 10)) fail('RECEIPTS_INVALID');
  if (receipt.remoteId !== undefined && (typeof receipt.remoteId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(receipt.remoteId))) fail('RECEIPTS_INVALID');
  return receipt;
}
const canonical = receipt => receipt === null ? null : JSON.stringify(FIELDS.map(field => receipt[field] ?? null));
async function hash(value, cryptoImpl) {
  if (!cryptoImpl?.subtle) fail('RECEIPTS_UNAVAILABLE');
  const buffer = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function googleHealthAccountKey(clientId, healthUserId, cryptoImpl = globalThis.crypto) {
  if (typeof clientId !== 'string' || !clientId || typeof healthUserId !== 'string' || !/^[A-Za-z0-9-]{1,63}$/.test(healthUserId)) fail('RECEIPTS_INVALID');
  return hash(JSON.stringify([clientId, healthUserId]), cryptoImpl);
}
export async function googleHealthMealKey(dateKey, mealId, cryptoImpl = globalThis.crypto) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || typeof mealId !== 'string' || !mealId || mealId.length > 100) fail('RECEIPTS_INVALID');
  return hash(JSON.stringify([dateKey, mealId]), cryptoImpl);
}

/** Receipt metadata only: no token, raw account identifier, meal or nutrients. */
export function createGoogleHealthReceiptStore({ storage, locks = globalThis.navigator?.locks } = {}) {
  const available = typeof locks?.request === 'function';
  const requireActive = isActive => { if (!isActive()) fail('SESSION_CHANGED'); };
  function load() {
    let text;
    try { text = (storage ?? globalThis.localStorage).getItem(GOOGLE_HEALTH_RECEIPTS_KEY); }
    catch { fail('RECEIPTS_UNAVAILABLE'); }
    if (!text) return { version: 1, receipts: {} };
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('RECEIPTS_INVALID');
    let value;
    try { value = JSON.parse(text); } catch { fail('RECEIPTS_INVALID'); }
    if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'receipts'].includes(key)) || !object(value.receipts)) fail('RECEIPTS_INVALID');
    for (const [key, receipt] of Object.entries(value.receipts)) {
      validateGoogleHealthReceipt(receipt);
      if (key !== `${receipt.accountKey}:${receipt.mealKey}`) fail('RECEIPTS_INVALID');
    }
    return value;
  }
  function read(accountKey, mealKey) {
    validateKey(accountKey); validateKey(mealKey);
    const value = load().receipts[`${accountKey}:${mealKey}`];
    return value ? clone(value) : null;
  }
  async function compareAndSet(next, previous, { isActive = () => true } = {}) {
    if (!available) fail('LOCKS_UNAVAILABLE');
    validateGoogleHealthReceipt(next);
    if (previous !== null) validateGoogleHealthReceipt(previous);
    if (previous && (previous.accountKey !== next.accountKey || previous.mealKey !== next.mealKey)) fail('RECEIPTS_INVALID');
    return locks.request(`${GOOGLE_HEALTH_RECEIPTS_KEY}:document`, { mode: 'exclusive' }, async () => {
      requireActive(isActive);
      const document = load();
      const key = `${next.accountKey}:${next.mealKey}`;
      if (canonical(document.receipts[key] ?? null) !== canonical(previous)) fail('RECEIPT_CHANGED');
      document.receipts[key] = clone(next);
      const text = JSON.stringify(document);
      if (new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('RECEIPTS_UNAVAILABLE');
      requireActive(isActive);
      try { (storage ?? globalThis.localStorage).setItem(GOOGLE_HEALTH_RECEIPTS_KEY, text); }
      catch { fail('RECEIPTS_UNAVAILABLE'); }
      return clone(next);
    });
  }
  async function withMealLock(accountKey, mealKey, task, { isActive = () => true } = {}) {
    if (!available) fail('LOCKS_UNAVAILABLE');
    validateKey(accountKey); validateKey(mealKey);
    return locks.request(`${GOOGLE_HEALTH_RECEIPTS_KEY}:meal:${accountKey}:${mealKey}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) fail('BUSY');
      requireActive(isActive);
      return task();
    });
  }
  function hasForMeal(mealKey) {
    validateKey(mealKey);
    return Object.values(load().receipts).some(receipt => receipt.mealKey === mealKey && ['pending', 'sent'].includes(receipt.status));
  }
  return { available, read, compareAndSet, withMealLock, hasForMeal, hasAny: () => Object.keys(load().receipts).length > 0 };
}
