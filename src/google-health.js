const TIME_ZONE = 'Europe/Rome';
const API_ROOT = 'https://health.googleapis.com/v4/users/me/dataTypes/';
const SOURCE_FAMILY = 'users/me/dataSourceFamilies/all-sources';
const MAX_PAGES = 16;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: 'Collega di nuovo Google Health per leggere i dati.',
  ACCESS_DENIED: 'Google Health non ha autorizzato l’accesso a questi dati.',
  ACCOUNT_NOT_LINKED: 'L’account Google non è collegato a Google Health. Completa il collegamento nell’app Google Health.',
  RATE_LIMITED: 'Google Health ha ricevuto troppe richieste. Riprova più tardi.',
  UNAVAILABLE: 'Google Health non è disponibile. Riprova più tardi.',
  INVALID_RESPONSE: 'Google Health ha restituito dati non validi o un intervallo inatteso.',
});

function failure(code, message = ERROR_MESSAGES[code]) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const civilFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, calendar: 'iso8601', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function calendarMillis(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
}

function civilParts(timestamp) {
  return Object.fromEntries(civilFormatter.formatToParts(new Date(timestamp))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function midnightInRome(year, month, day) {
  const target = calendarMillis(year, month, day);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = civilParts(instant);
    const represented = calendarMillis(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    if (represented === target) return instant;
    instant += target - represented;
  }
  throw failure('INVALID_RESPONSE', 'Non è possibile determinare la mezzanotte della data in Europe/Rome.');
}

export function getGoogleHealthRange(dateKey, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getUTCFullYear() < 1 || now.getUTCFullYear() > 9999) {
    throw failure('INVALID_RESPONSE', 'L’istante di lettura non è valido.');
  }
  const match = typeof dateKey === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match || calendarMillis(+match[1], +match[2], +match[3]) === null) {
    throw failure('INVALID_RESPONSE', 'La data richiesta non è valida. Usa una data di calendario nel formato AAAA-MM-GG.');
  }
  const current = civilParts(now.getTime());
  const today = `${String(current.year).padStart(4, '0')}-${String(current.month).padStart(2, '0')}-${String(current.day).padStart(2, '0')}`;
  if (dateKey > today) throw failure('INVALID_RESPONSE', 'Non è possibile leggere le calorie di una data futura.');
  const start = midnightInRome(+match[1], +match[2], +match[3]);
  const next = new Date(calendarMillis(+match[1], +match[2], +match[3]) + 86400000);
  const end = Math.min(Math.floor(now.getTime() / 60000) * 60000,
    midnightInRome(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()));
  if (end < start || end - start > 26 * 3600000) throw failure('INVALID_RESPONSE');
  return { dateKey, timeZone: TIME_ZONE, rangeStart: new Date(start).toISOString(),
    rangeEnd: new Date(end).toISOString(), fetchedAt: now.toISOString() };
}

// Compare nanoseconds, so a response cannot hide an out-of-range fraction through Date truncation.
function timestampNanos(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw failure('INVALID_RESPONSE');
  const milliseconds = calendarMillis(+match[1], +match[2], +match[3], +match[4], +match[5], +match[6]);
  if (milliseconds === null) throw failure('INVALID_RESPONSE');
  let offsetMinutes = 0;
  if (match[8] !== 'Z') {
    const hours = +match[8].slice(1, 3);
    const minutes = +match[8].slice(4, 6);
    if (hours > 23 || minutes > 59) throw failure('INVALID_RESPONSE');
    offsetMinutes = (hours * 60 + minutes) * (match[8][0] === '+' ? 1 : -1);
  }
  return BigInt(milliseconds - offsetMinutes * 60000) * 1000000n + BigInt((match[7] ?? '').padEnd(9, '0'));
}

function readPoint(point, field, start, end) {
  if (!isRecord(point) || Object.keys(point).some(key => !['startTime', 'endTime', field].includes(key))) {
    throw failure('INVALID_RESPONSE');
  }
  const pointStart = timestampNanos(point.startTime);
  const pointEnd = timestampNanos(point.endTime);
  const minute = 60000000000n;
  const expectedEnd = pointStart + minute < end ? pointStart + minute : end;
  if (pointStart < start || pointStart >= end || (pointStart - start) % minute !== 0n || pointEnd !== expectedEnd) throw failure('INVALID_RESPONSE');
  const interval = { key: pointStart.toString(), seconds: Number(pointEnd - pointStart) / 1e9 };
  if (!Object.hasOwn(point, field)) return { ...interval, value: null };
  const metric = point[field];
  if (!isRecord(metric) || Object.keys(metric).some(key => key !== 'kcalSum')) throw failure('INVALID_RESPONSE');
  // The present proto message distinguishes a default scalar zero from an absent metric.
  if (!Object.hasOwn(metric, 'kcalSum')) return { ...interval, value: 0 };
  if (typeof metric.kcalSum !== 'number' || !Number.isFinite(metric.kcalSum) || metric.kcalSum < 0) throw failure('INVALID_RESPONSE');
  return { ...interval, value: metric.kcalSum === 0 ? 0 : metric.kcalSum };
}

function apiFailure(status, body) {
  const details = isRecord(body?.error) && Array.isArray(body.error.details) ? body.error.details : [];
  const accountNotLinked = details.some(detail => isRecord(detail)
    && detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && detail.reason === 'ACCOUNT_NOT_LINKED');
  if (status === 400 && accountNotLinked) return failure('ACCOUNT_NOT_LINKED');
  if (status === 401) return failure('AUTH_REQUIRED');
  if (status === 403) return failure('ACCESS_DENIED');
  if (status === 429) return failure('RATE_LIMITED');
  return failure(status >= 400 && status < 500 && status !== 408 ? 'INVALID_RESPONSE' : 'UNAVAILABLE');
}

async function requestJson(url, accessToken, body, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  timeout.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', redirect: 'error', cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    } catch { throw failure('UNAVAILABLE'); }
    if (!response || !Number.isInteger(response.status) || typeof response.text !== 'function') throw failure('INVALID_RESPONSE');
    if (response.redirected || (response.url && response.url !== url)) throw failure('INVALID_RESPONSE');
    let text;
    try {
      text = await response.text();
    } catch { throw failure('UNAVAILABLE'); }
    let parsed;
    try {
      if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error();
      parsed = JSON.parse(text);
    } catch {
      if (response.status < 200 || response.status >= 300) throw apiFailure(response.status, null);
      throw failure('INVALID_RESPONSE');
    }
    if (response.status < 200 || response.status >= 300) throw apiFailure(response.status, parsed);
    if (!isRecord(parsed)) throw failure('INVALID_RESPONSE');
    return parsed;
  } finally { clearTimeout(timeout); }
}

async function readMetric(dataType, field, range, accessToken, fetchImpl) {
  const body = { range: { startTime: range.rangeStart, endTime: range.rangeEnd },
    windowSize: '60s', pageSize: 2000, dataSourceFamily: SOURCE_FAMILY };
  const start = timestampNanos(range.rangeStart);
  const end = timestampNanos(range.rangeEnd);
  const tokens = new Set();
  const windows = new Map();
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await requestJson(`${API_ROOT}${dataType}/dataPoints:rollUp`, accessToken,
      pageToken === undefined ? body : { ...body, pageToken }, fetchImpl);
    if (Object.keys(result).some(key => !['rollupDataPoints', 'nextPageToken'].includes(key))) throw failure('INVALID_RESPONSE');
    const points = Object.hasOwn(result, 'rollupDataPoints') ? result.rollupDataPoints : [];
    if (!Array.isArray(points) || points.length > 2000) throw failure('INVALID_RESPONSE');
    for (const point of points) {
      const window = readPoint(point, field, start, end);
      if (windows.has(window.key) && windows.get(window.key).value !== window.value) throw failure('INVALID_RESPONSE');
      windows.set(window.key, window);
    }
    if (result.nextPageToken === undefined || result.nextPageToken === '') {
      let sum = 0;
      let correction = 0;
      let seconds = 0;
      for (const window of windows.values()) {
        if (window.value === null) continue;
        const corrected = window.value - correction;
        const nextSum = sum + corrected;
        correction = (nextSum - sum) - corrected;
        sum = nextSum;
        seconds += window.seconds;
        if (!Number.isFinite(sum)) throw failure('INVALID_RESPONSE');
      }
      return { kcal: seconds ? sum : null, seconds };
    }
    if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 16384 || tokens.has(result.nextPageToken)) throw failure('INVALID_RESPONSE');
    tokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  throw failure('INVALID_RESPONSE');
}

function requireToken(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken)) {
    throw failure('AUTH_REQUIRED');
  }
}

export async function verifyGoogleHealthAccount(options = {}) {
  if (!isRecord(options)) throw failure('AUTH_REQUIRED');
  const { accessToken, fetchImpl = globalThis.fetch } = options;
  requireToken(accessToken);
  if (typeof fetchImpl !== 'function') throw failure('UNAVAILABLE');
  const identity = await requestJson('https://health.googleapis.com/v4/users/me/identity', accessToken, undefined, fetchImpl);
  if (typeof identity.healthUserId !== 'string' || !/^[A-Za-z0-9-]{1,63}$/.test(identity.healthUserId)) throw failure('INVALID_RESPONSE');
  return { healthUserId: identity.healthUserId };
}

export async function getGoogleHealthDay(options = {}) {
  if (!isRecord(options)) throw failure('AUTH_REQUIRED');
  const { accessToken, dateKey, now = new Date(), fetchImpl = globalThis.fetch } = options;
  requireToken(accessToken);
  const range = getGoogleHealthRange(dateKey, now);
  if (typeof fetchImpl !== 'function') throw failure('UNAVAILABLE');
  // At midnight no elapsed interval exists. Avoid an API request with start == end.
  const requestedSeconds = (Date.parse(range.rangeEnd) - Date.parse(range.rangeStart)) / 1000;
  if (range.rangeStart === range.rangeEnd) return { source: 'google_health', ...range, totalKcal: null, activeKcal: null,
    coverage: { totalSeconds: 0, activeSeconds: 0, requestedSeconds: 0 } };
  const total = await readMetric('total-calories', 'totalCalories', range, accessToken, fetchImpl);
  const active = await readMetric('active-energy-burned', 'activeEnergyBurned', range, accessToken, fetchImpl);
  return { source: 'google_health', ...range, totalKcal: total.kcal, activeKcal: active.kcal,
    coverage: { totalSeconds: total.seconds, activeSeconds: active.seconds, requestedSeconds } };
}
