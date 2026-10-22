import { ACTIVITY_LEVELS, calculateTargets, sumMacros } from './src/nutrition.js?v=20261023-activity';
import { FOODS, LIDL_FOOD_IDS, getFood } from './src/foods.js?v=20261023-activity';
import { createDayPlan, mealFromIngredients, mealAlternatives, swapMealFood } from './src/planner.js?v=20261023-activity';
import { trainingForDate, validateTrainingPlan, TRAINING_LOG_TYPES, validateTrainingLog, trainingLogLabel } from './src/training.js?v=20261023-activity';
import { parseActivityCsv, suggestActivityColumns, summarizeActivityCsv } from './src/activity-import.js?v=20261023-activity';
import { STORAGE_KEY, MAX_BACKUP_BYTES, createEmptyData, validateData, parseBackup, loadData, saveData, exportBackup, clearData } from './src/storage.js?v=20261023-activity';

const $ = selector => document.querySelector(selector);
const clone = value => JSON.parse(JSON.stringify(value));
const round = value => Math.round(value).toLocaleString('it-IT');
const formatDecimal = value => Number(value.toFixed(1)).toLocaleString('it-IT');
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const longDate = key => new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${key}T12:00:00`));
const CARBS = ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl', 'lentil-pasta-lidl-fresh'];
const PROTEINS = ['chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin'];
const DAYS = [{ value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mer' }, { value: 4, label: 'Gio' }, { value: 5, label: 'Ven' }, { value: 6, label: 'Sab' }, { value: 0, label: 'Dom' }];
const TRAINING_TYPES = [{ id: 'rest', label: 'Riposo' }, { id: 'run', label: 'Corsa' }, { id: 'strength', label: 'Sala attrezzi' }];
const loaded = loadData();
let data = loaded.data;
let storageReadError = loaded.error;
let unsaved = false;
let storageConflict = false;
let selectedDate = localDate();
let page = 'today';
let labelFoodId = 'lentil-pasta-lidl';
let toastTimer;
let returnFocus;

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (['checked', 'disabled', 'selected', 'hidden', 'required'].includes(key)) node[key] = Boolean(value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function button(label, action, classes = 'button secondary', attrs = {}) {
  return h('button', { type: 'button', class: classes, onclick: action, ...attrs }, label);
}

function notify(message, error = false) {
  const host = $('#notifications');
  host.replaceChildren(h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, message));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.replaceChildren(), error ? 12000 : 5000);
}

function persist(next) {
  if (storageReadError) throw new Error('Prima recupera o cancella i dati locali dalla sezione Profilo.');
  if (storageConflict) throw new Error('I dati sono cambiati in un’altra scheda. Scarica un backup delle modifiche e ricarica la pagina prima di salvare.');
  validateData(next);
  data = next;
  try { saveData(data); unsaved = false; }
  catch (error) { unsaved = true; notify(error.message, true); }
}

function getDay() {
  if (!data.profile) return null;
  if (!data.days[selectedDate]) {
    const now = new Date().toISOString();
    const targets = calculateTargets(data.profile);
    const next = clone(data);
    next.days[selectedDate] = {
      dateKey: selectedDate, createdAt: now, updatedAt: now,
      profileSnapshot: clone(data.profile), targets,
      meals: createDayPlan(data.profile, targets, selectedDate, data.foodOverrides),
      consumed: {}, skipped: [],
    };
    persist(next);
  }
  return data.days[selectedDate];
}

function updateDay(action) {
  try {
    const next = clone(data);
    const day = next.days[selectedDate];
    action(day);
    day.updatedAt = new Date().toISOString();
    persist(next);
    render();
    return true;
  } catch (error) { notify(error.message, true); return false; }
}

function pageTitle(eyebrow, title, description, actions) {
  return h('div', { class: 'page-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, eyebrow), h('h1', {}, title), description && h('p', { class: 'page-description' }, description)), actions);
}

function storageNotice() {
  if (storageReadError) return h('section', { class: 'notice danger', role: 'alert' },
    h('strong', {}, 'I dati locali non sono leggibili.'),
    h('p', {}, 'Il contenuto originale è ancora nel browser. Per evitare sovrascritture, recupera un backup oppure cancella i dati dalla sezione Profilo.'),
    button('Gestisci i dati', () => { location.hash = 'profile'; }));
  if (storageConflict) return h('section', { class: 'notice danger', role: 'alert' },
    h('strong', {}, 'I dati sono cambiati in un’altra scheda.'),
    h('p', {}, 'Il salvataggio è sospeso per evitare di sovrascrivere l’altra scheda. Puoi scaricare questa versione del diario prima di ricaricare.'),
    button('Scarica questa versione', downloadBackup), button('Ricarica', () => location.reload()));
  if (unsaved) return h('section', { class: 'notice danger', role: 'alert' },
    h('strong', {}, 'Ci sono modifiche non salvate.'),
    h('p', {}, 'Il browser non permette il salvataggio. Esporta ora un backup: chiudendo o ricaricando questa pagina potresti perdere le modifiche.'),
    button('Scarica backup', downloadBackup), button('Riprova salvataggio', () => { try { saveData(data); unsaved = false; render(); notify('Dati salvati.'); } catch (error) { notify(error.message, true); } }));
  return null;
}

function render() {
  const hash = location.hash.slice(1);
  page = ['today', 'profile', 'foods', 'method'].includes(hash) ? hash : 'today';
  document.querySelectorAll('[data-page]').forEach(link => {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const main = $('#main');
  try {
    const content = page === 'profile' ? renderProfile() : page === 'foods' ? renderFoods() : page === 'method' ? renderMethod() : renderToday();
    main.replaceChildren(storageNotice() || document.createDocumentFragment(), content);
    document.title = `${({ today: 'Oggi', profile: 'Profilo', foods: 'Alimenti', method: 'Metodo' })[page]} · Pasti`;
  } catch (error) {
    main.replaceChildren(storageNotice() || document.createDocumentFragment(), h('section', { class: 'empty-state panel' },
      h('h1', {}, 'Controlliamo i tuoi dati'), h('p', {}, error.message), button('Apri il profilo', () => { location.hash = 'profile'; })));
  }
}

function shiftDate(delta) {
  const date = new Date(`${selectedDate}T12:00:00`);
  date.setDate(date.getDate() + delta);
  const candidate = localDate(date);
  if (candidate < '1900-01-01' || candidate > '2100-12-31') return;
  selectedDate = candidate;
  render();
}

function goToMeals() {
  const heading = $('#daily-meals-title');
  if (!heading) return;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

function recordTraining(type) {
  if (selectedDate > localDate()) { notify('Puoi registrare un’attività solo per oggi o per un giorno passato.', true); return; }
  const previous = data.days[selectedDate]?.trainingLog;
  if (previous?.type === type || (type === undefined && previous === undefined)) return;
  const log = type === undefined ? undefined : { type, source: 'manual', recordedAt: new Date().toISOString() };
  try { validateTrainingLog(log); } catch (error) { notify(error.message, true); return; }
  const updated = updateDay(day => {
    if (log === undefined) delete day.trainingLog;
    else day.trainingLog = log;
  });
  if (updated) {
    $('#training-log-title')?.focus({ preventScroll: true });
    if (!unsaved) notify(log ? `Attività registrata: ${trainingLogLabel(log)}.` : 'Registrazione dell’attività annullata.');
  }
}

function renderTrainingLog(day, planned) {
  const future = day.dateKey > localDate();
  const label = trainingLogLabel(day.trainingLog);
  return h('section', { class: 'panel training-log-card', 'aria-labelledby': 'training-log-title' },
    h('div', { class: 'training-log-heading' }, h('div', {}, h('h2', { id: 'training-log-title', tabindex: '-1' }, 'Attività svolta'),
      h('p', { class: 'planned-training' }, `Previsto: ${planned.label}${planned.time ? ` alle ${planned.time}` : ''}`)),
      h('p', { class: `training-log-status${label ? ' recorded' : ''}`, role: 'status' }, label ? `Registrato: ${label}${day.trainingLog.source === 'strava_csv' ? ' · CSV Strava' : ''}` : 'Non ancora registrato')),
    h('div', { class: 'training-log-choices', role: 'group', 'aria-label': 'Scegli l’attività effettivamente svolta' },
      ...TRAINING_LOG_TYPES.map(type => button(type.label, () => recordTraining(type.id), 'training-log-choice', {
        'aria-pressed': day.trainingLog?.type === type.id, 'data-training-type': type.id, disabled: future,
      }))),
    h('div', { class: 'training-log-footer' }, h('p', { class: 'helper' }, future
      ? 'Potrai registrare l’attività da questa data. Il programma è soltanto una previsione.'
      : 'Il consumo totale medio comprende già gli allenamenti. Questa registrazione non aggiunge altre calorie.'),
      day.trainingLog && button('Annulla registrazione attività', () => recordTraining(undefined), 'text-button', { disabled: future })),
    h('div', { class: 'training-log-import' }, button('Importa attività da CSV', openActivityCsvImport, 'button secondary small', { disabled: future }), h('span', {}, 'File locale, senza sincronizzazione automatica.')));
}

function openActivityCsvImport() {
  const dateKey = selectedDate;
  if (dateKey > localDate() || !data.days[dateKey]) { notify('Apri un giorno passato o quello di oggi prima di importare.', true); return; }
  const originalLog = JSON.stringify(data.days[dateKey].trainingLog ?? null);
  let parsed = null;
  let summary = null;
  let readVersion = 0;
  let dateColumn;
  let typeColumn;
  let idColumn;
  const container = h('div', { class: 'dialog-content csv-import-panel', id: 'csv-import-panel' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const fileStatus = h('p', { class: 'helper' });
  const mapping = h('div', { class: 'csv-mapping', hidden: true });
  const preview = h('div', { class: 'csv-preview', 'aria-live': 'polite' });
  const explicitType = h('select', { name: 'csvExplicitType', onchange: () => renderPreview() },
    h('option', { value: '' }, 'Scegli dopo aver controllato il giorno…'),
    ...TRAINING_LOG_TYPES.map(type => h('option', { value: type.id }, type.label)));
  const explicitField = field('Attività effettivamente svolta in questa data', explicitType);
  explicitField.hidden = true;
  const timeBasis = h('select', { name: 'csvTimeBasis', required: true, onchange: () => updateSummary() },
    h('option', { value: '' }, 'Scegli come interpretare le date…'),
    h('option', { value: 'local' }, 'Ora locale italiana (Europe/Rome)'),
    h('option', { value: 'utc' }, 'UTC, da convertire in ora italiana'));
  const typeLabel = type => TRAINING_LOG_TYPES.find(item => item.id === type)?.label;
  const needsChoice = () => !summary || summary.invalidRows > 0 || summary.unknownTypes.length > 0 || summary.type === null;
  const selectedType = () => needsChoice() ? explicitType.value : summary.type;
  const submit = button('Controlla prima l’anteprima', () => {
    try {
      if (!summary || !typeLabel(selectedType())) throw new Error('Controlla l’anteprima e scegli un’attività quando richiesta.');
      if (selectedDate !== dateKey) throw new Error('La data selezionata è cambiata. Chiudi e riapri l’importazione per il giorno corretto.');
      if (dateKey > localDate()) throw new Error('Le attività future non possono essere registrate.');
      if (storageConflict || storageReadError) throw new Error('I dati locali sono cambiati o non sono disponibili. Ricarica prima di importare.');
      if (!data.days[dateKey] || JSON.stringify(data.days[dateKey].trainingLog ?? null) !== originalLog) throw new Error('La registrazione del giorno è cambiata. Chiudi e riapri l’anteprima.');
      const log = { type: selectedType(), source: 'strava_csv', recordedAt: new Date().toISOString() };
      validateTrainingLog(log);
      const next = clone(data);
      next.days[dateKey].trainingLog = log;
      next.days[dateKey].updatedAt = log.recordedAt;
      persist(next);
      closeDialog(); render();
      if (!unsaved) notify(`Registrato da CSV Strava: ${typeLabel(log.type)} per ${dateKey}.`);
    } catch (failure) { error.textContent = failure.message; }
  }, 'button primary', { disabled: true });
  function renderPreview() {
    preview.replaceChildren();
    explicitField.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Controlla prima l’anteprima';
    if (!summary) return;
    const ambiguous = needsChoice();
    preview.append(h('h3', {}, `Riepilogo del ${dateKey}`),
      h('dl', { class: 'csv-counts' },
        h('div', {}, h('dt', {}, 'Righe del giorno'), h('dd', {}, summary.matchedRows)),
        h('div', {}, h('dt', {}, 'Duplicati esclusi'), h('dd', {}, summary.duplicateRows)),
        h('div', {}, h('dt', {}, 'Tipi da verificare'), h('dd', {}, summary.unknownTypes.length)),
        h('div', {}, h('dt', {}, 'Righe non interpretabili'), h('dd', {}, summary.invalidRows))),
      h('p', {}, summary.type ? `Attività riconosciute: ${typeLabel(summary.type)}.` : 'Nessuna attività riconosciuta per questa data. Il risultato non dimostra un giorno di riposo.'));
    if (summary.unknownTypes.length) preview.append(h('p', { class: 'helper' }, 'Tipi non riconosciuti: ', summary.unknownTypes.slice(0, 10).map(type => String(type).slice(0, 100)).join(', ')));
    if (ambiguous) {
      preview.append(h('p', { class: 'csv-attention' }, 'Il file non consente una registrazione automatica completa. Verifica questa data e scegli esplicitamente l’attività svolta, oppure annulla. Le righe con data non interpretabile non possono essere assegnate a un giorno.'));
      explicitField.hidden = false;
    }
    explicitType.required = ambiguous;
    const selected = selectedType();
    if (!typeLabel(selected)) return;
    const existing = data.days[dateKey]?.trainingLog;
    if (existing) preview.append(h('p', { class: 'csv-attention' }, `Questa conferma sostituirà la registrazione esistente: ${trainingLogLabel(existing)}.`));
    submit.textContent = existing ? `Sostituisci ${trainingLogLabel(existing)} con ${typeLabel(selected)} · ${dateKey}` : `Registra ${typeLabel(selected)} per ${dateKey}`;
    submit.disabled = false;
  }
  function updateSummary() {
    summary = null; error.textContent = ''; explicitType.value = '';
    if (!parsed || !dateColumn || !typeColumn || !timeBasis.value) { renderPreview(); return; }
    if (Number(dateColumn.value) < 0 || Number(typeColumn.value) < 0) { renderPreview(); return; }
    try {
      if (dateColumn.value === typeColumn.value) throw new Error('Scegli colonne distinte per data e tipo di attività.');
      if (Number(idColumn.value) >= 0 && [dateColumn.value, typeColumn.value].includes(idColumn.value)) throw new Error('La colonna ID deve essere distinta da data e tipo, oppure scegli nessuna colonna ID.');
      summary = summarizeActivityCsv(parsed, { dateKey, dateColumn: Number(dateColumn.value), typeColumn: Number(typeColumn.value), idColumn: Number(idColumn.value), timeBasis: timeBasis.value, timeZone: 'Europe/Rome' });
      if (summary.dateKey !== dateKey) throw new Error('Il riepilogo non corrisponde alla data selezionata.');
    } catch (failure) { summary = null; error.textContent = failure.message; }
    renderPreview();
  }
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', name: 'activityCsv', onchange: async event => {
    const file = event.target.files?.[0];
    const version = ++readVersion;
    parsed = null; summary = null; error.textContent = ''; mapping.hidden = true; fileStatus.textContent = ''; explicitType.value = ''; timeBasis.value = ''; renderPreview();
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Scegli un CSV non superiore a 5 MiB.');
      if (file.name && !file.name.toLowerCase().endsWith('.csv')) throw new Error('Scegli il file CSV delle attività, non un archivio ZIP o un altro formato.');
      const content = await file.text();
      if (version !== readVersion || !$('#app-dialog').open) return;
      parsed = parseActivityCsv(content);
      const suggested = suggestActivityColumns(parsed.headers);
      const columnSelect = (name, selection, optional = false) => h('select', { name, onchange: updateSummary },
        h('option', { value: '-1', selected: selection < 0 }, optional ? 'Nessuna colonna ID' : 'Scegli la colonna…'),
        ...parsed.headers.map((header, index) => h('option', { value: index, selected: selection === index }, `${index + 1}. ${header}`)));
      dateColumn = columnSelect('csvDateColumn', suggested.dateColumn);
      typeColumn = columnSelect('csvTypeColumn', suggested.typeColumn);
      idColumn = columnSelect('csvIdColumn', suggested.idColumn, true);
      mapping.replaceChildren(h('div', { class: 'form-grid' }, field('Colonna della data', dateColumn), field('Colonna del tipo', typeColumn), field('Colonna ID · facoltativa', idColumn)), field('Interpretazione delle date · obbligatoria', timeBasis, 'Se il file non dichiara il fuso, controlla se gli orari sono locali italiani o UTC. La scelta non è preselezionata.'));
      mapping.hidden = false;
      fileStatus.textContent = `${parsed.rows.length} ${parsed.rows.length === 1 ? 'riga letta' : 'righe lette'}. Controlla le colonne suggerite e scegli come interpretare le date.`;
      updateSummary();
    } catch (failure) { if (version !== readVersion) return; parsed = null; summary = null; error.textContent = failure.message; renderPreview(); }
  } });
  container.append(dialogHeading('Importa attività da CSV', `Solo il giorno ${dateKey}. Nessun dato viene caricato su un server.`),
    h('div', { class: 'csv-sync-info' }, h('strong', {}, 'Sincronizzazione automatica non attiva'),
      h('p', {}, 'La creazione di un’app API Strava richiede un abbonamento. Con l’account gratuito puoi usare l’export dei tuoi dati. Gli allenamenti Hevy già inviati a Strava possono essere letti da questo file.'),
      h('a', { href: 'https://developers.strava.com/docs/getting-started/', target: '_blank', rel: 'noopener noreferrer' }, 'Requisiti API Strava'), ' · ',
      h('a', { href: 'https://support.strava.com/en-us/articles/15401919-how-do-i-export-my-strava-data', target: '_blank', rel: 'noopener noreferrer' }, 'Come esportare i dati')),
    field('File CSV delle attività · massimo 5 MiB', fileInput), fileStatus, mapping, preview, explicitField, error,
    h('p', { class: 'helper' }, 'Viene salvato soltanto il tipo di attività per questa data, con provenienza CSV Strava. Il contenuto del file resta in memoria durante l’importazione e non entra nel backup. Pasti e calorie non cambiano.'),
    h('div', { class: 'dialog-actions' }, button('Annulla', closeDialog), submit));
  showDialog(container);
  $('#app-dialog').addEventListener('close', () => { readVersion += 1; parsed = null; summary = null; fileInput.value = ''; }, { once: true });
}

function renderToday() {
  if (!data.profile || storageReadError) return renderOnboarding();
  const day = getDay();
  const activity = trainingForDate(day.profileSnapshot, selectedDate);
  const training = activity.type !== 'rest';
  const planned = sumMacros(day.meals.filter(meal => !day.skipped.includes(meal.id)).map(meal => meal.macros));
  const consumed = sumMacros(Object.values(day.consumed).map(entry => entry.meal.macros));
  const allEaten = day.meals.filter(meal => !day.skipped.includes(meal.id)).every(meal => day.consumed[meal.id]);
  const dateNavigation = h('div', { class: 'date-navigation' },
    button('‹', () => shiftDate(-1), 'icon-button', { 'aria-label': 'Giorno precedente' }),
    h('label', { class: 'date-label' }, h('span', { class: 'sr-only' }, 'Data del diario'), h('input', { type: 'date', value: selectedDate, min: '1900-01-01', max: '2100-12-31', onchange: event => { if (event.target.value && event.target.checkValidity()) { selectedDate = event.target.value; render(); } } })),
    button('›', () => shiftDate(1), 'icon-button', { 'aria-label': 'Giorno successivo' }));
  const remaining = day.targets.kcal - consumed.kcal;
  return h('div', { class: 'page today-page' },
    pageTitle('IL TUO DIARIO', selectedDate === localDate() ? 'Oggi, un passo alla volta.' : longDate(selectedDate),
      h('span', { class: 'day-subtitle' }, h('span', {}, longDate(selectedDate)), button('Vai ai pasti ↓', goToMeals, 'button primary small', { 'aria-controls': 'daily-meals-title' })), dateNavigation),
    renderTrainingLog(day, activity),
    selectedDate >= localDate() && profileKey(day.profileSnapshot) !== profileKey(data.profile) && day.meals.some(meal => !day.consumed[meal.id] && !day.skipped.includes(meal.id)) && h('section', { class: 'notice profile-change-notice' }, h('strong', {}, 'Questo giorno usa ancora il profilo precedente.'), h('p', {}, 'Il nuovo profilo è salvato. Puoi applicarlo ai piani da oggi in poi, mantenendo i pasti già registrati.'), button('Applica il profilo ai piani', applyProfileToPlans)),
    renderEnergyContext(day.targets),
    h('section', { class: 'daily-overview', 'aria-label': 'Bilancio del giorno' },
      h('div', { class: 'energy-hero' },
        h('div', { class: 'overview-topline' }, h('span', { class: 'caps' }, 'ENERGIA CONSUMATA'), h('span', { class: 'day-badge', title: 'Allenamento previsto dal profilo', 'aria-label': `Allenamento previsto: ${activity.label}${activity.time ? ` alle ${activity.time}` : ''}` }, training ? `${activity.label} · ${activity.time}` : activity.label)),
        h('div', { class: 'energy-value' }, h('strong', {}, round(consumed.kcal)), h('span', {}, 'kcal')),
        h('div', { class: 'energy-track', role: 'meter', 'aria-label': 'Calorie consumate rispetto all’obiettivo', 'aria-valuemin': 0, 'aria-valuemax': Math.max(day.targets.kcal, consumed.kcal), 'aria-valuenow': consumed.kcal, 'aria-valuetext': `${round(consumed.kcal)} consumate su ${round(day.targets.kcal)} kcal obiettivo` }, h('span', { style: `width:${Math.min(100, consumed.kcal / day.targets.kcal * 100)}%` })),
        h('div', { class: 'energy-footer' }, h('span', {}, remaining >= 0 ? `${round(remaining)} kcal all’obiettivo` : `${round(-remaining)} kcal oltre l’obiettivo`), h('span', {}, allEaten ? 'Pasti registrati ✓' : `${Object.keys(day.consumed).length} ${Object.keys(day.consumed).length === 1 ? 'pasto registrato' : 'pasti registrati'}`))),
      h('div', { class: 'energy-details' },
        h('div', {}, h('span', { class: 'caps' }, 'OBIETTIVO STIMATO'), h('strong', {}, round(day.targets.kcal), h('small', {}, ' kcal')), h('p', {}, 'Dal profilo di questo giorno')),
        h('div', {}, h('span', { class: 'caps' }, 'PIANIFICATO'), h('strong', {}, round(planned.kcal), h('small', {}, ' kcal')), h('p', {}, `${planned.kcal >= day.targets.kcal ? '+' : '−'}${round(Math.abs(planned.kcal - day.targets.kcal))} kcal rispetto all’obiettivo`)))),
    h('section', { class: 'macro-grid', 'aria-label': 'Macronutrienti consumati' }, ...[
      { key: 'protein', name: 'Proteine', color: 'protein' }, { key: 'carbs', name: 'Carboidrati', color: 'carbs' }, { key: 'fat', name: 'Grassi', color: 'fat' },
    ].map(macro => {
      const delta = consumed[macro.key] - day.targets[macro.key];
      return h('div', { class: `macro-card ${macro.color}` },
        h('div', { class: 'macro-title' }, h('span', { class: 'macro-dot' }), macro.name),
        h('p', { class: 'macro-number' }, h('strong', {}, round(consumed[macro.key])), h('span', {}, ` / ${round(day.targets[macro.key])} g`)),
        h('div', { class: 'macro-track' }, h('span', { style: `width:${Math.min(100, consumed[macro.key] / Math.max(1, day.targets[macro.key]) * 100)}%` })),
        h('p', { class: 'macro-caption' }, delta > 0 ? `${round(delta)} g oltre l’obiettivo` : `Pianificati ${round(planned[macro.key])} g`));
    })),
    ...day.targets.warnings.map(warning => h('div', { class: 'notice compact' }, warning)),
    h('div', { class: 'section-heading' }, h('div', {}, h('h2', { id: 'daily-meals-title', tabindex: '-1', class: 'scroll-target' }, 'I pasti del giorno'), h('p', {}, 'Scegli le alternative. Adatta i grammi. Registra ciò che mangi.'), h('p', { class: 'weight-legend' }, 'Pesi a crudo/secco, salvo alimenti pronti. Tonno sgocciolato; uova senza guscio. Orari indicativi.')), selectedDate !== localDate() && button('Torna a oggi', () => { selectedDate = localDate(); render(); }, 'text-button')),
    h('div', { class: 'meal-list' }, ...day.meals.map((meal, index) => renderMeal(meal, day, index))),
    !training && h('div', { class: 'rest-note' }, h('span', { 'aria-hidden': 'true' }, '☀'), h('p', {}, 'Oggi il piano prevede colazione, pranzo e cena. Il preallenamento compare nei giorni di corsa o sala attrezzi.')),
    h('p', { class: 'page-footnote' }, 'Le quantità sono una base da adattare. I valori sono stime e non una prescrizione nutrizionale. ', h('a', { href: '#method' }, 'Leggi il metodo')));
}

function ingredientText(ingredient) {
  return `${getFood(ingredient.foodId, data.foodOverrides).name} · ${formatDecimal(ingredient.grams)} g`;
}

function renderMeal(meal, day, index) {
  const eaten = Boolean(day.consumed[meal.id]);
  const skipped = day.skipped.includes(meal.id);
  const displayMeal = eaten ? day.consumed[meal.id].meal : meal;
  const activity = trainingForDate(day.profileSnapshot, day.dateKey);
  const afterTraining = activity.type !== 'rest' && meal.time > activity.time;
  const slotName = ({ preworkout: 'Prima dell’allenamento', breakfast: afterTraining ? 'Colazione dopo allenamento' : 'Colazione', lunch: 'Pranzo', dinner: 'Cena' })[meal.slot];
  const future = selectedDate > localDate();
  return h('article', { class: `meal-card${eaten ? ' eaten' : ''}${skipped ? ' skipped' : ''}` },
    h('div', { class: 'meal-rail' }, h('span', { class: 'meal-index' }, eaten ? '✓' : String(index + 1).padStart(2, '0')), h('span', { class: 'meal-time', title: 'Orario indicativo', 'aria-label': `Orario indicativo: ${meal.time}` }, meal.time)),
    h('div', { class: 'meal-body' },
      h('div', { class: 'meal-title-row' }, h('div', {}, h('p', { class: 'eyebrow' }, slotName), h('h3', {}, displayMeal.title)), h('span', { class: `status-pill${eaten ? ' complete' : ''}` }, eaten ? 'Mangiato' : skipped ? 'Saltato' : 'Da mangiare')),
      h('ul', { class: 'ingredient-list' }, ...displayMeal.ingredients.map(ingredient => h('li', {}, ingredientText(ingredient)))),
      h('div', { class: 'meal-macros' }, h('strong', {}, `${round(displayMeal.macros.kcal)} kcal`), h('span', {}, `P ${round(displayMeal.macros.protein)} g`), h('span', {}, `C ${round(displayMeal.macros.carbs)} g`), h('span', {}, `G ${round(displayMeal.macros.fat)} g`)),
      displayMeal.note && h('p', { class: 'meal-note' }, displayMeal.note),
      h('div', { class: 'meal-actions' },
        !eaten && !skipped && button('Modifica porzioni e alternative', () => { try { editMeal(meal); } catch (error) { notify(error.message, true); } }, 'text-button'),
        meal.slot === 'preworkout' && !eaten && button(skipped ? 'Aggiungi al piano' : 'Salta spuntino', () => updateDay(target => { target.skipped = skipped ? target.skipped.filter(id => id !== meal.id) : [...target.skipped, meal.id]; }), 'text-button muted'),
        eaten ? button('Annulla registrazione', () => updateDay(target => { delete target.consumed[meal.id]; }), 'button secondary small') : !skipped && button('Segna mangiato', () => updateDay(target => { target.consumed[meal.id] = { consumedAt: new Date().toISOString(), meal: clone(meal) }; }), 'button primary small', { disabled: future, title: future ? 'Potrai registrare il pasto quando arriva questa data.' : 'Registra questo pasto nel diario' })),
      future && !eaten && !skipped && h('p', { class: 'meal-note future-note' }, 'Stai pianificando un giorno futuro. La registrazione sarà disponibile da quella data.')));
}

function showDialog(content) {
  const dialog = $('#app-dialog');
  returnFocus = document.activeElement;
  dialog.replaceChildren(content);
  dialog.showModal();
  requestAnimationFrame(() => (dialog.querySelector('[autofocus]') || dialog.querySelector('button, input, select') || dialog).focus());
}
function closeDialog() { $('#app-dialog').close(); }
$('#app-dialog').addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); else $('#main').focus({ preventScroll: true }); });
$('#app-dialog').addEventListener('click', event => { if (event.target === $('#app-dialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(); } });

function dialogHeading(title, subtitle) {
  return h('div', { class: 'dialog-heading' }, h('div', {}, h('h2', { id: 'dialog-title' }, title), subtitle && h('p', {}, subtitle)), button('×', closeDialog, 'icon-button', { 'aria-label': 'Chiudi finestra' }));
}

function editMeal(original) {
  let draft = clone(original);
  const container = h('div', { class: 'dialog-content' });
  const values = h('div', { class: 'edit-macro-total', 'aria-live': 'polite' });
  const ingredientFields = h('div', { class: 'edit-ingredients' });
  const errors = h('p', { class: 'form-error', role: 'alert' });
  const controls = h('div', { class: 'swap-fields' });
  const adaptation = h('div', { class: 'portion-update', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true });
  const alternatives = mealAlternatives(original, data.days[selectedDate].targets, data.foodOverrides);
  const showAdaptation = before => {
    const quantities = meal => meal.ingredients.reduce((map, item) => map.set(item.foodId, (map.get(item.foodId) || 0) + item.grams), new Map());
    const previous = quantities(before);
    const current = quantities(draft);
    const ids = [...new Set([...previous.keys(), ...current.keys()])];
    const changes = ids.filter(id => formatDecimal(previous.get(id) || 0) !== formatDecimal(current.get(id) || 0));
    adaptation.hidden = changes.length === 0;
    adaptation.replaceChildren(...(changes.length ? [
      h('strong', {}, 'Porzioni adattate automaticamente'),
      h('ul', {}, ...changes.map(id => h('li', {}, h('span', {}, getFood(id).name), h('span', { class: 'portion-change' },
        !previous.has(id) ? `Aggiunto: ${formatDecimal(current.get(id))} g` : !current.has(id) ? `${formatDecimal(previous.get(id))} g → rimosso` : `${formatDecimal(previous.get(id))} → ${formatDecimal(current.get(id))} g`)))),
    ] : []));
  };
  const updateTotals = () => {
    try {
      draft = mealFromIngredients(draft, data.foodOverrides);
      values.replaceChildren(h('strong', {}, `${round(draft.macros.kcal)} kcal`), h('span', {}, `Proteine ${round(draft.macros.protein)} g`), h('span', {}, `Carboidrati ${round(draft.macros.carbs)} g`), h('span', {}, `Grassi ${round(draft.macros.fat)} g`));
      errors.textContent = '';
    } catch (error) { errors.textContent = error.message; }
  };
  const rebuild = () => {
    controls.replaceChildren();
    if (['lunch', 'dinner'].includes(draft.slot)) {
      for (const [label, ids] of [['Carboidrato', CARBS], ['Proteina', PROTEINS]]) {
        const current = label === 'Proteina' && draft.ingredients.some(ingredient => ingredient.foodId === 'eggs')
          ? draft.ingredients.find(ingredient => ingredient.foodId === 'eggs')
          : draft.ingredients.find(ingredient => ids.includes(ingredient.foodId));
        if (!current) continue;
        controls.append(field(label, h('select', { onchange: event => {
          try { const before = clone(draft); draft = swapMealFood(draft, current.foodId, event.target.value, data.foodOverrides); rebuild(); showAdaptation(before); }
          catch (error) { errors.textContent = error.message; }
        } }, ...ids.map(id => h('option', { value: id, selected: id === current.foodId }, getFood(id).name)))));
      }
    }
    ingredientFields.replaceChildren(...draft.ingredients.map((ingredient, index) => {
      const food = getFood(ingredient.foodId, data.foodOverrides);
      const grams = h('input', { id: `ingredient-${index}`, type: 'number', min: '0', max: '3000', step: '0.1', inputmode: 'decimal', value: Number(ingredient.grams.toFixed(1)), 'aria-label': `${food.name}, grammi`, oninput: event => {
        adaptation.hidden = true;
        adaptation.replaceChildren();
        const value = event.target.valueAsNumber;
        if (!Number.isFinite(value) || value < 0 || value > 3000) { errors.textContent = 'Inserisci una quantità tra 0 e 3.000 g.'; return; }
        draft.ingredients[index].grams = value;
        updateTotals();
      } });
      return h('div', { class: 'edit-ingredient' }, h('div', {}, h('label', { for: `ingredient-${index}` }, food.name), h('small', {}, food.unitNote)), h('div', { class: 'gram-control' }, grams, h('span', {}, 'g')));
    }));
    updateTotals();
  };
  const variantSelect = h('select', { autofocus: true, 'aria-label': 'Scegli un’alternativa completa', onchange: event => {
    if (event.target.value === '') return;
    const index = Number(event.target.value);
    const choice = index === -1 ? original : alternatives[index];
    if (choice) { const before = clone(draft); draft = clone(choice); draft.id = original.id; draft.slot = original.slot; draft.time = original.time; rebuild(); showAdaptation(before); }
  } }, h('option', { value: '' }, 'Scegli un’alternativa…'), h('option', { value: '-1' }, 'Pasto originale'), ...alternatives.map((meal, index) => h('option', { value: index }, meal.title)));
  container.append(dialogHeading('Fai spazio alle tue scelte', 'Le dosi ricalcolano energia e macronutrienti.'), field('Alternative del pasto', variantSelect, original.slot === 'breakfast' ? 'Tra le colazioni: budino proteico, mousse proteica e yogurt greco con cioccolato.' : null), controls,
    ['lunch', 'dinner'].includes(original.slot) ? h('p', { class: 'swap-explanation' }, 'Cambiando alimento si adattano anche la porzione di carne, pesce o uova e l’olio. Le proteine di pasta e legumi sono già conteggiate.') : document.createDocumentFragment(),
    adaptation, ingredientFields,
    h('p', { class: 'helper' }, 'Pesi della parte edibile: crudo o secco, salvo la nota dell’alimento. Per uova e albumi usa i grammi effettivi.'), values, errors,
    h('div', { class: 'dialog-actions' }, button('Annulla', closeDialog), button('Salva questo pasto', () => {
      if (errors.textContent) return;
      const invalid = [...ingredientFields.querySelectorAll('input')].some(input => !input.checkValidity() || input.value === '');
      if (invalid) { errors.textContent = 'Controlla i grammi di tutti gli ingredienti.'; return; }
      try {
        draft = mealFromIngredients(draft, data.foodOverrides);
        if (updateDay(day => { day.meals = day.meals.map(meal => meal.id === original.id ? clone(draft) : meal); })) {
          closeDialog(); notify(unsaved ? 'Pasto aggiornato in memoria. Scarica il backup: il salvataggio è bloccato.' : 'Pasto aggiornato.');
        }
      } catch (error) { errors.textContent = error.message; }
    }, 'button primary')));
  rebuild();
  showDialog(container);
}

function field(label, control, helper) {
  if (!control.id) control.id = `field-${crypto.randomUUID()}`;
  return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, helper && h('small', { class: 'helper' }, helper));
}

function renderOnboarding() {
  return h('div', { class: 'page onboarding-page' },
    pageTitle('BENVENUTO IN PASTI', 'Partiamo da te.', 'Poche informazioni per stimare il tuo fabbisogno e costruire la giornata.'),
    h('div', { class: 'onboarding-layout' }, h('section', { class: 'panel profile-panel' }, renderProfileForm()),
      h('aside', { class: 'onboarding-aside' }, h('div', { class: 'leaf-mark', 'aria-hidden': 'true' }, 'p.'), h('h2', {}, 'Una base chiara.\nScelte flessibili.'),
        h('p', {}, 'Pasti in grammi, alternative semplici e un diario che distingue ciò che pianifichi da ciò che mangi.'),
        h('ul', { class: 'check-list' }, h('li', {}, 'Corsa e sala attrezzi alle 06:00, orario modificabile'), h('li', {}, 'Preallenamento piccolo e facoltativo'), h('li', {}, 'Dati salvati soltanto in questo browser')),
        h('p', { class: 'aside-footnote' }, 'Le stime sono pensate per adulti e non sostituiscono un professionista.'))));
}

function profileKey(profile) {
  if (!profile) return '';
  const plan = profile.trainingPlan;
  const schedule = !plan ? null : plan.mode === 'alternating' ? [plan.mode, plan.startDate, plan.firstType] : [plan.mode, ...plan.days];
  return JSON.stringify([profile.age, profile.sex, profile.weight, profile.height, profile.activity, profile.goal,
    profile.deficitKcal ?? null, profile.trainingTime, [...profile.trainingDays].sort(), schedule, profile.specialCondition]);
}

function renderEnergyContext(targets) {
  const difference = targets.tdee - targets.kcal;
  return h('section', { class: 'daily-estimates', 'aria-label': 'Stime del fabbisogno giornaliero' },
    h('div', {}, h('span', {}, 'Riposo stimato'), h('strong', {}, `${round(targets.bmr)} kcal`)),
    h('div', {}, h('span', {}, 'Consumo totale medio'), h('strong', {}, `${round(targets.tdee)} kcal`)),
    h('div', {}, h('span', {}, difference < 0 ? 'Surplus applicato' : 'Deficit applicato'), h('strong', {}, `${round(Math.abs(difference))} kcal`)));
}

function renderProfileForm() {
  const profile = data.profile;
  const initialPlan = profile?.trainingPlan ?? (profile
    ? { mode: 'weekly', days: Array.from({ length: 7 }, (_, day) => profile.trainingDays.includes(day) ? 'strength' : 'rest') }
    : { mode: 'alternating', startDate: localDate(), firstType: 'run' });
  let legacyDeficit;
  if (profile?.goal === 'lose' && profile.deficitKcal === undefined) {
    try { legacyDeficit = Math.round(calculateTargets({ ...profile, goal: 'maintain' }).tdee * 0.1); } catch { /* Form will show validation errors. */ }
  }
  const error = h('p', { class: 'form-error', role: 'alert' });
  const preview = h('div', { class: 'live-estimates', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const trainingPreview = h('div', { class: 'training-preview', 'aria-label': 'Calendario dei prossimi sette giorni', 'aria-live': 'polite' });
  const form = h('form', { class: 'profile-form' });
  const input = (name, attrs) => h('input', { name, value: profile?.[name] ?? '', required: true, ...attrs });
  const deficitInput = h('input', { name: 'deficitKcal', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: profile?.deficitKcal ?? legacyDeficit ?? '', placeholder: 'Scegli le kcal da sottrarre' });
  const deficitField = field('Deficit giornaliero scelto · kcal', deficitInput, 'Puoi scegliere anche 0 kcal. La scelta deve essere inferiore al consumo totale medio.');
  const legacyNote = legacyDeficit !== undefined ? h('p', { class: 'notice compact' }, `Prima usavi il deficit automatico del 10%. La proposta convertita è ${round(legacyDeficit)} kcal: puoi modificarla e confermarla salvando il profilo.`) : null;
  const modeSelect = h('select', { name: 'trainingMode', required: true },
    h('option', { value: 'alternating', selected: initialPlan.mode === 'alternating' }, 'Alternanza quotidiana: corsa / sala attrezzi'),
    h('option', { value: 'weekly', selected: initialPlan.mode === 'weekly' }, 'Settimana personalizzata'));
  const alternating = h('div', { class: 'alternating-fields form-grid' },
    field('Data di riferimento', h('input', { name: 'trainingStart', type: 'date', min: '1900-01-01', max: '2100-12-31', required: true, value: initialPlan.startDate ?? localDate() })),
    field('Attività nella data di riferimento', h('select', { name: 'trainingFirst', required: true },
      h('option', { value: 'run', selected: initialPlan.firstType !== 'strength' }, 'Corsa'), h('option', { value: 'strength', selected: initialPlan.firstType === 'strength' }, 'Sala attrezzi'))),
    h('p', { class: 'helper full-width' }, 'Le attività si alternano ogni giorno, senza ripartire il lunedì o all’inizio del mese.'));
  const weekly = h('fieldset', { class: 'weekly-fields days-fieldset' }, h('legend', {}, 'Attività per ciascun giorno'),
    h('div', { class: 'weekly-grid' }, ...DAYS.map(day => field(day.label, h('select', { name: `trainingDay-${day.value}` },
      ...TRAINING_TYPES.map(type => h('option', { value: type.id, selected: type.id === (initialPlan.days?.[day.value] ?? 'rest') }, type.label)))))));
  const fields = h('fieldset', { class: 'profile-fields', disabled: Boolean(storageReadError) },
    h('legend', { class: 'form-section-title' }, 'Le informazioni di base'),
    h('div', { class: 'form-grid' },
      field('Età', input('age', { type: 'number', min: 18, max: 100, step: 1, inputmode: 'numeric', autocomplete: 'off', placeholder: 'Anni' })),
      field('Sesso usato nella formula', h('select', { name: 'sex', required: true }, h('option', { value: '', selected: !profile }, 'Scegli…'), h('option', { value: 'female', selected: profile?.sex === 'female' }, 'Femminile'), h('option', { value: 'male', selected: profile?.sex === 'male' }, 'Maschile')), 'La formula usa un coefficiente diverso.'),
      field('Peso attuale · kg', input('weight', { type: 'number', min: 35, max: 250, step: '0.1', inputmode: 'decimal', placeholder: 'kg' })),
      field('Altezza · cm', input('height', { type: 'number', min: 130, max: 230, step: '0.1', inputmode: 'decimal', placeholder: 'cm' }))),
    field('Attività abituale', h('select', { name: 'activity', required: true }, h('option', { value: '', selected: !profile }, 'Scegli il livello di attività…'), ...ACTIVITY_LEVELS.map(level => h('option', { value: level.id, selected: profile?.activity === level.id }, level.label))), 'Considera la tua intera settimana, corsa e sala attrezzi incluse. Il totale è una media quotidiana.'),
    field('Il tuo obiettivo', h('select', { name: 'goal', required: true }, h('option', { value: '', selected: !profile }, 'Scegli un obiettivo…'), ...[{ id: 'lose', name: 'Perdere peso gradualmente' }, { id: 'maintain', name: 'Mantenere il peso' }, { id: 'gain', name: 'Aumentare il peso gradualmente' }].map(goal => h('option', { value: goal.id, selected: profile?.goal === goal.id }, goal.name)))),
    deficitField, legacyNote, preview,
    h('div', { class: 'form-divider' }), h('h2', { class: 'form-section-title' }, 'Il calendario degli allenamenti'),
    field('Orario di allenamento', h('input', { name: 'trainingTime', type: 'time', value: profile?.trainingTime || '06:00', required: true })),
    field('Organizzazione', modeSelect), alternating, weekly, trainingPreview,
    h('label', { class: 'condition-check' }, h('input', { type: 'checkbox', name: 'specialCondition', checked: profile?.specialCondition }), h('span', {}, 'Ho una condizione clinica, sono in gravidanza o allatto.')),
    h('p', { class: 'helper' }, 'In questi casi serve una valutazione individuale prima di usare un piano alimentare.'),
    error, h('button', { type: 'submit', class: 'button primary wide' }, profile ? 'Salva profilo' : 'Crea la mia giornata'),
    profile && h('p', { class: 'helper' }, 'Dopo il salvataggio puoi applicare il profilo ai piani da oggi in poi. I pasti già registrati e i giorni passati vengono conservati.'));
  form.append(fields);
  const readProfile = (requireDeficit = true) => {
    const values = new FormData(form);
    const trainingPlan = values.get('trainingMode') === 'alternating'
      ? { mode: 'alternating', startDate: values.get('trainingStart'), firstType: values.get('trainingFirst') }
      : { mode: 'weekly', days: Array.from({ length: 7 }, (_, day) => values.get(`trainingDay-${day}`)) };
    const candidate = {
      age: Number(values.get('age')), sex: values.get('sex'), weight: Number(values.get('weight')), height: Number(values.get('height')),
      activity: values.get('activity'), goal: values.get('goal'), trainingTime: values.get('trainingTime'), trainingPlan,
      trainingDays: trainingPlan.mode === 'alternating' ? [0, 1, 2, 3, 4, 5, 6] : trainingPlan.days.flatMap((type, day) => type === 'rest' ? [] : [day]),
      specialCondition: values.get('specialCondition') === 'on',
    };
    if (candidate.goal === 'lose') {
      if (deficitInput.value === '') {
        if (requireDeficit) throw new Error('Scegli il deficit in kcal, anche 0 se vuoi mantenere il consumo stimato.');
      } else candidate.deficitKcal = Number(deficitInput.value);
    }
    return candidate;
  };
  const updatePreview = () => {
    const goal = form.querySelector('[name="goal"]').value;
    deficitField.hidden = goal !== 'lose'; deficitInput.disabled = goal !== 'lose'; deficitInput.required = goal === 'lose';
    if (legacyNote) legacyNote.hidden = goal !== 'lose';
    alternating.hidden = modeSelect.value !== 'alternating'; weekly.hidden = modeSelect.value !== 'weekly';
    alternating.querySelectorAll('input, select').forEach(control => { control.disabled = alternating.hidden; });
    weekly.querySelectorAll('select').forEach(control => { control.disabled = weekly.hidden; });
    const values = new FormData(form);
    try {
      const trainingPlan = modeSelect.value === 'alternating'
        ? { mode: 'alternating', startDate: values.get('trainingStart'), firstType: values.get('trainingFirst') }
        : { mode: 'weekly', days: Array.from({ length: 7 }, (_, day) => values.get(`trainingDay-${day}`)) };
      validateTrainingPlan(trainingPlan);
      trainingPreview.replaceChildren(h('p', { class: 'helper' }, 'I prossimi sette giorni'), h('ul', {}, ...Array.from({ length: 7 }, (_, offset) => {
        const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + offset);
        const key = localDate(date); const session = trainingForDate({ trainingPlan, trainingTime: values.get('trainingTime') }, key);
        return h('li', {}, h('span', {}, date.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })), h('strong', {}, session.label), h('small', {}, session.time));
      })));
    } catch (failure) { trainingPreview.replaceChildren(h('p', { class: 'form-error' }, failure.message)); }
    if (['age', 'sex', 'weight', 'height', 'activity', 'goal'].some(name => !values.get(name))) {
      preview.replaceChildren(h('p', { class: 'helper' }, 'Completa i dati per vedere riposo stimato, consumo totale medio e obiettivo.')); return;
    }
    try {
      const candidate = readProfile(false); validateTrainingPlan(candidate.trainingPlan);
      const baselineProfile = { ...candidate, goal: 'maintain' }; delete baselineProfile.deficitKcal;
      const baseline = calculateTargets(baselineProfile);
      let targets; let targetError;
      try {
        if (goal === 'lose' && candidate.deficitKcal === undefined) throw new Error('Scegli il deficit in kcal, anche 0 se vuoi mantenere il consumo stimato.');
        targets = calculateTargets(candidate);
      } catch (failure) { targetError = failure.message; }
      preview.replaceChildren(h('div', { class: 'estimate-steps' },
        h('div', {}, h('span', {}, '1 · Riposo stimato'), h('strong', {}, `${round(baseline.bmr)} kcal`)),
        h('div', {}, h('span', {}, '2 · Consumo totale medio'), h('strong', {}, `${round(baseline.tdee)} kcal`)),
        h('div', {}, h('span', {}, goal === 'lose' ? '3 · Obiettivo dopo deficit' : '3 · Obiettivo giornaliero'), h('strong', {}, targets ? `${round(targets.kcal)} kcal` : '—'))),
        targetError ? h('p', { class: 'form-error' }, targetError) : h('p', { class: 'helper' }, `Differenza applicata dal consumo totale: ${round(Math.abs(targets.tdee - targets.kcal))} kcal${targets.kcal > targets.tdee ? ' in più' : ' in meno'}. Corsa e sala attrezzi sono già comprese nel fattore di attività.`),
        ...(targets?.warnings ?? []).map(warning => h('p', { class: 'helper estimate-warning' }, warning)));
    } catch (failure) { preview.replaceChildren(h('p', { class: 'form-error' }, failure.message)); }
  };
  form.querySelectorAll('input, select').forEach(control => { control.addEventListener('input', updatePreview); control.addEventListener('change', updatePreview); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    try {
      const nextProfile = readProfile(); validateTrainingPlan(nextProfile.trainingPlan); calculateTargets(nextProfile);
      const next = clone(data); next.profile = nextProfile; persist(next);
      selectedDate = localDate(); location.hash = 'today'; render();
      if (!unsaved) notify(profile ? 'Profilo salvato. Puoi applicarlo ai piani già creati.' : 'Profilo salvato. La tua giornata è pronta.');
    } catch (failure) { error.textContent = failure.message; error.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });
  updatePreview();
  return form;
}

function renderProfile() {
  return h('div', { class: 'page' }, pageTitle('LE TUE INFORMAZIONI', 'Il tuo profilo.', 'Scegli il deficit e organizza corsa, sala attrezzi e riposo.'),
    h('div', { class: 'profile-layout' }, h('section', { class: 'panel profile-panel' }, renderProfileForm()),
      h('aside', { class: 'profile-side' }, data.profile && h('section', { class: 'panel target-preview' }, h('h2', {}, 'Applica il profilo salvato'),
        h('p', {}, 'Aggiorna gli obiettivi e rigenera i pasti ancora da consumare da oggi in poi. I pasti già mangiati e i giorni passati restano invariati.'),
        button('Applica ai piani da oggi', applyProfileToPlans, 'button primary wide'), h('p', { class: 'helper' }, 'Prima salva le modifiche al modulo.')), renderDataTools())));
}

function applyProfileToPlans() {
  try {
    if (!data.profile) throw new Error('Salva prima il profilo.');
    if (storageReadError || storageConflict) throw new Error('Recupera o ricarica i dati prima di applicare il profilo.');
    const next = clone(data); const today = localDate(); const targets = calculateTargets(next.profile);
    const changedDates = [];
    for (const [date, day] of Object.entries(next.days)) {
      if (date < today || profileKey(day.profileSnapshot) === profileKey(next.profile) || !day.meals.some(meal => !day.consumed[meal.id] && !day.skipped.includes(meal.id))) continue;
      const previous = day.meals;
      const generated = createDayPlan(next.profile, targets, date, next.foodOverrides);
      const meals = generated.map(meal => {
        const old = previous.find(item => item.slot === meal.slot);
        return old && day.consumed[old.id] ? old : { ...meal, id: old?.id ?? meal.id };
      });
      previous.filter(meal => day.consumed[meal.id] && !meals.some(item => item.id === meal.id)).forEach(meal => meals.push(meal));
      const slots = ['preworkout', 'breakfast', 'lunch', 'dinner']; meals.sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
      day.meals = meals; day.profileSnapshot = clone(next.profile); day.targets = clone(targets);
      day.skipped = day.skipped.filter(id => meals.some(meal => meal.id === id && meal.slot === 'preworkout'));
      changedDates.push(date);
    }
    if (!changedDates.length) { notify('Non ci sono piani da consumare che richiedono il nuovo profilo.'); return; }
    validateData(next);
    confirmAction('Applicare il profilo ai piani?', `Aggiornerai ${changedDates.length} ${changedDates.length === 1 ? 'giorno' : 'giorni'} da oggi in poi. Gli obiettivi e i pasti non ancora mangiati saranno rigenerati: anche le porzioni modificate cambieranno. I pasti già registrati e i giorni passati vengono conservati.`, 'Applica profilo', () => {
      const now = new Date().toISOString(); changedDates.forEach(date => { next.days[date].updatedAt = now; });
      persist(next); if (!unsaved) notify('Profilo applicato. Obiettivi e pasti da consumare sono aggiornati.');
    });
  } catch (error) { notify(error.message, true); }
}

function downloadText(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadBackup() {
  try { downloadText(exportBackup(data), `pasti-backup-${localDate()}.json`); notify('Backup scaricato. Conservalo in un luogo privato.'); }
  catch (error) { notify(error.message, true); }
}

function confirmAction(title, description, actionLabel, action, destructive = false) {
  showDialog(h('div', { class: 'dialog-content confirm-dialog' }, dialogHeading(title), h('p', {}, description), h('div', { class: 'dialog-actions' },
    button('Annulla', closeDialog, 'button secondary', { autofocus: true }), button(actionLabel, () => { try { action(); closeDialog(); render(); } catch (error) { notify(error.message, true); } }, `button ${destructive ? 'danger-button' : 'primary'}`))));
}

function validateDomain(imported) {
  const checkMeal = meal => meal.ingredients.forEach(ingredient => getFood(ingredient.foodId, imported.foodOverrides));
  if (imported.profile) calculateTargets(imported.profile);
  Object.keys(imported.foodOverrides).forEach(id => getFood(id, imported.foodOverrides));
  for (const day of Object.values(imported.days)) {
    calculateTargets(day.profileSnapshot);
    day.meals.forEach(checkMeal);
    Object.values(day.consumed).forEach(entry => checkMeal(entry.meal));
  }
}

async function importFile(file) {
  if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('Il backup deve essere più piccolo di 5 MB.');
    const imported = parseBackup(await file.text());
    validateDomain(imported);
    const count = Object.keys(imported.days).length;
    confirmAction('Sostituire i dati locali?', `Il backup contiene ${count} ${count === 1 ? 'giorno' : 'giorni'} di diario${imported.profile ? ' e un profilo' : ''}. Importandolo sostituirai tutti i dati di Pasti in questo browser. Scarica prima un backup se vuoi conservarli.`, 'Importa e sostituisci', () => {
      saveData(imported);
      data = imported; storageReadError = null; unsaved = false; storageConflict = false;
      notify('Backup importato.');
    });
  } catch (error) { notify(error.message, true); }
}

function renderDataTools() {
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', id: 'backup-file', onchange: event => { importFile(event.target.files[0]); event.target.value = ''; } });
  return h('section', { class: 'panel data-panel' }, h('h2', {}, 'I tuoi dati, con te.'), h('p', {}, 'Profilo e diario restano in questo browser. Non vengono inviati a un server e non si sincronizzano tra dispositivi.'),
    h('p', {}, 'La modalità privata, la cancellazione dei dati del browser o un cambio di dispositivo possono rimuoverli. Conserva un backup.'),
    file, h('div', { class: 'data-actions' },
      button('↓ Scarica backup JSON', downloadBackup, 'button secondary wide', { disabled: Boolean(storageReadError) }),
      button('↑ Importa backup', () => file.click(), 'button secondary wide'),
      storageReadError && button('Scarica dati originali', () => {
        try { downloadText(localStorage.getItem(STORAGE_KEY) || '', `pasti-recupero-${localDate()}.json`); } catch (error) { notify(error.message, true); }
      }, 'button secondary wide'),
      button('Cancella tutti i dati', () => confirmAction('Cancellare profilo e diario?', 'Questa operazione rimuove definitivamente i dati di Pasti da questo browser. Prima puoi scaricare un backup. Non verranno cancellati eventuali backup già scaricati.', 'Cancella tutti i dati', () => {
        data = clearData(); storageReadError = null; unsaved = false; storageConflict = false; selectedDate = localDate(); notify('Dati locali cancellati.');
      }, true), 'text-button danger-text')));
}

function refreshMealNote(meal) {
  let note = meal.note;
  if (meal.ingredients.some(item => LIDL_FOOD_IDS.includes(item.foodId) && getFood(item.foodId).group === 'breakfast')) {
    note = note
      .replace('Un vasetto da 200 g è solo un esempio: modifica grammi e valori con la confezione.', '')
      .replace('Un vasetto da 200 g è solo un esempio: verifica peso ed etichetta.', '');
  }
  if (meal.ingredients.some(item => LIDL_FOOD_IDS.includes(item.foodId) && getFood(item.foodId).group === 'carb')) {
    note = note.replace('Valori Lidl da verificare sulla confezione.', '');
  }
  if (note === meal.note) return note;
  return `${note.replace(/ {2,}/g, ' ').trim()} Le dosi restano quelle indicate in grammi; il riferimento nutrizionale corrente è in Alimenti.`.trim();
}

function refreshPlannedMeals() {
  try {
    if (storageReadError) throw new Error('Prima recupera o cancella i dati locali dalla sezione Profilo.');
    if (storageConflict) throw new Error('I dati sono cambiati in un’altra scheda. Ricarica la pagina prima di aggiornarli.');
    const fromDate = localDate();
    const next = clone(data);
    const changedDays = [];
    let mealCount = 0;
    for (const [date, day] of Object.entries(next.days)) {
      if (date < fromDate) continue;
      let changed = false;
      day.meals = day.meals.map(meal => {
        if (Object.hasOwn(day.consumed, meal.id)) return meal;
        const refreshed = mealFromIngredients(meal, next.foodOverrides);
        refreshed.note = refreshMealNote(refreshed);
        if (refreshed.note === meal.note && ['kcal', 'protein', 'carbs', 'fat'].every(key => Math.abs(refreshed.macros[key] - meal.macros[key]) < 1e-7)) return meal;
        mealCount += 1;
        changed = true;
        return refreshed;
      });
      if (changed) changedDays.push(date);
    }
    if (!mealCount) { notify('I pasti da consumare sono già aggiornati.'); return; }
    validateData(next);
    confirmAction('Aggiornare i pasti pianificati?', `Aggiornerai i riferimenti nutrizionali di ${mealCount} ${mealCount === 1 ? 'pasto' : 'pasti'} dal ${longDate(fromDate)} in poi, inclusi i valori e le note obsolete. I grammi restano uguali. I pasti già mangiati, i giorni passati e le tue etichette personali non cambiano.`, 'Aggiorna valori', () => {
      const now = new Date().toISOString();
      changedDays.forEach(date => { next.days[date].updatedAt = now; });
      persist(next);
      if (!unsaved) notify(`${mealCount} ${mealCount === 1 ? 'pasto aggiornato' : 'pasti aggiornati'}. Le quantità sono rimaste uguali.`);
    });
  } catch (error) { notify(error.message, true); }
}

function foodStatus(item) {
  if (Object.hasOwn(data.foodOverrides, item.id)) return h('span', { class: 'estimate-tag' }, 'Tua etichetta');
  if (item.label) return h('span', { class: 'estimate-tag verified-tag' }, 'Etichetta verificata');
  if (item.estimated) return h('span', { class: 'estimate-tag' }, 'Stima');
  return null;
}

function labelReference(item) {
  if (!item.label) return null;
  const label = item.label;
  const verified = new Date(`${label.verifiedOn}T12:00:00`);
  const date = Number.isFinite(verified.getTime()) ? verified.toLocaleDateString('it-IT') : label.verifiedOn;
  return h('div', { class: 'label-reference' },
    Object.hasOwn(data.foodOverrides, item.id) && h('p', { class: 'label-reference-caption' }, 'Riferimento del catalogo; i tuoi valori personalizzati hanno la precedenza.'),
    h('p', {}, `Formato ${formatDecimal(label.packGrams)} g · ${label.market}`),
    h('p', {}, `Verifica del ${date}`),
    label.barcode && h('p', {}, 'EAN della scheda fonte: ', h('span', { class: 'barcode' }, label.barcode)),
    h('a', { href: label.evidenceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Vedi l’etichetta ↗'));
}

function renderFoods() {
  const food = getFood(labelFoodId, data.foodOverrides);
  const orderedFoods = [...LIDL_FOOD_IDS.map(id => FOODS.find(item => item.id === id)).filter(Boolean), ...FOODS.filter(item => !LIDL_FOOD_IDS.includes(item.id))];
  const formError = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'label-form' },
    field('Prodotto', h('select', { value: labelFoodId, onchange: event => { labelFoodId = event.target.value; render(); } }, ...orderedFoods.map(item => h('option', { value: item.id, selected: item.id === labelFoodId }, item.name)))),
    h('div', { class: 'food-estimate-note' }, foodStatus(food), h('p', {}, data.foodOverrides[labelFoodId] ? 'Valori personalizzati dalla tua etichetta. Prevalgono sui valori del catalogo.' : food.label ? 'I valori di questa variante sono già inseriti. Puoi modificarli se la tua confezione è diversa per prodotto, gusto o formato.' : 'Valori di riferimento già presenti nel catalogo. La modifica è facoltativa, per una confezione con valori diversi.'), labelReference(food)),
    h('div', { class: 'form-grid label-grid' }, ...[{ key: 'kcal', label: 'Energia · kcal', max: 1000 }, { key: 'protein', label: 'Proteine · g', max: 100 }, { key: 'carbs', label: 'Carboidrati · g', max: 100 }, { key: 'fat', label: 'Grassi · g', max: 100 }].map(metric => field(metric.label, h('input', { name: metric.key, type: 'number', required: true, min: 0, max: metric.max, step: '0.1', inputmode: 'decimal', value: food[metric.key] })))),
    formError, h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Salva valori per 100 g'), data.foodOverrides[labelFoodId] && button('Ripristina i valori del catalogo', () => {
      try { const next = clone(data); delete next.foodOverrides[labelFoodId]; persist(next); render(); if (!unsaved) notify('Ripristinati i valori del catalogo per i nuovi piani.'); } catch (error) { notify(error.message, true); }
    }, 'text-button')),
    h('p', { class: 'helper' }, 'I nuovi valori si usano nei piani creati da ora e nei pasti che modifichi. I pasti già pianificati mantengono i valori precedenti finché non scegli di aggiornarli. Per usare un intero vasetto modifica i grammi del pasto in base al peso in confezione.'));
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    try {
      const values = new FormData(form);
      const next = clone(data);
      next.foodOverrides[labelFoodId] = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, Number(values.get(key))]));
      getFood(labelFoodId, next.foodOverrides); persist(next); render(); if (!unsaved) notify('Etichetta salvata per i nuovi piani.');
    } catch (error) { formError.textContent = error.message; }
  });
  return h('div', { class: 'page foods-page' }, pageTitle('QUELLO CHE MANGI', 'Alimenti e quantità.', 'Pesi chiari e valori per 100 g. La confezione che hai in mano è il riferimento.'),
    h('section', { class: 'panel label-panel' }, h('div', { class: 'section-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'IL RIFERIMENTO PER OGNI VARIANTE'), h('h2', {}, 'Etichette e valori nutrizionali'), h('p', {}, 'I valori delle varianti sono già inseriti. Puoi modificarli facoltativamente per una confezione diversa.'))), form),
    h('section', { class: 'panel refresh-panel' }, h('div', {}, h('h2', {}, 'Hai già pianificato i prossimi pasti?'), h('p', {}, 'Puoi aggiornarne i valori nutrizionali e le note di riferimento senza cambiare i grammi. I pasti mangiati, i giorni passati e le tue etichette personali restano invariati.')),
      button('Aggiorna i pasti da oggi in poi', refreshPlannedMeals, 'button secondary', { disabled: Boolean(storageReadError || storageConflict) })),
    h('div', { class: 'section-heading' }, h('div', {}, h('h2', {}, 'Il catalogo del piano'), h('p', {}, 'Energia e macronutrienti per 100 g di parte edibile.'))),
    h('div', { class: 'food-catalog' }, ...FOODS.map(base => {
      const item = getFood(base.id, data.foodOverrides);
      return h('article', { class: 'food-card' }, h('div', { class: 'food-card-top' }, h('h3', {}, item.name), foodStatus(item)),
        h('p', { class: 'food-calories' }, h('strong', {}, round(item.kcal)), ' kcal'),
        h('p', { class: 'food-macros' }, `P ${formatDecimal(item.protein)} g · C ${formatDecimal(item.carbs)} g · G ${formatDecimal(item.fat)} g`),
        h('p', { class: 'helper' }, item.unitNote), labelReference(item),
        item.source !== item.label?.evidenceUrl && h('p', { class: 'food-source' }, /^https?:\/\//.test(item.source) ? h('a', { href: item.source, target: '_blank', rel: 'noopener noreferrer' }, item.label ? 'Scheda prodotto e provenienza ↗' : 'Consulta la fonte ↗') : item.source));
    })));
}

function renderMethod() {
  const source = (label, href) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
  return h('div', { class: 'page method-page' }, pageTitle('TRASPARENZA, PRIMA DI TUTTO', 'Le stime, spiegate.', 'Da dove arrivano i numeri e come leggerli nella tua giornata.'),
    h('section', { class: 'notice method-intro' }, h('strong', {}, 'Un orientamento per adulti.'), h('p', {}, 'Pasti propone stime generiche. Non effettua diagnosi né sostituisce un piano concordato con un dietista o medico. Le esigenze individuali possono essere diverse.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Da te al fabbisogno giornaliero'),
      h('p', {}, 'Peso, altezza, età e sesso usato nella formula stimano l’energia a riposo con l’equazione di ', source('Mifflin–St Jeor', 'https://doi.org/10.1093/ajcn/51.2.241'), '. Non è una misurazione del tuo metabolismo.'),
      h('p', { class: 'method-formula' }, '10 × peso in kg + 6,25 × altezza in cm − 5 × età + costante'),
      h('p', { class: 'helper' }, 'La costante è +5 per il sesso maschile e −161 per quello femminile. Lo studio originale riguarda adulti di 19–78 anni: al di fuori di quell’intervallo compare un avviso.'),
      h('p', {}, 'Il risultato viene moltiplicato per il livello di attività che scegli. Questi fattori sono riferimenti orientativi e comprendono già corsa e sala attrezzi:'),
      h('dl', { class: 'activity-factors' }, ...ACTIVITY_LEVELS.map(level => h('div', {}, h('dt', {}, level.label.split(' · ')[0]), h('dd', {}, `× ${level.factor.toLocaleString('it-IT', { maximumFractionDigits: 3 })}`)))),
      h('p', {}, 'Per mantenere il peso usiamo questa stima. Per perdere peso sottraiamo il deficit in kcal scelto nel profilo: puoi indicare anche 0. I profili precedenti conservano il vecchio deficit del 10% finché non salvi una scelta esplicita. Per aumentare il peso applichiamo il 5% in più. Il consumo totale è una media che include gli allenamenti, senza calorie aggiunte per corsa o sala attrezzi.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Proteine, carboidrati e grassi'),
      h('p', {}, 'Le proteine partono da 1,6 g per kg di peso al giorno, oppure 1,8 g/kg durante il deficit. Sono valori orientativi entro l’intervallo descritto dalla ', source('posizione ISSN su proteine ed esercizio', 'https://doi.org/10.1186/s12970-017-0177-8'), ' per adulti sani che si allenano.'),
      h('p', {}, 'Il 30% dell’energia viene assegnato ai grassi; ai carboidrati va ciò che resta. Le proteine sono limitate al 35% dell’energia per lasciare spazio agli altri nutrienti: se questo limite si applica, vedrai un avviso.'),
      h('p', {}, 'Questa ripartizione è un punto di partenza dell’app. Le porzioni pratiche e gli alimenti scelti possono produrre totali diversi: nel diario trovi sempre i valori effettivi.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Gli alimenti e le tue confezioni'),
      h('p', {}, 'Il catalogo usa valori per 100 g di parte edibile, principalmente dalle ', source('tabelle CREA', 'https://www.alimentinutrizione.it/tabelle-nutrizionali/'), '. Ogni alimento ha il proprio collegamento alla fonte nella sezione Alimenti.'),
      h('p', {}, 'Pasta, riso e couscous si pesano a secco; carne e pesce a crudo senza scarti; tonno sgocciolato. Pane, yogurt e dessert si pesano come consumati. Contano anche tutto l’olio e il cioccolato utilizzati.'),
      h('p', {}, 'Le calorie e i macronutrienti del pasto sono la somma degli ingredienti nei grammi indicati. Sono incluse anche le proteine di pasta, avena e lenticchie. L’energia delle fonti può differire dalla semplice somma delle calorie dei tre macronutrienti.'),
      h('h3', {}, 'Pasta di lenticchie, budino e mousse Lidl'),
      h('p', {}, 'Il catalogo distingue la pasta secca da quella fresca e le diverse varianti dei dessert. Le schede con il badge “Etichetta verificata” riportano formato, mercato, data di verifica, EAN quando disponibile e un collegamento all’etichetta. Usa la scheda che corrisponde alla tua confezione: gusti e formati diversi possono avere valori diversi.'),
      h('p', {}, 'Le varianti verificate hanno già i valori per 100 g in ', h('a', { href: '#foods' }, 'Alimenti'), '. Per una confezione diversa puoi personalizzarli: è facoltativo. Le modifiche si applicano ai nuovi piani e ai pasti che modifichi, senza riscrivere lo storico.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Come leggere il diario'), h('dl', { class: 'method-definitions' },
      h('dt', {}, 'Obiettivo stimato'), h('dd', {}, 'Il riferimento giornaliero calcolato con il profilo salvato per quella data.'),
      h('dt', {}, 'Pianificato'), h('dd', {}, 'La somma dei pasti del giorno, escluso il preallenamento se lo salti.'),
      h('dt', {}, 'Consumato'), h('dd', {}, 'La somma dei soli pasti che hai segnato come mangiati. I pasti registrati conservano dosi e valori del momento.'),
      h('dt', {}, 'Grammi e alternative'), h('dd', {}, 'Le alternative cambiano i grammi e tutti i macronutrienti. Per pasta, riso e couscous considera il peso secco; per gli altri cibi leggi la nota.')),
      h('p', {}, 'Il diario conserva un’istantanea per ogni data aperta. Modificare il profilo o un’etichetta non riscrive i giorni già salvati. Puoi ancora modificare i pasti non registrati, uno per volta.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Quando serve una valutazione personale'),
      h('p', {}, 'In gravidanza, allattamento, con patologie o disturbi alimentari il calcolo automatico si ferma. Anche un peso molto basso o elevato, o una stima energetica insolita, richiede attenzione e può generare avvisi. Questi controlli non valutano l’adeguatezza clinica del piano.'),
      h('p', {}, 'Il preallenamento è facoltativo: adattalo alla fame, alla digestione e alla tua routine. Gli orari proposti sono indicativi; non devi mangiare immediatamente prima di allenarti.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Dati e installazione'), h('p', {}, 'I dati sono conservati nella memoria di questo browser. Nessun account, nessun invio di profilo o diario a servizi esterni. I backup JSON contengono dati personali: conservali con attenzione.'), h('p', {}, 'Puoi aggiungere Pasti alla schermata Home dal menu del browser. La pagina richiede una connessione per essere caricata.'), source('Documentazione del metodo', './docs/nutrition.md')));
}

window.addEventListener('hashchange', () => { render(); $('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); });
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  if ($('#app-dialog').open || unsaved) {
    storageConflict = true;
    notify('I dati sono cambiati in un’altra scheda. Il salvataggio è sospeso: scarica un backup e ricarica la pagina.', true);
    render();
    return;
  }
  const current = loadData(); data = current.data; storageReadError = current.error; render(); notify('Dati aggiornati dall’altra scheda.');
});
render();
