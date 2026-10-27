import { normalizeBarcode, lookupProduct, createBarcodeScanner, validatePersonalFood } from './barcode.js?v=20261027-neutral';

export function renderPortions({ h, field, button, getPortions, save, remove, addToMeal, reportError }) {
  let disposed = false, request, searchVersion = 0;
  const section = h('section', { class: 'panel portions-panel', 'aria-label': 'Codice a barre e porzioni personali' });
  const status = h('p', { role: 'status', 'aria-live': 'polite', class: 'helper' });
  const editor = h('div');
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
    const name = h('input', { type: 'text', required: true, maxlength: 200, value: food.name });
    const brand = h('input', { type: 'text', maxlength: 200, value: food.brand });
    const unit = h('select', {}, h('option', { value: 'g', selected: food.unit === 'g' }, 'Per 100 g'), h('option', { value: 'ml', selected: food.unit === 'ml' }, 'Per 100 ml'));
    const amount = h('input', { type: 'number', required: true, min: 0.1, max: 3000, step: '0.1', inputmode: 'decimal', value: portion?.grams ?? 100 });
    const quantityLabel = h('span', {}, `Quantità della porzione · ${food.unit}`);
    const inputs = {};
    const totals = h('p', { class: 'portion-totals', role: 'status', 'aria-live': 'polite' });
    const errorBox = h('p', { class: 'form-error', role: 'alert' });
    const metrics = [['kcal', 'Energia · kcal', 1000], ['protein', 'Proteine · g', 100], ['carbs', 'Carboidrati · g', 100], ['fat', 'Grassi · g', 100]];
    const read = () => ({ name: name.value.trim(), brand: brand.value.trim(), barcode: food.barcode, unit: unit.value,
      ...Object.fromEntries(metrics.map(([key]) => [key, inputs[key].value === '' ? null : inputs[key].valueAsNumber])) });
    const update = () => {
      quantityLabel.textContent = `Quantità della porzione · ${unit.value}`;
      const values = read();
      const valid = metrics.every(([key, , max]) => Number.isFinite(values[key]) && values[key] >= 0 && values[key] <= max) && amount.checkValidity() && amount.value !== '';
      const fmt = n => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
      totals.textContent = valid ? `La tua porzione: ${fmt(values.kcal * amount.valueAsNumber / 100)} kcal · P ${fmt(values.protein * amount.valueAsNumber / 100)} g · C ${fmt(values.carbs * amount.valueAsNumber / 100)} g · G ${fmt(values.fat * amount.valueAsNumber / 100)} g` : 'Completa i valori mancanti e la quantità per calcolare la porzione.';
    };
    const editForm = h('form', { class: 'portion-editor', oninput: update, onchange: update, onsubmit: event => {
      event.preventDefault(); if (!editForm.reportValidity()) return;
      try {
        const values = validatePersonalFood(read());
        const saved = { id: portion?.id ?? `personal-${crypto.randomUUID()}`, food: values, grams: amount.valueAsNumber };
        save(saved); editor.replaceChildren(); renderList(); status.textContent = 'Porzione salvata. Ora puoi aggiungerla a un pasto.';
      } catch (error) { errorBox.textContent = error.message; }
    } }, h('h3', {}, portion ? 'Modifica la porzione personale' : 'La tua porzione'),
    food.barcode && h('p', { class: 'helper' }, `Codice ${food.barcode} · `, h('a', { href: `https://world.openfoodfacts.org/product/${food.barcode}`, target: '_blank', rel: 'noopener noreferrer' }, 'Scheda Open Food Facts ↗')),
    h('div', { class: 'form-grid' }, field('Nome del prodotto', name), field('Marca · facoltativa', brand)),
    field('Base dei valori in etichetta', unit, 'Usa i valori del prodotto come venduto. Grammi e millilitri non sono intercambiabili.'),
    h('div', { class: 'form-grid label-grid' }, ...metrics.map(([key, label, max]) => {
      inputs[key] = h('input', { type: 'number', required: true, min: 0, max, step: 'any', inputmode: 'decimal', value: food[key] ?? '', placeholder: 'Da completare' });
      return field(label, inputs[key]);
    })), field(quantityLabel, amount), totals,
    h('p', { class: 'helper' }, 'Verifica i dati con la confezione. Un valore mancante va completato, non è uno zero. Le modifiche restano personali.'), errorBox,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Salva porzione personale'), button('Annulla', () => editor.replaceChildren())));
    editor.replaceChildren(editForm); update();
  }
  function renderList() {
    const portions = getPortions();
    list.replaceChildren(h('h3', {}, `Le tue porzioni${portions.length ? ` · ${portions.length}` : ''}`),
      portions.length ? h('div', { class: 'food-catalog' }, ...portions.map(portion => {
        const f = portion.food, ratio = portion.grams / 100, fmt = n => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
        return h('article', { class: 'food-card' }, h('h4', {}, f.name), h('p', { class: 'helper' }, f.brand),
          h('p', { class: 'food-calories' }, `${fmt(portion.grams)} ${f.unit} · ${fmt(f.kcal * ratio)} kcal`),
          h('p', {}, `P ${fmt(f.protein * ratio)} g · C ${fmt(f.carbs * ratio)} g · G ${fmt(f.fat * ratio)} g`),
          h('div', { class: 'form-actions' }, button('Aggiungi a un pasto', () => addToMeal(portion), 'button primary small'),
          button('Modifica', () => { scanner.stop(); camera.hidden = true; request?.abort(); searchVersion++; searchButton.disabled = false; openEditor(f, portion); editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 'text-button'),
          button('Elimina', async () => { try { if (await remove(portion)) { editor.replaceChildren(); renderList(); } } catch (e) { reportError(e.message); } }, 'text-button')));
      })) : h('p', { class: 'helper' }, 'Le porzioni che salvi compariranno qui, pronte da usare nel diario.'));
  }
  const stopCamera = () => { scanner.stop(); camera.hidden = true; };
  const visibility = () => { if (document.hidden) stopCamera(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stopCamera);
  section.append(h('p', { class: 'eyebrow' }, 'DALLA CONFEZIONE AL DIARIO'), h('h2', {}, 'Scansiona e salva la tua porzione'),
    h('p', {}, 'Inquadra il codice a barre, controlla i valori e scegli quanti grammi mangiare.'),
    h('div', { class: 'form-actions' }, button('Inquadra codice a barre', () => { request?.abort(); searchVersion++; searchButton.disabled = false; editor.replaceChildren(); camera.hidden = false; status.textContent = 'Avvio fotocamera…'; void scanner.start(); }, 'button primary'),
      button('Inserisci prodotto a mano', () => { request?.abort(); searchVersion++; searchButton.disabled = false; stopCamera(); status.textContent = ''; openEditor({ name: '', brand: '', barcode: '', unit: 'g', kcal: null, protein: null, carbs: null, fat: null }); }, 'text-button')),
    h('p', { class: 'helper' }, 'La fotocamera legge il codice sul dispositivo. Solo il codice viene inviato a Open Food Facts, senza foto né dati del diario.'), camera, form, status, editor, list,
    h('p', { class: 'helper' }, 'Dati prodotti: ', h('a', { href: 'https://world.openfoodfacts.org', target: '_blank', rel: 'noopener noreferrer' }, 'Open Food Facts'), ' · ', h('a', { href: 'https://opendatacommons.org/licenses/odbl/1-0/', target: '_blank', rel: 'noopener noreferrer' }, 'ODbL'), '. Le schede possono essere incomplete o non aggiornate.'));
  renderList();
  return { element: section, dispose: () => { disposed = true; searchVersion++; request?.abort(); stopCamera(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', stopCamera); } };
}
