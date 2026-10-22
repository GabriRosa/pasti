import { ACTIVITY_LEVELS, calculateTargets, sumMacros } from './src/nutrition.js';
import { FOODS, getFood } from './src/foods.js';
import { createDayPlan, mealFromIngredients, mealAlternatives, swapMealFood } from './src/planner.js';
import { STORAGE_KEY, MAX_BACKUP_BYTES, createEmptyData, validateData, parseBackup, loadData, saveData, exportBackup, clearData } from './src/storage.js';

const $ = selector => document.querySelector(selector);
const clone = value => JSON.parse(JSON.stringify(value));
const round = value => Math.round(value).toLocaleString('it-IT');
const formatDecimal = value => Number(value.toFixed(1)).toLocaleString('it-IT');
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const longDate = key => new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${key}T12:00:00`));
const CARBS = ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl'];
const PROTEINS = ['chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin'];
const LABEL_FOODS = ['lentil-pasta-lidl', 'protein-pudding-lidl', 'protein-mousse-lidl'];
const DAYS = [{ value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mer' }, { value: 4, label: 'Gio' }, { value: 5, label: 'Ven' }, { value: 6, label: 'Sab' }, { value: 0, label: 'Dom' }];
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

function renderToday() {
  if (!data.profile || storageReadError) return renderOnboarding();
  const day = getDay();
  const training = day.profileSnapshot.trainingDays.includes(new Date(`${selectedDate}T12:00:00`).getDay());
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
    h('section', { class: 'daily-overview', 'aria-label': 'Bilancio del giorno' },
      h('div', { class: 'energy-hero' },
        h('div', { class: 'overview-topline' }, h('span', { class: 'caps' }, 'ENERGIA CONSUMATA'), h('span', { class: 'day-badge' }, training ? `Palestra · ${day.profileSnapshot.trainingTime}` : 'Giorno di riposo')),
        h('div', { class: 'energy-value' }, h('strong', {}, round(consumed.kcal)), h('span', {}, 'kcal')),
        h('div', { class: 'energy-track', role: 'meter', 'aria-label': 'Calorie consumate rispetto all’obiettivo', 'aria-valuemin': 0, 'aria-valuemax': Math.max(day.targets.kcal, consumed.kcal), 'aria-valuenow': consumed.kcal, 'aria-valuetext': `${round(consumed.kcal)} consumate su ${round(day.targets.kcal)} kcal obiettivo` }, h('span', { style: `width:${Math.min(100, consumed.kcal / day.targets.kcal * 100)}%` })),
        h('div', { class: 'energy-footer' }, h('span', {}, remaining >= 0 ? `${round(remaining)} kcal all’obiettivo` : `${round(-remaining)} kcal oltre l’obiettivo`), h('span', {}, allEaten ? 'Giornata registrata ✓' : `${Object.keys(day.consumed).length} pasti registrati`))),
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
    !training && h('div', { class: 'rest-note' }, h('span', { 'aria-hidden': 'true' }, '☀'), h('p', {}, 'Oggi il piano prevede colazione, pranzo e cena. Il preallenamento compare solo nei giorni palestra del profilo.')),
    h('p', { class: 'page-footnote' }, 'Le quantità sono una base da adattare. I valori sono stime e non una prescrizione nutrizionale. ', h('a', { href: '#method' }, 'Leggi il metodo')));
}

function ingredientText(ingredient) {
  return `${getFood(ingredient.foodId, data.foodOverrides).name} · ${formatDecimal(ingredient.grams)} g`;
}

function renderMeal(meal, day, index) {
  const eaten = Boolean(day.consumed[meal.id]);
  const skipped = day.skipped.includes(meal.id);
  const displayMeal = eaten ? day.consumed[meal.id].meal : meal;
  const training = day.profileSnapshot.trainingDays.includes(new Date(`${day.dateKey}T12:00:00`).getDay());
  const afterTraining = training && meal.time > day.profileSnapshot.trainingTime;
  const slotName = ({ preworkout: 'Prima della palestra', breakfast: afterTraining ? 'Colazione dopo palestra' : 'Colazione', lunch: 'Pranzo', dinner: 'Cena' })[meal.slot];
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
  const alternatives = mealAlternatives(original, data.days[selectedDate].targets, data.foodOverrides);
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
          try { draft = swapMealFood(draft, current.foodId, event.target.value, data.foodOverrides); rebuild(); }
          catch (error) { errors.textContent = error.message; }
        } }, ...ids.map(id => h('option', { value: id, selected: id === current.foodId }, getFood(id).name)))));
      }
    }
    ingredientFields.replaceChildren(...draft.ingredients.map((ingredient, index) => {
      const food = getFood(ingredient.foodId, data.foodOverrides);
      const grams = h('input', { id: `ingredient-${index}`, type: 'number', min: '0', max: '3000', step: '0.1', inputmode: 'decimal', value: Number(ingredient.grams.toFixed(1)), 'aria-label': `${food.name}, grammi`, oninput: event => {
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
    if (choice) { draft = clone(choice); draft.id = original.id; draft.slot = original.slot; draft.time = original.time; rebuild(); }
  } }, h('option', { value: '' }, 'Scegli un’alternativa…'), h('option', { value: '-1' }, 'Pasto originale'), ...alternatives.map((meal, index) => h('option', { value: index }, meal.title)));
  container.append(dialogHeading('Fai spazio alle tue scelte', 'Le dosi ricalcolano energia e macronutrienti.'), field('Alternative del pasto', variantSelect, original.slot === 'breakfast' ? 'Tra le colazioni: budino proteico, mousse proteica e yogurt greco con cioccolato.' : null), controls, ingredientFields,
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
        h('ul', { class: 'check-list' }, h('li', {}, 'Palestra alle 06:00, orario modificabile'), h('li', {}, 'Preallenamento piccolo e facoltativo'), h('li', {}, 'Dati salvati soltanto in questo browser')),
        h('p', { class: 'aside-footnote' }, 'Le stime sono pensate per adulti e non sostituiscono un professionista.'))));
}

function renderProfileForm() {
  const profile = data.profile;
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'profile-form' });
  const input = (name, attrs) => h('input', { name, value: profile?.[name] ?? '', required: true, ...attrs });
  const fields = h('fieldset', { class: 'profile-fields', disabled: Boolean(storageReadError) },
    h('legend', { class: 'form-section-title' }, 'Le informazioni di base'),
    h('div', { class: 'form-grid' },
      field('Età', input('age', { type: 'number', min: 18, max: 100, step: 1, inputmode: 'numeric', autocomplete: 'off', placeholder: 'Anni' })),
      field('Sesso usato nella formula', h('select', { name: 'sex', required: true }, h('option', { value: '', selected: !profile }, 'Scegli…'), h('option', { value: 'female', selected: profile?.sex === 'female' }, 'Femminile'), h('option', { value: 'male', selected: profile?.sex === 'male' }, 'Maschile')), 'La formula usa un coefficiente diverso.'),
      field('Peso attuale · kg', input('weight', { type: 'number', min: 35, max: 250, step: '0.1', inputmode: 'decimal', placeholder: 'kg' })),
      field('Altezza · cm', input('height', { type: 'number', min: 130, max: 230, step: '0.1', inputmode: 'decimal', placeholder: 'cm' }))),
    field('Attività abituale', h('select', { name: 'activity', required: true }, h('option', { value: '', selected: !profile }, 'Scegli il livello di attività…'), ...ACTIVITY_LEVELS.map(level => h('option', { value: level.id, selected: profile?.activity === level.id }, level.label))), 'Considera la tua intera settimana, allenamenti inclusi.'),
    field('Il tuo obiettivo', h('select', { name: 'goal', required: true }, h('option', { value: '', selected: !profile }, 'Scegli un obiettivo…'), ...[{ id: 'lose', name: 'Perdere peso gradualmente' }, { id: 'maintain', name: 'Mantenere il peso' }, { id: 'gain', name: 'Aumentare il peso gradualmente' }].map(goal => h('option', { value: goal.id, selected: profile?.goal === goal.id }, goal.name)))),
    h('div', { class: 'form-divider' }), h('h2', { class: 'form-section-title' }, 'Il ritmo della palestra'),
    field('Orario di allenamento', h('input', { name: 'trainingTime', type: 'time', value: profile?.trainingTime || '06:00', required: true })),
    h('fieldset', { class: 'days-fieldset' }, h('legend', {}, 'In quali giorni ti alleni?'), h('div', { class: 'day-options' }, ...DAYS.map(day => h('label', { class: 'day-option' }, h('input', { type: 'checkbox', name: 'trainingDays', value: day.value, checked: profile?.trainingDays.includes(day.value) }), h('span', {}, day.label)))), h('small', { class: 'helper' }, 'Puoi lasciare tutti i giorni liberi. Nei giorni di riposo non c’è il preallenamento.')),
    h('label', { class: 'condition-check' }, h('input', { type: 'checkbox', name: 'specialCondition', checked: profile?.specialCondition }), h('span', {}, 'Ho una condizione clinica, sono in gravidanza o allatto.')),
    h('p', { class: 'helper' }, 'In questi casi serve una valutazione individuale prima di usare un piano alimentare.'),
    error,
    h('button', { type: 'submit', class: 'button primary wide' }, profile ? 'Salva profilo' : 'Crea la mia giornata'),
    profile && h('p', { class: 'helper' }, 'Le modifiche valgono per i giorni che aprirai per la prima volta. I giorni già salvati mantengono profilo, obiettivi e pasti originali.'));
  form.append(fields);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const nextProfile = {
      age: Number(values.get('age')), sex: values.get('sex'), weight: Number(values.get('weight')), height: Number(values.get('height')),
      activity: values.get('activity'), goal: values.get('goal'), trainingTime: values.get('trainingTime'),
      trainingDays: values.getAll('trainingDays').map(Number), specialCondition: values.get('specialCondition') === 'on',
    };
    try {
      calculateTargets(nextProfile);
      const next = clone(data); next.profile = nextProfile;
      persist(next);
      selectedDate = localDate(); location.hash = 'today'; render(); notify('Profilo salvato. La tua giornata è pronta.');
    } catch (failure) { error.textContent = failure.message; error.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });
  return form;
}

function renderProfile() {
  return h('div', { class: 'page' },
    pageTitle('LE TUE INFORMAZIONI', 'Il tuo profilo.', 'Aggiorna i dati da cui partono le stime.'),
    h('div', { class: 'profile-layout' }, h('section', { class: 'panel profile-panel' }, renderProfileForm()),
      h('aside', { class: 'profile-side' }, data.profile && renderTargetPreview(), renderDataTools())));
}

function renderTargetPreview() {
  const targets = calculateTargets(data.profile);
  return h('section', { class: 'panel target-preview' }, h('p', { class: 'eyebrow' }, 'STIMA DAL PROFILO ATTUALE'), h('h2', {}, round(targets.kcal), h('small', {}, ' kcal al giorno')),
    h('div', { class: 'target-macros' }, h('span', {}, `P ${round(targets.protein)} g`), h('span', {}, `C ${round(targets.carbs)} g`), h('span', {}, `G ${round(targets.fat)} g`)),
    h('p', { class: 'helper' }, 'È una stima, non una prescrizione. Il diario mantiene gli obiettivi del profilo salvato per ciascun giorno.'),
    ...targets.warnings.map(warning => h('p', { class: 'notice compact' }, warning)), h('a', { href: '#method' }, 'Come viene calcolata →'));
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

function renderFoods() {
  const food = getFood(labelFoodId, data.foodOverrides);
  const orderedFoods = [...LABEL_FOODS.map(id => FOODS.find(item => item.id === id)).filter(Boolean), ...FOODS.filter(item => !LABEL_FOODS.includes(item.id))];
  const formError = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'label-form' },
    field('Prodotto', h('select', { value: labelFoodId, onchange: event => { labelFoodId = event.target.value; render(); } }, ...orderedFoods.map(item => h('option', { value: item.id, selected: item.id === labelFoodId }, item.name)))),
    h('p', { class: 'food-estimate-note' }, data.foodOverrides[labelFoodId] ? 'Valori personalizzati dalla tua etichetta.' : LABEL_FOODS.includes(labelFoodId) ? 'Valori generici stimati: non sono un’etichetta Lidl verificata. Trascrivi i valori della tua confezione.' : 'Valori di riferimento dal catalogo. Se la tua confezione riporta valori diversi, trascrivili qui.'),
    h('div', { class: 'form-grid label-grid' }, ...[{ key: 'kcal', label: 'Energia · kcal', max: 1000 }, { key: 'protein', label: 'Proteine · g', max: 100 }, { key: 'carbs', label: 'Carboidrati · g', max: 100 }, { key: 'fat', label: 'Grassi · g', max: 100 }].map(metric => field(metric.label, h('input', { name: metric.key, type: 'number', required: true, min: 0, max: metric.max, step: '0.1', inputmode: 'decimal', value: food[metric.key] })))),
    formError, h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Salva valori per 100 g'), data.foodOverrides[labelFoodId] && button('Ripristina la stima', () => {
      try { const next = clone(data); delete next.foodOverrides[labelFoodId]; persist(next); render(); notify('Ripristinati i valori stimati per i nuovi piani.'); } catch (error) { notify(error.message, true); }
    }, 'text-button')),
    h('p', { class: 'helper' }, 'I nuovi valori si usano nei piani creati da ora e nei pasti che modifichi. I pasti salvati e le registrazioni passate restano invariati. Per usare un intero vasetto modifica i grammi del pasto in base al peso in confezione.'));
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    try {
      const values = new FormData(form);
      const next = clone(data);
      next.foodOverrides[labelFoodId] = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, Number(values.get(key))]));
      getFood(labelFoodId, next.foodOverrides); persist(next); render(); notify('Etichetta salvata per i nuovi piani.');
    } catch (error) { formError.textContent = error.message; }
  });
  return h('div', { class: 'page foods-page' }, pageTitle('QUELLO CHE MANGI', 'Alimenti e quantità.', 'Pesi chiari e valori per 100 g. La confezione che hai in mano è il riferimento.'),
    h('section', { class: 'panel label-panel' }, h('div', { class: 'section-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'DALLA TUA CONFEZIONE'), h('h2', {}, 'Personalizza l’etichetta'), h('p', {}, 'Scegli un alimento e copia i valori per 100 g della tua confezione.'))), form),
    h('div', { class: 'section-heading' }, h('div', {}, h('h2', {}, 'Il catalogo del piano'), h('p', {}, 'Energia e macronutrienti per 100 g di parte edibile.'))),
    h('div', { class: 'food-catalog' }, ...FOODS.map(base => {
      const item = getFood(base.id, data.foodOverrides);
      return h('article', { class: 'food-card' }, h('div', { class: 'food-card-top' }, h('h3', {}, item.name), (data.foodOverrides[item.id] || item.estimated) && h('span', { class: 'estimate-tag' }, data.foodOverrides[item.id] ? 'Tua etichetta' : 'Stima')),
        h('p', { class: 'food-calories' }, h('strong', {}, round(item.kcal)), ' kcal'),
        h('p', { class: 'food-macros' }, `P ${formatDecimal(item.protein)} g · C ${formatDecimal(item.carbs)} g · G ${formatDecimal(item.fat)} g`),
        h('p', { class: 'helper' }, item.unitNote), h('p', { class: 'food-source' }, /^https?:\/\//.test(item.source) ? h('a', { href: item.source, target: '_blank', rel: 'noopener noreferrer' }, 'Consulta la fonte ↗') : item.source));
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
      h('p', {}, 'Il risultato viene moltiplicato per il livello di attività che scegli. Questi fattori sono riferimenti orientativi e comprendono già la palestra:'),
      h('dl', { class: 'activity-factors' }, ...ACTIVITY_LEVELS.map(level => h('div', {}, h('dt', {}, level.label.split(' · ')[0]), h('dd', {}, `× ${level.factor.toLocaleString('it-IT', { maximumFractionDigits: 3 })}`)))),
      h('p', {}, 'Per mantenere il peso usiamo questa stima. Per perdere peso la riduciamo del 10%; per aumentarlo la alziamo del 5%. Sono scelte moderate di Pasti, non una promessa di risultato. I giorni di riposo mantengono lo stesso obiettivo.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Proteine, carboidrati e grassi'),
      h('p', {}, 'Le proteine partono da 1,6 g per kg di peso al giorno, oppure 1,8 g/kg durante il deficit. Sono valori orientativi entro l’intervallo descritto dalla ', source('posizione ISSN su proteine ed esercizio', 'https://doi.org/10.1186/s12970-017-0177-8'), ' per adulti sani che si allenano.'),
      h('p', {}, 'Il 30% dell’energia viene assegnato ai grassi; ai carboidrati va ciò che resta. Le proteine sono limitate al 35% dell’energia per lasciare spazio agli altri nutrienti: se questo limite si applica, vedrai un avviso.'),
      h('p', {}, 'Questa ripartizione è un punto di partenza dell’app. Le porzioni pratiche e gli alimenti scelti possono produrre totali diversi: nel diario trovi sempre i valori effettivi.')),
    h('section', { class: 'panel method-panel' }, h('h2', {}, 'Gli alimenti e le tue confezioni'),
      h('p', {}, 'Il catalogo usa valori per 100 g di parte edibile, principalmente dalle ', source('tabelle CREA', 'https://www.alimentinutrizione.it/tabelle-nutrizionali/'), '. Ogni alimento ha il proprio collegamento alla fonte nella sezione Alimenti.'),
      h('p', {}, 'Pasta, riso e couscous si pesano a secco; carne e pesce a crudo senza scarti; tonno sgocciolato. Pane, yogurt e dessert si pesano come consumati. Contano anche tutto l’olio e il cioccolato utilizzati.'),
      h('p', {}, 'Le calorie e i macronutrienti del pasto sono la somma degli ingredienti nei grammi indicati. Sono incluse anche le proteine di pasta, avena e lenticchie. L’energia delle fonti può differire dalla semplice somma delle calorie dei tre macronutrienti.'),
      h('h3', {}, 'Pasta di lenticchie, budino e mousse Lidl'),
      h('p', {}, 'I valori iniziali sono stime da prodotti analoghi, non etichette italiane Lidl verificate. Anche il vasetto da 200 g è solo un esempio: controlla il tuo formato e modifica i grammi del pasto.'),
      h('p', {}, 'Trascrivi tutti e quattro i valori per 100 g dalla confezione in ', h('a', { href: '#foods' }, 'Alimenti'), '. I valori salvati si applicano ai nuovi piani e ai pasti che modifichi, senza riscrivere lo storico.')),
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
