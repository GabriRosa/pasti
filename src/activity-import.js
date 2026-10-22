const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 25000;
const MAX_COLUMNS = 200;

function headerDelimiters(text) {
  const counts = { ',': 0, ';': 0 };
  let quoted = false;
  let content = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { content += '""'; index++; continue; }
      quoted = !quoted;
    }
    if (!quoted && (char === '\r' || char === '\n')) {
      if (content.trim()) break;
      content = '';
      if (char === '\r' && text[index + 1] === '\n') index++;
      continue;
    }
    content += char;
    if (!quoted && Object.hasOwn(counts, char)) counts[char]++;
  }
  return Object.keys(counts).filter(delimiter => counts[delimiter] > 0);
}

function parseDelimited(text, delimiter) {
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  const endCell = () => {
    row.push(cell);
    if (row.length > MAX_COLUMNS) throw new Error('Il CSV supera il limite di 200 colonne.');
    cell = '';
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (row.some(value => value.trim() !== '')) {
      if (records.length > MAX_ROWS) throw new Error('Il CSV supera il limite di 25.000 righe di dati.');
      if (records.length && row.length !== records[0].length) {
        throw new Error(`La riga CSV ${records.length + 1} ha un numero di colonne diverso dall’intestazione.`);
      }
      records.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else cell += char;
      continue;
    }
    if (closed && char !== delimiter && char !== '\r' && char !== '\n') throw new Error('Il CSV contiene caratteri dopo la chiusura delle virgolette.');
    if (char === delimiter) endCell();
    else if (char === '\r' || char === '\n') {
      endRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (char === '"') {
      if (cell.length) throw new Error('Il CSV contiene virgolette non valide in una cella.');
      quoted = true;
    } else cell += char;
  }
  if (quoted) throw new Error('Il CSV contiene una cella con virgolette non chiuse.');
  if (cell.length || row.length || closed) endRow();
  if (!records.length) throw new Error('Il CSV non contiene un’intestazione leggibile.');
  return { headers: records[0], rows: records.slice(1) };
}

export function parseActivityCsv(text) {
  if (typeof text !== 'string') throw new Error('Il CSV deve essere testo.');
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('Il CSV supera il limite di 5 MiB.');
  if (text.includes('\0')) throw new Error('Il file contiene dati binari, non un CSV di testo.');
  const source = text.replace(/^\uFEFF/, '');
  const delimiters = headerDelimiters(source);
  if (delimiters.length < 2) return parseDelimited(source, delimiters[0] ?? ',');
  const attempts = delimiters.map(delimiter => {
    try { return { result: parseDelimited(source, delimiter) }; }
    catch (error) { return { error }; }
  });
  const valid = attempts.filter(attempt => attempt.result);
  if (!valid.length) throw attempts[0].error;
  if (valid.length === 1) return valid[0].result;
  valid.sort((a, b) => b.result.headers.length - a.result.headers.length);
  if (valid[0].result.headers.length === valid[1].result.headers.length) {
    throw new Error('Il delimitatore CSV è ambiguo: usa virgola o punto e virgola e racchiudi i valori che li contengono tra virgolette.');
  }
  return valid[0].result;
}

const normalized = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function suggestActivityColumns(headers) {
  if (!Array.isArray(headers) || Array.from(headers).some(header => typeof header !== 'string') || headers.length > MAX_COLUMNS) {
    throw new Error('Le intestazioni CSV non sono valide.');
  }
  const names = headers.map(normalized);
  const find = choices => {
    for (const choice of choices) {
      const index = names.indexOf(choice);
      if (index !== -1) return index;
    }
    return -1;
  };
  return {
    dateColumn: find(['activitydate', 'startdatelocal', 'startdateutc', 'startdate', 'datadiinizio', 'datainizio', 'dataattivita', 'dataora', 'datetime', 'starttime', 'date', 'data']),
    typeColumn: find(['activitytype', 'sporttype', 'tipoattivita', 'tipodiattivita', 'type', 'tipo', 'sport', 'disciplina']),
    idColumn: find(['activityid', 'idattivita', 'identificativoattivita', 'id']),
  };
}

function calendarMillis(year, month, day, hour = 0, minute = 0, second = 0, milliseconds = 0) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
}

function dateParts(value) {
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (match) return { year: +match[1], month: +match[2], day: +match[3], hour: +(match[4] ?? 0), minute: +(match[5] ?? 0), second: +(match[6] ?? 0), milliseconds: +(match[7] ?? '').padEnd(3, '0').slice(0, 3), zone: match[8] ?? null };
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (match) return { year: +match[3], month: +match[2], day: +match[1], hour: +(match[4] ?? 0), minute: +(match[5] ?? 0), second: +(match[6] ?? 0), milliseconds: 0, zone: null };
  match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s*(\d{4})(?:(?:,\s*|\s+)(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM))?$/i.exec(text);
  if (!match) return null;
  const hour = +(match[4] ?? 0);
  if (match[4] && (hour < 1 || hour > 12)) return null;
  return { year: +match[3], month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[1].toLowerCase()) + 1,
    day: +match[2], hour: match[4] ? hour % 12 + (match[7].toLowerCase() === 'pm' ? 12 : 0) : 0,
    minute: +(match[5] ?? 0), second: +(match[6] ?? 0), milliseconds: 0, zone: null };
}

function rowDate(value, timeBasis, formatter) {
  const parts = dateParts(value);
  if (!parts) return null;
  const timestamp = calendarMillis(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.milliseconds);
  if (timestamp === null) return null;
  if (!parts.zone && timeBasis === 'local') {
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }
  let offset = 0;
  if (parts.zone && parts.zone !== 'Z') {
    const zone = /^([+-])(\d{2}):?(\d{2})$/.exec(parts.zone);
    if (!zone || +zone[2] > 23 || +zone[3] > 59) return null;
    offset = (+zone[2] * 60 + +zone[3]) * (zone[1] === '+' ? 1 : -1);
  }
  const instant = new Date(timestamp - offset * 60000);
  if (instant.getUTCFullYear() < 1 || instant.getUTCFullYear() > 9999) return null;
  const fields = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`;
}

function activityType(value) {
  const name = normalized(value);
  if (['run', 'corsa', 'trailrun', 'virtualrun'].includes(name)) return 'run';
  if (['weighttraining', 'allenamentoconipesi', 'pesi', 'palestra', 'strengthtraining'].includes(name)) return 'strength';
  return null;
}

export function summarizeActivityCsv(parsed, options) {
  if (!parsed || !Array.isArray(parsed.headers) || !parsed.headers.length || parsed.headers.length > MAX_COLUMNS
    || Array.from(parsed.headers).some(value => typeof value !== 'string') || !Array.isArray(parsed.rows) || parsed.rows.length > MAX_ROWS
    || Array.from(parsed.rows).some(row => !Array.isArray(row) || row.length !== parsed.headers.length || Array.from(row).some(value => typeof value !== 'string'))) {
    throw new Error('Il contenuto CSV analizzato non è valido.');
  }
  if (!options || !['local', 'utc'].includes(options.timeBasis) || options.timeZone !== 'Europe/Rome') {
    throw new Error('Scegli il riferimento degli orari: UTC oppure ora locale italiana (Europe/Rome).');
  }
  const { dateKey, dateColumn, typeColumn, idColumn } = options;
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !dateParts(dateKey)
    || calendarMillis(+dateKey.slice(0, 4), +dateKey.slice(5, 7), +dateKey.slice(8, 10)) === null) {
    throw new Error('La data selezionata per l’importazione non è valida.');
  }
  const validIndex = value => Number.isInteger(value) && value >= 0 && value < parsed.headers.length;
  if (!validIndex(dateColumn) || !validIndex(typeColumn) || !(idColumn === -1 || validIndex(idColumn))
    || dateColumn === typeColumn || (idColumn !== -1 && [dateColumn, typeColumn].includes(idColumn))) {
    throw new Error('Seleziona colonne distinte e valide per data, tipo di attività ed eventuale ID.');
  }
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'iso8601', numberingSystem: 'latn' });
  const seen = new Set();
  const types = new Set();
  const unknown = new Set();
  let matchedRows = 0;
  let invalidRows = 0;
  let duplicateRows = 0;
  for (const row of parsed.rows) {
    const date = rowDate(row[dateColumn], options.timeBasis, formatter);
    if (!date) { invalidRows++; continue; }
    if (date !== dateKey) continue;
    const id = idColumn === -1 ? '' : row[idColumn].trim();
    if (id && seen.has(id)) { duplicateRows++; continue; }
    if (id) seen.add(id);
    matchedRows++;
    const type = activityType(row[typeColumn]);
    if (type) types.add(type);
    else unknown.add(row[typeColumn].trim() || '(tipo vuoto)');
  }
  return { dateKey, type: types.size === 2 ? 'both' : types.size === 1 ? [...types][0] : null,
    matchedRows, unknownTypes: [...unknown], invalidRows, duplicateRows };
}
