import { validatePersonalFood } from './barcode.js?v=20261027-neutral';

// The picker only edits the meal draft. Persistence belongs to Save meal.
export function createMealFoodPicker({ h, field, button, getFoods, add }) {
  const root = h('section', { class: 'meal-food-picker', 'aria-label': 'Aggiungi ingredienti' });
  const results = h('div', { class: 'picker-results' });
  const editor = h('div', { class: 'picker-editor' });
  const status = h('p', { class: 'helper', role: 'status' });
  const fmt = value => value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
  const macros = (food, amount) => `${fmt(food.kcal * amount / 100)} kcal · P ${fmt(food.protein * amount / 100)} g · C ${fmt(food.carbs * amount / 100)} g · G ${fmt(food.fat * amount / 100)} g`;
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const search = h('input', { type: 'search', placeholder: 'Es. pollo, riso, yogurt…', 'aria-label': 'Cerca un alimento', oninput: renderResults });
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
    const amount = h('input', { type: 'number', min: .1, max: 3000, step: .1, required: true, inputmode: 'decimal', value: item.grams || 100, 'aria-label': `Quantità da aggiungere in ${item.food.unit}` });
    const preview = h('p', { class: 'portion-totals', role: 'status' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const update = () => { preview.textContent = amount.value !== '' && amount.checkValidity() ? macros(item.food, amount.valueAsNumber) : 'Inserisci una quantità tra 0,1 e 3.000.'; };
    amount.addEventListener('input', update);
    editor.replaceChildren(h('form', { class: 'picker-amount-form', onsubmit: event => {
      event.preventDefault();
      if (!amount.checkValidity() || amount.value === '') { error.textContent = 'Inserisci una quantità tra 0,1 e 3.000.'; amount.reportValidity(); return; }
      try {
        add({ foodId: item.id, grams: amount.valueAsNumber, ...(item.personal ? { foodSnapshot: { ...item.food } } : {}) });
        editor.replaceChildren(); status.textContent = `${item.food.name} aggiunto al pasto.`;
      } catch (e) { error.textContent = e.message; }
    } }, h('h4', {}, item.food.name), field(`Quantità · ${item.food.unit}`, amount, item.food.unitNote), preview, error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Aggiungi ingrediente'), button('Annulla aggiunta', () => editor.replaceChildren()))));
    update(); amount.focus();
  }
  function manualFood() {
    const name = h('input', { required: true, maxlength: 200, 'aria-label': 'Nome nuovo alimento' });
    const brand = h('input', { maxlength: 200 });
    const unit = h('select', {}, h('option', { value: 'g' }, '100 g'), h('option', { value: 'ml' }, '100 ml'));
    const amount = h('input', { type: 'number', min: .1, max: 3000, step: .1, required: true, inputmode: 'decimal', value: 100 });
    const quantityLabel = h('span', {}, 'Quantità da aggiungere · g');
    const inputs = {};
    const metrics = [['kcal', 'Calorie · kcal', 1000], ['protein', 'Proteine · g', 100], ['carbs', 'Carboidrati · g', 100], ['fat', 'Grassi · g', 100]];
    const error = h('p', { class: 'form-error', role: 'alert' });
    const remember = h('input', { type: 'checkbox', checked: true });
    const preview = h('p', { class: 'portion-totals', role: 'status' });
    const read = () => validatePersonalFood({ name: name.value.trim(), brand: brand.value.trim(), barcode: '', unit: unit.value,
      ...Object.fromEntries(metrics.map(([key]) => [key, inputs[key].value === '' ? null : inputs[key].valueAsNumber])) });
    const update = () => { quantityLabel.textContent = `Quantità da aggiungere · ${unit.value}`; try { const food = read(); preview.textContent = amount.value !== '' && amount.checkValidity() ? macros(food, amount.valueAsNumber) : ''; } catch { preview.textContent = 'Completa i valori dell’etichetta per calcolare la porzione.'; } };
    const form = h('form', { class: 'picker-manual-form', oninput: update, onchange: update, onsubmit: event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      try {
        const food = read();
        const id = `personal-${crypto.randomUUID()}`;
        const ingredient = { foodId: id, grams: amount.valueAsNumber, foodSnapshot: food };
        add(ingredient, remember.checked ? { id, food, grams: ingredient.grams } : null);
        editor.replaceChildren(); status.textContent = `${food.name} aggiunto. Conferma con Salva questo pasto.`;
      } catch (e) { error.textContent = e.message; }
    } }, h('h4', {}, 'Nuovo alimento'),
    h('div', { class: 'form-grid' }, field('Nome', name), field('Marca · facoltativa', brand)),
    field('Valori in etichetta per', unit),
    h('div', { class: 'form-grid' }, ...metrics.map(([key, label, max]) => {
      inputs[key] = h('input', { type: 'number', min: 0, max, step: 'any', required: true, inputmode: 'decimal', 'data-metric': key });
      return field(label, inputs[key]);
    })), field(quantityLabel, amount), preview,
    h('label', { class: 'picker-remember' }, remember, 'Salva anche tra le mie porzioni'), error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Aggiungi nuovo alimento'), button('Annulla aggiunta', () => editor.replaceChildren())));
    editor.replaceChildren(form); update(); name.focus();
  }
  root.append(h('h3', {}, 'Aggiungi ingredienti'), field('Cerca nel catalogo e nelle tue porzioni', search), status, results,
    button('Inserisci un alimento a mano', manualFood, 'text-button'), editor);
  renderResults();
  return root;
}
