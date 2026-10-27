import { quantitySpec, toDisplayAmount, toStoredAmount, formatFoodAmount } from './food-measures.js?v=20261027-oil';
import { normalizeBarcode, lookupProduct, createBarcodeScanner, validatePersonalFood } from './barcode.js?v=20261027-neutral';

export function renderPortions({ h, field, button, getPortions, save, remove, addToMeal, reportError }) {
  let disposed = false, request, searchVersion = 0;
  const section = h('section', { class: 'panel portions-panel', 'aria-label': 'Codice a barre e porzioni personali' });
  const status = h('p', { role: 'status', 'aria-live': 'polite', class: 'helper' });
  const library = h('div', { class: 'library-view' });
  const heading = h('h2', {}, 'Le mie porzioni');
  const create = h('div', { class: 'portion-create', hidden: true });
  const editor = h('div', { class: 'portion-editor-view', hidden: true });
  const list = h('div', { class: 'personal-portions' });
  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'barcode-video' });
  video.muted = true;
  const camera = h('div', { hidden: true }, video,
    h('p', { class: 'helper' }, 'Inquadra tutte le barre, con buona luce e la confezione ferma.'),
    button('Chiudi fotocamera', () => { scanner.stop(); camera.hidden = true; status.textContent = 'Fotocamera chiusa.'; }));
  const scanner = createBarcodeScanner({ video, onCode: code => { camera.hidden = true; codeInput.value = code; void search(code); },
    onError: message => { camera.hidden = true; status.textContent = message; } });
  const codeInput = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 24, placeholder: 'Es. 4056489759096', 'aria-label': 'Codice a barre' });
  const searchButton = h('button', { type: 'submit', class: 'button secondary' }, 'Cerca prodotto');
  const form = h('form', { class: 'barcode-search', onsubmit: event => { event.preventDefault(); void search(codeInput.value); } }, field('Oppure scrivi il codice', codeInput), searchButton);
  function setView(view) {
    library.hidden = view !== 'library'; create.hidden = view !== 'create'; editor.hidden = view !== 'editor';
    section.classList.toggle('library-editing', view !== 'library');
  }
  function cancelWork() {
    scanner.stop(); camera.hidden = true; request?.abort(); searchVersion++; searchButton.disabled = false;
  }
  function closeEditor() {
    cancelWork(); editor.replaceChildren(); setView('library'); status.textContent = ''; library.querySelector('button')?.focus();
  }
  async function search(input) {
    let barcode;
    try { barcode = normalizeBarcode(input); } catch (error) { status.textContent = error.message; return; }
    scanner.stop(); camera.hidden = true; request?.abort();
    const version = ++searchVersion;
    request = new AbortController(); editor.replaceChildren();
    searchButton.disabled = true; status.textContent = 'Cerco il prodotto su Open Food Facts…';
    try {
      const food = await lookupProduct(barcode, { signal: request.signal });
      if (disposed || version !== searchVersion) return;
      status.textContent = 'Prodotto trovato. Controlla nome e valori sulla confezione.';
      openEditor(food);
    } catch (error) {
      if (disposed || version !== searchVersion) return;
      status.textContent = error.message;
      openEditor({ name: '', brand: '', barcode, unit: 'g', kcal: null, protein: null, carbs: null, fat: null });
    } finally { if (!disposed && version === searchVersion) searchButton.disabled = false; }
  }
  function openEditor(food, portion) {
    if (disposed) return;
    scanner.stop(); camera.hidden = true; setView('editor');
    const name = h('input', { type: 'text', required: true, maxlength: 200, value: food.name });
    const brand = h('input', { type: 'text', maxlength: 200, value: food.brand });
    const unit = h('select', {}, h('option', { value: 'g', selected: food.unit === 'g' }, 'Per 100 g'), h('option', { value: 'ml', selected: food.unit === 'ml' }, 'Per 100 ml'));
    const portionId = portion?.id ?? `personal-${crypto.randomUUID()}`;
    let spec = quantitySpec(portionId, food);
    const amount = h('input', { type: 'number', required: true, min: spec.min, max: spec.max, step: spec.step, inputmode: 'decimal', value: toDisplayAmount(portionId, food, portion?.grams ?? 100) });
    const quantityLabel = h('span', {}, `Quantità della porzione · ${food.unit}`);
    const inputs = {};
    const totals = h('p', { class: 'portion-totals', role: 'status', 'aria-live': 'polite' });
    const errorBox = h('p', { class: 'form-error', role: 'alert' });
    const metrics = [['kcal', 'Energia · kcal', 1000], ['protein', 'Proteine · g', 100], ['carbs', 'Carboidrati · g', 100], ['fat', 'Grassi · g', 100]];
    const read = () => ({ name: name.value.trim(), brand: brand.value.trim(), barcode: food.barcode, unit: unit.value,
      ...Object.fromEntries(metrics.map(([key]) => [key, inputs[key].value === '' ? null : inputs[key].valueAsNumber])) });
    const amountValid = () => amount.value !== '' && Number.isFinite(amount.valueAsNumber) && amount.valueAsNumber >= spec.min && amount.valueAsNumber <= spec.max
      && (spec.factor === 1 || Math.abs(amount.valueAsNumber / spec.step - Math.round(amount.valueAsNumber / spec.step)) < 1e-7);
    const update = () => {
      const values = read();
      const nextSpec = quantitySpec(portionId, values);
      if (spec.factor !== nextSpec.factor && Number.isFinite(amount.valueAsNumber) && amount.valueAsNumber >= 0 && (spec.factor === 1 || nextSpec.factor === 1)) {
        amount.value = toDisplayAmount(portionId, values, amount.valueAsNumber * spec.factor);
      }
      spec = nextSpec;
      for (const key of ['min', 'max', 'step']) amount.setAttribute(key, spec[key]);
      amount.setAttribute('aria-label', `Quantità della porzione in ${spec.unit}`);
      quantityLabel.textContent = `Quantità della porzione · ${spec.unit}`;
      const valid = metrics.every(([key, , max]) => Number.isFinite(values[key]) && values[key] >= 0 && values[key] <= max) && amountValid();
      const storedAmount = valid ? toStoredAmount(portionId, values, amount.valueAsNumber) : 0;
      const fmt = n => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
      totals.textContent = valid ? `La tua porzione: ${fmt(values.kcal * storedAmount / 100)} kcal · P ${fmt(values.protein * storedAmount / 100)} g · C ${fmt(values.carbs * storedAmount / 100)} g · G ${fmt(values.fat * storedAmount / 100)} g`
        : spec.factor !== 1 && !amountValid() ? 'Per l’olio usa multipli di 0,25 cucchiai.' : 'Completa i valori mancanti e la quantità per calcolare la porzione.';
    };
    const editForm = h('form', { class: 'portion-editor', oninput: update, onchange: update, onsubmit: event => {
      event.preventDefault(); if (!editForm.reportValidity()) return;
      try {
        const values = validatePersonalFood(read());
        if (!amountValid()) throw new Error(spec.factor === 1 ? 'Inserisci una quantità tra 0,1 e 3.000.' : 'Per l’olio usa multipli di 0,25 cucchiai.');
        const saved = { id: portionId, food: values, grams: toStoredAmount(portionId, values, amount.valueAsNumber) };
        save(saved); closeEditor(); renderList(); status.textContent = 'Porzione salvata. Ora puoi aggiungerla a un pasto.';
      } catch (error) { errorBox.textContent = error.message; }
    } }, button('Torna alle porzioni', closeEditor, 'text-button library-back'),
    h('h3', {}, portion ? 'Modifica la porzione personale' : 'La tua porzione'),
    food.barcode && h('p', { class: 'helper' }, `Codice ${food.barcode} · `, h('a', { href: `https://world.openfoodfacts.org/product/${food.barcode}`, target: '_blank', rel: 'noopener noreferrer' }, 'Scheda Open Food Facts ↗')),
    h('div', { class: 'form-grid' }, field('Nome del prodotto', name), field('Marca · facoltativa', brand)),
    field('Base dei valori in etichetta', unit, 'Usa i valori del prodotto come venduto. Grammi e millilitri non sono intercambiabili.'),
    h('div', { class: 'form-grid label-grid' }, ...metrics.map(([key, label, max]) => {
      inputs[key] = h('input', { type: 'number', required: true, min: 0, max, step: 'any', inputmode: 'decimal', value: food[key] ?? '', placeholder: 'Da completare' });
      return field(label, inputs[key]);
    })), field(quantityLabel, amount), totals,
    h('p', { class: 'helper' }, 'Verifica i dati con la confezione. Un valore mancante va completato, non è uno zero. Le modifiche restano personali.'), errorBox,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Salva porzione personale'), button('Annulla', closeEditor)));
    editor.replaceChildren(editForm); update(); name.focus();
  }
  function renderList() {
    const portions = getPortions();
    heading.textContent = `Le mie porzioni${portions.length ? ` · ${portions.length}` : ''}`;
    list.replaceChildren(portions.length ? h('div', { class: 'food-catalog' }, ...portions.map(portion => {
        const f = portion.food, ratio = portion.grams / 100, fmt = n => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
        return h('article', { class: 'food-card' }, h('h3', {}, f.name), f.brand && h('p', { class: 'helper' }, f.brand),
          h('p', { class: 'food-calories' }, `${formatFoodAmount(portion.id, f, portion.grams)} · ${fmt(f.kcal * ratio)} kcal`),
          h('p', {}, `P ${fmt(f.protein * ratio)} g · C ${fmt(f.carbs * ratio)} g · G ${fmt(f.fat * ratio)} g`),
          h('div', { class: 'form-actions' }, button('Aggiungi a un pasto', () => addToMeal(portion), 'button primary small'),
          button('Modifica', () => { cancelWork(); status.textContent = ''; openEditor(f, portion); editor.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, 'text-button'),
          button('Elimina', async () => { try { if (await remove(portion)) { closeEditor(); renderList(); } } catch (e) { reportError(e.message); } }, 'text-button')));
      })) : h('p', { class: 'helper' }, 'Le porzioni che salvi compariranno qui, pronte da usare nel diario.'));
  }
  const stopCamera = () => { scanner.stop(); camera.hidden = true; };
  const visibility = () => { if (document.hidden) stopCamera(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stopCamera);
  library.append(h('div', { class: 'section-heading' }, h('div', {}, heading,
    h('p', { class: 'helper' }, 'I tuoi prodotti, pronti da aggiungere a un pasto.')),
    button('Nuova porzione', () => { cancelWork(); editor.replaceChildren(); status.textContent = ''; setView('create'); codeInput.focus(); }, 'button primary')), list);
  create.append(button('Torna alle porzioni', closeEditor, 'text-button library-back'), h('h3', {}, 'Nuova porzione'),
    h('p', { class: 'helper' }, 'Cerca il prodotto con il codice a barre o inserisci i valori della confezione.'),
    h('div', { class: 'form-actions' }, button('Inquadra codice a barre', () => { request?.abort(); searchVersion++; searchButton.disabled = false; editor.replaceChildren(); camera.hidden = false; status.textContent = 'Avvio fotocamera…'; void scanner.start(); }, 'button primary'),
      button('Inserisci prodotto a mano', () => { cancelWork(); status.textContent = ''; openEditor({ name: '', brand: '', barcode: '', unit: 'g', kcal: null, protein: null, carbs: null, fat: null }); }, 'text-button')),
    camera, form,
    h('p', { class: 'helper' }, 'La fotocamera legge il codice sul dispositivo. Solo il codice viene inviato a Open Food Facts, senza foto né dati del diario.'),
    h('p', { class: 'helper' }, 'Dati prodotti: ', h('a', { href: 'https://world.openfoodfacts.org', target: '_blank', rel: 'noopener noreferrer' }, 'Open Food Facts'), ' · ', h('a', { href: 'https://opendatacommons.org/licenses/odbl/1-0/', target: '_blank', rel: 'noopener noreferrer' }, 'ODbL'), '. Le schede possono essere incomplete o non aggiornate.'));
  section.append(library, create, status, editor);
  renderList();
  return { element: section, dispose: () => { disposed = true; searchVersion++; request?.abort(); stopCamera(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', stopCamera); } };
}
