import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivityCsv, suggestActivityColumns, summarizeActivityCsv } from '../src/activity-import.js?v=20261023-activity';

const options = { dateKey: '2026-10-23', dateColumn: 0, typeColumn: 1, idColumn: 2, timeBasis: 'local', timeZone: 'Europe/Rome' };
const summarize = (rows, changes = {}) => summarizeActivityCsv({ headers: ['Date', 'Type', 'ID'], rows }, { ...options, ...changes });

test('CSV parses quoted commas, doubled quotes, BOM and embedded newlines without losing text', () => {
  const source = '\uFEFFActivity Date,Activity Type,Activity ID,Activity Name\r\n"Oct 23, 2026, 6:00:00 AM",Run,1,"Giro, con ""salita""\r\ne ritorno"\r\n';
  const parsed = parseActivityCsv(source);
  assert.deepEqual(parsed.headers, ['Activity Date', 'Activity Type', 'Activity ID', 'Activity Name']);
  assert.deepEqual(parsed.rows, [['Oct 23, 2026, 6:00:00 AM', 'Run', '1', 'Giro, con "salita"\r\ne ritorno']]);
  assert.deepEqual(suggestActivityColumns(parsed.headers), { dateColumn: 0, typeColumn: 1, idColumn: 2 });
  const summary = summarizeActivityCsv(parsed, options);
  assert.deepEqual(summary, { dateKey: '2026-10-23', type: 'run', matchedRows: 1, unknownTypes: [], invalidRows: 0, duplicateRows: 0 });
});

test('CSV accepts semicolons, blank lines and trailing empty cells', () => {
  const parsed = parseActivityCsv('\n\r\nData;Tipo attività;ID;Note\n2026-10-23;Pesi;42;\n2026-10-23;Corsa;43;"a,b"\n\n');
  assert.deepEqual(parsed.rows, [['2026-10-23', 'Pesi', '42', ''], ['2026-10-23', 'Corsa', '43', 'a,b']]);
  assert.deepEqual(suggestActivityColumns(parsed.headers), { dateColumn: 0, typeColumn: 1, idColumn: 2 });
  assert.equal(summarizeActivityCsv(parsed, options).type, 'both');
  assert.deepEqual(parseActivityCsv('Only Header'), { headers: ['Only Header'], rows: [] });
});

test('CSV rejects malformed quoting, inconsistent column counts, binary data and ambiguous delimiters', () => {
  for (const source of ['', '\uFEFF\n\n', 'A,B\n"open,B', 'A,B\na"b,c', 'A,B\n"a"x,c', 'A,B\n"a" ,c', 'A,B\nx', 'A,B\nx,y,z', 'A;B\nx', 'A,B\nx,\0', 'A,B;C\nx,y;z']) {
    assert.throws(() => parseActivityCsv(source), Error, source);
  }
  assert.throws(() => parseActivityCsv(null), /testo/);
  assert.throws(() => parseActivityCsv(new Uint8Array([1, 2])), /testo/);
});

test('CSV applies the 5 MiB UTF-8, 25000-row and 200-column limits', () => {
  assert.throws(() => parseActivityCsv('A\n' + 'é'.repeat(2621440)), /5 MiB/);
  assert.equal(parseActivityCsv('A,B\n' + 'x,y\n'.repeat(25000)).rows.length, 25000);
  assert.throws(() => parseActivityCsv('A,B\n' + 'x,y\n'.repeat(25001)), /25.000/);
  assert.equal(parseActivityCsv(Array.from({ length: 200 }, (_, index) => `c${index}`).join(',')).headers.length, 200);
  assert.throws(() => parseActivityCsv(Array.from({ length: 201 }, (_, index) => `c${index}`).join(',')), /200 colonne/);
});

test('column suggestions use known headers and do not infer type from an activity name', () => {
  assert.deepEqual(suggestActivityColumns(['Activity ID', 'Activity Name', 'Activity Date', 'Activity Type']), { dateColumn: 2, typeColumn: 3, idColumn: 0 });
  assert.deepEqual(suggestActivityColumns(['Data di inizio', 'Tipo attività', 'Identificativo attività']), { dateColumn: 0, typeColumn: 1, idColumn: 2 });
  assert.deepEqual(suggestActivityColumns(['start_date_local', 'sport_type', 'activity_id']), { dateColumn: 0, typeColumn: 1, idColumn: 2 });
  assert.deepEqual(suggestActivityColumns(['Activity Name', 'Title', 'Comment']), { dateColumn: -1, typeColumn: -1, idColumn: -1 });
  assert.deepEqual(suggestActivityColumns([]), { dateColumn: -1, typeColumn: -1, idColumn: -1 });
  assert.throws(() => suggestActivityColumns(Array(3)));
});

test('recognized running and weights aliases are explicit; generic workouts stay unknown', () => {
  for (const name of ['Run', 'Corsa', 'TrailRun', 'VirtualRun', 'trail run', 'virtual run']) assert.equal(summarize([['2026-10-23', name, '1']]).type, 'run', name);
  for (const name of ['WeightTraining', 'Weight Training', 'Allenamento con i pesi', 'Pesi', 'Palestra', 'Strength training']) assert.equal(summarize([['2026-10-23', name, '1']]).type, 'strength', name);
  const summary = summarize([
    ['2026-10-23', 'Workout', '1'], ['2026-10-23', 'Allenamento', '2'],
    ['2026-10-23', 'Yoga', '3'], ['2026-10-23', '', '4'],
    ['2026-10-23', 'Workout', '5'],
  ]);
  assert.equal(summary.type, null);
  assert.equal(summary.matchedRows, 5);
  assert.deepEqual(summary.unknownTypes, ['Workout', 'Allenamento', 'Yoga', '(tipo vuoto)']);
});

test('summary is limited to the selected day and retains unknown-type warnings on partial results', () => {
  const summary = summarize([
    ['2026-10-22', 'WeightTraining', '1'], ['2026-10-23', 'Run', '2'],
    ['2026-10-23', 'WeightTraining', '3'], ['2026-10-23', 'Workout', '4'],
    ['2026-10-24', 'Yoga', '5'], ['not a date', 'Run', '6'],
  ]);
  assert.deepEqual(summary, { dateKey: '2026-10-23', type: 'both', matchedRows: 3, unknownTypes: ['Workout'], invalidRows: 1, duplicateRows: 0 });
  assert.deepEqual(summarize([], {}), { dateKey: '2026-10-23', type: null, matchedRows: 0, unknownTypes: [], invalidRows: 0, duplicateRows: 0 });
  assert.equal(summarize([['2026-10-22', 'Run', '1']]).type, null);
  assert.equal(summarize([['2026-10-23', 'Riposo', '1']]).type, null);
});

test('duplicate nonempty IDs are counted once on the selected day and blank IDs are not deduplicated', () => {
  const summary = summarize([
    ['2026-10-22', 'Run', '1'], ['2026-10-23', 'Run', ' 1 '], ['2026-10-23', 'Run', '1'],
    ['2026-10-23', 'WeightTraining', '2'], ['2026-10-23', 'Run', ''], ['2026-10-23', 'Run', ''],
  ]);
  assert.equal(summary.type, 'both');
  assert.equal(summary.matchedRows, 4);
  assert.equal(summary.duplicateRows, 1);
  const withoutID = summarize([['2026-10-23', 'Run', '1'], ['2026-10-23', 'Run', '1']], { idColumn: -1 });
  assert.equal(withoutID.matchedRows, 2);
  assert.equal(withoutID.duplicateRows, 0);
  assert.equal(withoutID.type, 'run');
});

test('local timestamps keep the calendar date while UTC timestamps convert to Europe/Rome', () => {
  const row = [['2026-07-01T22:30:00', 'Run', '1']];
  assert.equal(summarize(row, { dateKey: '2026-07-01', timeBasis: 'local' }).matchedRows, 1);
  assert.equal(summarize(row, { dateKey: '2026-07-02', timeBasis: 'utc' }).matchedRows, 1);
  assert.equal(summarize([['2026-01-01T23:30:00Z', 'Run', '1']], { dateKey: '2026-01-02', timeBasis: 'local' }).matchedRows, 1);
  assert.equal(summarize([['2026-10-23T00:15:00+03:00', 'Run', '1']], { dateKey: '2026-10-22' }).matchedRows, 1);
  assert.equal(summarize([['2026-10-22T23:15:00-02:00', 'Run', '1']]).matchedRows, 1);
});

test('UTC and offset conversions handle DST, repeated hours and New Year', () => {
  assert.equal(summarize([['2026-03-29T00:30:00Z', 'Run', '1'], ['2026-03-29T01:30:00Z', 'WeightTraining', '2']], { dateKey: '2026-03-29' }).type, 'both');
  const fall = summarize([['2026-10-25T00:30:00Z', 'Run', '1'], ['2026-10-25T01:30:00Z', 'Run', '2']], { dateKey: '2026-10-25' });
  assert.equal(fall.matchedRows, 2);
  assert.equal(fall.duplicateRows, 0);
  assert.equal(summarize([['2026-12-31T23:30:00Z', 'Run', '1']], { dateKey: '2027-01-01' }).matchedRows, 1);
  assert.equal(summarize([['2026-10-23T06:00:00+0200', 'Run', '1']]).matchedRows, 1);
});

test('date parsers accept ISO, explicit day/month/year and English AM/PM without US numeric guessing', () => {
  for (const date of ['2026-10-23', '2026-10-23 06:00', '23/10/2026', '23/10/2026 6:00:00',
    'Oct 23, 2026, 6:00:00 AM', 'Oct 23, 2026,6:00:00 PM', 'Oct 23, 2026 12:00:00 AM']) {
    assert.equal(summarize([[date, 'Run', '1']]).matchedRows, 1, date);
  }
  assert.equal(summarize([['04/05/2026', 'Run', '1']], { dateKey: '2026-05-04' }).matchedRows, 1);
  assert.equal(summarize([['10/23/2026', 'Run', '1']]).invalidRows, 1);
  assert.equal(summarize([['Oct 23, 2026, 11:30:00 PM', 'Run', '1']], { dateKey: '2026-10-24', timeBasis: 'utc' }).matchedRows, 1);
});

test('impossible dates and unsupported date formats are counted as invalid rows', () => {
  const invalid = ['2026-02-29', '2026-04-31', '31/04/2026', '2026-13-01', '2026-10-23T24:00:00Z',
    '2026-10-23T06:60:00', '2026-10-23T06:00:60', '2026-10-23T06:00:00+24:00',
    'Oct 23, 2026, 13:00:00 PM', '23 ottobre 2026', 'October 23, 2026', '1698028800', ''];
  const summary = summarize(invalid.map((date, index) => [date, 'Run', String(index)]));
  assert.equal(summary.invalidRows, invalid.length);
  assert.equal(summary.type, null);
  assert.equal(summarize([['2028-02-29', 'Run', '1']], { dateKey: '2028-02-29' }).matchedRows, 1);
});

test('options require explicit time basis and valid distinct columns', () => {
  const parsed = { headers: ['Date', 'Type', 'ID'], rows: [] };
  for (const changes of [{ timeBasis: undefined }, { timeBasis: 'auto' }, { timeZone: undefined }, { timeZone: 'UTC' },
    { dateColumn: -1 }, { typeColumn: 4 }, { idColumn: 5 }, { idColumn: 0 }, { typeColumn: 0 },
    { idColumn: 1 }, { dateKey: '2026-02-30' }, { dateKey: '10/23/2026' }]) {
    assert.throws(() => summarizeActivityCsv(parsed, { ...options, ...changes }));
  }
  assert.throws(() => summarizeActivityCsv(parsed));
  assert.throws(() => summarizeActivityCsv({ headers: ['Date'], rows: [Array(1)] }, options), /CSV analizzato/);
});

test('summary does not mutate input or include names, heart rate, routes or calorie data', () => {
  const parsed = parseActivityCsv('Date,Type,ID,Name,Calories,Heart Rate\n2026-10-23,Run,1,Private name,500,160');
  const before = structuredClone(parsed);
  const summary = summarizeActivityCsv(parsed, options);
  assert.deepEqual(parsed, before);
  assert.deepEqual(Object.keys(summary), ['dateKey', 'type', 'matchedRows', 'unknownTypes', 'invalidRows', 'duplicateRows']);
  assert.ok(!JSON.stringify(summary).includes('Private name'));
});
