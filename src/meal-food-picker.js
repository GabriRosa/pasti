import { validatePersonalFood, normalizeBarcode, lookupProduct, createBarcodeScanner } from './barcode.js?v=20261027-neutral';

// The picker only edits the meal draft. Persistence belongs to Save meal.
export function createMealFoodPicker({ h, field, button, getFoods, add, getUsualQuantity = (_id, _food, fallback) => fallback, allowRemember = true, context = 'meal' }) {
  let disposed = false, request, generation = 0;
  const root = h('section', { class: 'meal-food-picker', 'aria-label': 'Aggiungi ingredienti' });
  const results = h('div', { class: 'picker-results' });
  const editor = h('div', { class: 'picker-editor' });
  const status = h('p', { class: 'helper', role: 'status' });
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
    const matches = getFoods().filter(item => words.every(word => normalize(`${item.food.name} ${item.food.brand || ''}`).includes(word)));
    const shown = matches.slice(0, 15);
    results.replaceChildren(...shown.map(item => button([
      h('strong', {}, item.food.name),
      h('small', {}, `${item.personal ? 'Personale · ' : ''}${item.food.brand ? `${item.food.brand} · ` : ''}Per 100 ${item.food.unit}: ${macros(item.food, 100)}`),
    ], () => selectFood(item), 'picker-result', { 'aria-label': `Scegli ${item.food.name}` })));
    status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'alimento' : 'alimenti'}${matches.length > shown.length ? ' · Affina la ricerca per vedere gli altri.' : ''}` : 'Nessun alimento trovato. Puoi inserirlo a mano qui sotto.';
  }
  function selectFood(item) {
    stopPending();
    const amount = h('input', { type: 'number', min: .1, max: 3000, step: .1, required: true, inputmode: 'decimal', value: getUsualQuantity(item.id, item.food, item.grams || 100), 'aria-label': `Quantità da aggiungere in ${item.food.unit}` });
    const remember = h('input', { type: 'checkbox', class: 'remember-quantity' });
    const preview = h('p', { class: 'portion-totals', role: 'status' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const update = () => { preview.textContent = amount.value !== '' && amount.checkValidity() ? macros(item.food, amount.valueAsNumber) : 'Inserisci una quantità tra 0,1 e 3.000.'; };
    amount.addEventListener('input', update);
    editor.replaceChildren(h('form', { class: 'picker-amount-form', onsubmit: event => {
      event.preventDefault();
      if (!amount.checkValidity() || amount.value === '') { error.textContent = 'Inserisci una quantità tra 0,1 e 3.000.'; amount.reportValidity(); return; }
      try {
        add({ foodId: item.id, grams: amount.valueAsNumber, ...(item.personal ? { foodSnapshot: { ...item.food } } : {}) }, null, allowRemember && remember.checked);
        editor.replaceChildren(); status.textContent = `${item.food.name} aggiunto ${context === 'recipe' ? 'alla ricetta' : 'al pasto'}.`;
      } catch (e) { error.textContent = e.message; }
    } }, h('h4', {}, item.food.name), field(`Quantità · ${item.food.unit}`, amount, item.food.unitNote), preview, allowRemember && h('label', { class: 'picker-remember' }, remember, 'Usa questa quantità come abituale'), error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Aggiungi ingrediente'), button('Annulla aggiunta', () => editor.replaceChildren()))));
    update(); amount.focus();
  }
  function manualFood(food = {}) {
    stopPending();
    const newId = `personal-${crypto.randomUUID()}`;
    const name = h('input', { required: true, maxlength: 200, value: food.name || '', 'aria-label': 'Nome nuovo alimento' });
    const brand = h('input', { maxlength: 200, value: food.brand || '' });
    const unit = h('select', {}, h('option', { value: 'g', selected: food.unit !== 'ml' }, '100 g'), h('option', { value: 'ml', selected: food.unit === 'ml' }, '100 ml'));
    const amount = h('input', { type: 'number', min: .1, max: 3000, step: .1, required: true, inputmode: 'decimal', value: getUsualQuantity(newId, { ...food, unit: food.unit || 'g' }, 100) });
    const quantityLabel = h('span', {}, 'Quantità da aggiungere · g');
    const inputs = {};
    const metrics = [['kcal', 'Calorie · kcal', 1000], ['protein', 'Proteine · g', 100], ['carbs', 'Carboidrati · g', 100], ['fat', 'Grassi · g', 100]];
    const error = h('p', { class: 'form-error', role: 'alert' });
    const remember = h('input', { type: 'checkbox', checked: true });
    const preview = h('p', { class: 'portion-totals', role: 'status' });
    const read = () => validatePersonalFood({ name: name.value.trim(), brand: brand.value.trim(), barcode: food.barcode || '', unit: unit.value,
      ...Object.fromEntries(metrics.map(([key]) => [key, inputs[key].value === '' ? null : inputs[key].valueAsNumber])) });
    const update = () => { quantityLabel.textContent = `Quantità da aggiungere · ${unit.value}`; try { const food = read(); preview.textContent = amount.value !== '' && amount.checkValidity() ? macros(food, amount.valueAsNumber) : ''; } catch { preview.textContent = 'Completa i valori dell’etichetta per calcolare la porzione.'; } };
    const form = h('form', { class: 'picker-manual-form', oninput: update, onchange: update, onsubmit: event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      try {
        const food = read();
        const id = newId;
        const ingredient = { foodId: id, grams: amount.valueAsNumber, foodSnapshot: food };
        add(ingredient, allowRemember && remember.checked ? { id, food, grams: ingredient.grams } : null, allowRemember && remember.checked);
        editor.replaceChildren(); status.textContent = `${food.name} aggiunto. Conferma con ${context === 'recipe' ? 'Salva ricetta' : 'Salva questo pasto'}.`;
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
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Aggiungi nuovo alimento'), button('Annulla aggiunta', () => editor.replaceChildren())));
    editor.replaceChildren(form); update(); name.focus();
  }
  root.append(h('h3', {}, 'Aggiungi ingredienti'), field('Cerca nel catalogo e nelle tue porzioni', search), status, results,
    button('Inserisci un alimento a mano', () => manualFood(), 'text-button'), editor,
    h('div', { class: 'picker-barcode' }, h('h4', {}, 'Aggiungi con codice a barre'),
      button('Inquadra codice a barre', () => { stopPending(); editor.replaceChildren(); camera.hidden = false; status.textContent = 'Inquadra il codice del prodotto.'; void scanner.start(); }, 'button primary'),
      camera, barcodeForm,
      h('p', { class: 'helper' }, 'La scansione resta sul dispositivo. Solo il codice viene cercato su Open Food Facts.'),
      h('p', { class: 'helper' }, 'Dati: ', h('a', { href: 'https://world.openfoodfacts.org', target: '_blank', rel: 'noopener noreferrer' }, 'Open Food Facts'), ' · ', h('a', { href: 'https://opendatacommons.org/licenses/odbl/1-0/', target: '_blank', rel: 'noopener noreferrer' }, 'ODbL'))));
  renderResults();
  const visibility = () => { if (document.hidden) stopPending(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stopPending);
  return { element: root, dispose: () => {
    disposed = true; stopPending();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', stopPending);
  } };
}
