import { quantitySpec, toDisplayAmount, toStoredAmount } from './food-measures.js?v=20261027-oil';
import { validatePersonalFood, normalizeBarcode, lookupProduct, createBarcodeScanner } from './barcode.js?v=20261027-neutral';

// The picker only edits the meal draft. Persistence belongs to Save meal.
export function createMealFoodPicker({ h, field, button, getFoods, add, getUsualQuantity = (_id, _food, fallback) => fallback, allowRemember = true, context = 'meal' }) {
  let disposed = false, request, generation = 0, mode = 'search';
  const root = h('section', { class: 'meal-food-picker', 'aria-label': 'Aggiungi ingredienti' });
  const chooser = h('div', { class: 'picker-chooser', hidden: true });
  const launcher = button('Aggiungi alimento', () => open(), 'button secondary', { 'aria-expanded': 'false' });
  const results = h('div', { class: 'picker-results' });
  const editor = h('div', { class: 'picker-editor' });
  const status = h('p', { class: 'helper picker-status', role: 'status', 'aria-live': 'polite' });
  const fmt = value => value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
  const macros = (food, amount) => `${fmt(food.kcal * amount / 100)} kcal · P ${fmt(food.protein * amount / 100)} g · C ${fmt(food.carbs * amount / 100)} g · G ${fmt(food.fat * amount / 100)} g`;
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const search = h('input', { type: 'search', placeholder: 'Es. pollo, riso, yogurt…', 'aria-label': 'Cerca un alimento', oninput: () => { stopPending(); renderResults(); } });
  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'barcode-video' });
  video.muted = true;
  const camera = h('div', { hidden: true, class: 'picker-camera' }, video,
    button('Chiudi fotocamera', () => { stopPending(); status.textContent = 'Fotocamera chiusa.'; }));
  const scanner = createBarcodeScanner({ video,
    onCode: code => { codeInput.value = code; void findBarcode(code); },
    onError: message => { camera.hidden = true; status.textContent = message; },
  });
  const codeInput = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 24, placeholder: 'EAN / UPC', 'aria-label': 'Codice a barre del prodotto' });
  const codeButton = h('button', { type: 'submit', class: 'button secondary' }, 'Cerca codice');
  const barcodeForm = h('form', { class: 'barcode-search picker-barcode-form', onsubmit: event => { event.preventDefault(); void findBarcode(codeInput.value); } },
    field('Codice a barre', codeInput), codeButton);
  const searchPanel = h('div', { class: 'picker-search-panel' }, field('Cerca nel catalogo e nelle tue porzioni', search), results);
  const barcodePanel = h('div', { class: 'picker-barcode', hidden: true },
    button('Inquadra codice a barre', () => { stopPending(); editor.replaceChildren(); camera.hidden = false; status.textContent = 'Inquadra il codice del prodotto.'; void scanner.start(); }, 'button secondary'),
    camera, barcodeForm,
    h('p', { class: 'helper' }, 'La scansione resta sul dispositivo. Solo il codice viene cercato su Open Food Facts.'),
    h('p', { class: 'helper' }, 'Dati: ', h('a', { href: 'https://world.openfoodfacts.org', target: '_blank', rel: 'noopener noreferrer' }, 'Open Food Facts'), ' · ', h('a', { href: 'https://opendatacommons.org/licenses/odbl/1-0/', target: '_blank', rel: 'noopener noreferrer' }, 'ODbL')));
  const modeButtons = [
    ['search', 'Cerca'], ['barcode', 'Codice a barre'], ['manual', 'A mano'],
  ].map(([id, label]) => button(label, () => chooseMode(id), 'button secondary small', { 'aria-pressed': id === mode ? 'true' : 'false' }));
  const modes = h('div', { class: 'picker-modes form-actions', role: 'group', 'aria-label': 'Come aggiungere un alimento' }, ...modeButtons);
  const back = button('Torna alla ricerca', () => chooseMode(mode === 'manual' ? 'search' : mode), 'text-button', { hidden: true });
  function showEditor() {
    searchPanel.hidden = true; barcodePanel.hidden = true; modes.hidden = true; back.hidden = false;
    back.textContent = mode === 'barcode' ? 'Torna al codice a barre' : 'Torna alla ricerca';
  }
  function chooseMode(nextMode) {
    if (disposed) return;
    stopPending(); mode = nextMode; editor.replaceChildren();
    modes.hidden = false; back.hidden = true; status.textContent = '';
    searchPanel.hidden = mode !== 'search'; barcodePanel.hidden = mode !== 'barcode';
    modeButtons.forEach((control, index) => control.setAttribute('aria-pressed', ['search', 'barcode', 'manual'][index] === mode ? 'true' : 'false'));
    if (mode === 'search') { renderResults(); search.focus(); }
    else if (mode === 'barcode') codeInput.focus();
    else manualFood();
  }
  function open() {
    if (disposed) return;
    launcher.hidden = true; launcher.setAttribute('aria-expanded', 'true'); chooser.hidden = false;
    root.setAttribute('data-open', 'true'); chooseMode('search');
  }
  function close(message = '', focus = true) {
    stopPending(); editor.replaceChildren(); results.replaceChildren(); search.value = ''; codeInput.value = '';
    chooser.hidden = true; launcher.hidden = false; launcher.setAttribute('aria-expanded', 'false');
    root.setAttribute('data-open', 'false'); status.textContent = message;
    if (focus && !disposed) launcher.focus();
  }
  function stopPending() {
    generation++; request?.abort(); request = null;
    scanner.stop(); camera.hidden = true; codeButton.disabled = false;
  }
  async function findBarcode(input) {
    let barcode;
    try { barcode = normalizeBarcode(input); } catch (error) { status.textContent = error.message; return; }
    stopPending(); editor.replaceChildren();
    const saved = getFoods().find(item => (item.food.barcode || item.food.label?.barcode) === barcode);
    if (saved) { selectFood(saved); status.textContent = 'Prodotto trovato tra i tuoi alimenti.'; return; }
    const current = generation;
    request = new AbortController(); codeButton.disabled = true;
    status.textContent = 'Cerco il prodotto su Open Food Facts…';
    try {
      const food = await lookupProduct(barcode, { signal: request.signal });
      if (disposed || current !== generation) return;
      manualFood(food);
      status.textContent = 'Prodotto trovato: verifica i valori dell’etichetta e scegli la quantità.';
    } catch (error) {
      if (disposed || current !== generation) return;
      manualFood({ barcode });
      status.textContent = error.message;
    } finally { if (!disposed && current === generation) codeButton.disabled = false; }
  }
  function renderResults() {
    const words = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
    if (!words.length) {
      results.replaceChildren(); status.textContent = 'Scrivi il nome di un alimento per cercarlo.'; return;
    }
    const matches = getFoods().filter(item => words.every(word => normalize(`${item.food.name} ${item.food.brand || ''}`).includes(word)));
    const shown = matches.slice(0, 15);
    results.replaceChildren(...shown.map(item => button([
      h('strong', {}, item.food.name),
      h('small', {}, `${item.personal ? 'Personale · ' : ''}${item.food.brand ? `${item.food.brand} · ` : ''}Per 100 ${item.food.unit}: ${macros(item.food, 100)}`),
    ], () => selectFood(item), 'picker-result', { 'aria-label': `Scegli ${item.food.name}` })));
    status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'alimento' : 'alimenti'}${matches.length > shown.length ? ' · Affina la ricerca per vedere gli altri.' : ''}` : 'Nessun alimento trovato. Scegli “A mano” per inserirlo.';
  }
  function validAmount(amount, spec) {
    const value = amount.valueAsNumber;
    return amount.value !== '' && Number.isFinite(value) && value >= spec.min && value <= spec.max
      && (spec.factor === 1 || Math.abs(value / spec.step - Math.round(value / spec.step)) < 1e-7);
  }
  const amountHint = spec => spec.factor === 1 ? 'Inserisci una quantità tra 0,1 e 3.000.' : 'Per l’olio usa multipli di 0,25 cucchiai.';
  function selectFood(item) {
    stopPending(); showEditor(); status.textContent = '';
    const spec = quantitySpec(item.id, item.food);
    const amount = h('input', { type: 'number', min: spec.min, max: spec.max, step: spec.step, required: true, inputmode: 'decimal', value: toDisplayAmount(item.id, item.food, getUsualQuantity(item.id, item.food, item.grams || 100)), 'aria-label': `Quantità da aggiungere in ${spec.unit}` });
    const remember = h('input', { type: 'checkbox', class: 'remember-quantity' });
    const preview = h('p', { class: 'portion-totals', role: 'status' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const update = () => { preview.textContent = validAmount(amount, spec) ? macros(item.food, toStoredAmount(item.id, item.food, amount.valueAsNumber)) : amountHint(spec); };
    amount.addEventListener('input', update);
    editor.replaceChildren(h('form', { class: 'picker-amount-form', onsubmit: event => {
      event.preventDefault();
      if (!validAmount(amount, spec)) { error.textContent = amountHint(spec); amount.reportValidity(); return; }
      try {
        add({ foodId: item.id, grams: toStoredAmount(item.id, item.food, amount.valueAsNumber), ...(item.personal ? { foodSnapshot: { ...item.food } } : {}) }, null, allowRemember && remember.checked);
        close(`${item.food.name} aggiunto ${context === 'recipe' ? 'alla ricetta' : 'al pasto'}.`);
      } catch (e) { error.textContent = e.message; }
    } }, h('h4', {}, item.food.name), field(`Quantità · ${spec.unit}`, amount, item.food.unitNote), preview, allowRemember && h('label', { class: 'picker-remember' }, remember, 'Usa questa quantità come abituale'), error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Aggiungi ingrediente'), button('Annulla aggiunta', () => chooseMode(mode)))));
    update(); amount.focus();
  }
  function manualFood(food = {}) {
    stopPending(); showEditor();
    const newId = `personal-${crypto.randomUUID()}`;
    const name = h('input', { required: true, maxlength: 200, value: food.name || '', 'aria-label': 'Nome nuovo alimento' });
    const brand = h('input', { maxlength: 200, value: food.brand || '' });
    const unit = h('select', {}, h('option', { value: 'g', selected: food.unit !== 'ml' }, '100 g'), h('option', { value: 'ml', selected: food.unit === 'ml' }, '100 ml'));
    const initialFood = { ...food, unit: food.unit || 'g' };
    let spec = quantitySpec(newId, initialFood);
    const amount = h('input', { type: 'number', min: spec.min, max: spec.max, step: spec.step, required: true, inputmode: 'decimal', value: toDisplayAmount(newId, initialFood, getUsualQuantity(newId, initialFood, 100)) });
    const quantityLabel = h('span', {}, 'Quantità da aggiungere · g');
    const inputs = {};
    const metrics = [['kcal', 'Calorie · kcal', 1000], ['protein', 'Proteine · g', 100], ['carbs', 'Carboidrati · g', 100], ['fat', 'Grassi · g', 100]];
    const error = h('p', { class: 'form-error', role: 'alert' });
    const remember = h('input', { type: 'checkbox', checked: true });
    const preview = h('p', { class: 'portion-totals', role: 'status' });
    const read = () => validatePersonalFood({ name: name.value.trim(), brand: brand.value.trim(), barcode: food.barcode || '', unit: unit.value,
      ...Object.fromEntries(metrics.map(([key]) => [key, inputs[key].value === '' ? null : inputs[key].valueAsNumber])) });
    const update = () => {
      const identity = { name: name.value, unit: unit.value, fat: inputs.fat.valueAsNumber };
      const nextSpec = quantitySpec(newId, identity);
      if (spec.factor !== nextSpec.factor && Number.isFinite(amount.valueAsNumber) && amount.valueAsNumber >= 0 && (spec.factor === 1 || nextSpec.factor === 1)) {
        amount.value = toDisplayAmount(newId, identity, amount.valueAsNumber * spec.factor);
      }
      spec = nextSpec;
      for (const key of ['min', 'max', 'step']) amount.setAttribute(key, spec[key]);
      amount.setAttribute('aria-label', `Quantità da aggiungere in ${spec.unit}`);
      quantityLabel.textContent = `Quantità da aggiungere · ${spec.unit}`;
      try { const food = read(); preview.textContent = validAmount(amount, spec) ? macros(food, toStoredAmount(newId, food, amount.valueAsNumber)) : amountHint(spec); }
      catch { preview.textContent = 'Completa i valori dell’etichetta per calcolare la porzione.'; }
    };
    const form = h('form', { class: 'picker-manual-form', oninput: update, onchange: update, onsubmit: event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      try {
        const food = read();
        const id = newId;
        if (!validAmount(amount, spec)) throw new Error(amountHint(spec));
        const ingredient = { foodId: id, grams: toStoredAmount(id, food, amount.valueAsNumber), foodSnapshot: food };
        add(ingredient, allowRemember && remember.checked ? { id, food, grams: ingredient.grams } : null, allowRemember && remember.checked);
        close(`${food.name} aggiunto. Conferma con ${context === 'recipe' ? 'Salva ricetta' : 'Salva questo pasto'}.`);
      } catch (e) { error.textContent = e.message; }
    } }, h('h4', {}, food.barcode ? 'Alimento da codice a barre' : 'Nuovo alimento'),
    food.barcode && h('p', { class: 'helper' }, `Codice ${food.barcode}`),
    h('div', { class: 'form-grid' }, field('Nome', name), field('Marca · facoltativa', brand)),
    field('Valori in etichetta per', unit),
    h('div', { class: 'form-grid' }, ...metrics.map(([key, label, max]) => {
      inputs[key] = h('input', { type: 'number', min: 0, max, step: 'any', required: true, inputmode: 'decimal', 'data-metric': key, value: food[key] ?? '' });
      return field(label, inputs[key]);
    })), field(quantityLabel, amount), preview,
    allowRemember && h('label', { class: 'picker-remember' }, remember, 'Salva alimento e quantità abituale'), error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Aggiungi nuovo alimento'), button('Annulla aggiunta', () => chooseMode(mode === 'manual' ? 'search' : mode))));
    editor.replaceChildren(form); update(); name.focus();
  }
  chooser.append(h('div', { class: 'section-heading' }, h('h3', {}, 'Aggiungi un alimento'), button('Chiudi aggiunta', () => close(), 'text-button')),
    modes, back, searchPanel, barcodePanel, editor);
  root.append(launcher, chooser, status); root.setAttribute('data-open', 'false');
  const visibility = () => { if (document.hidden) stopPending(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stopPending);
  return { element: root, open, close, dispose: () => {
    disposed = true; stopPending();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', stopPending);
  } };
}
