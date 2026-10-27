import { quantitySpec, toStoredAmount, formatFoodAmount, quantizeFoodAmount } from './food-measures.js?v=20261027-oil';
import { createMealFoodPicker } from './meal-food-picker.js?v=20261027-oil';
import { mealFromIngredients } from './planner.js?v=20261027-oil';

const SLOTS = [
  ['preworkout', 'Prima dell’allenamento'], ['breakfast', 'Colazione'],
  ['lunch', 'Pranzo'], ['dinner', 'Cena'],
];
const copy = value => JSON.parse(JSON.stringify(value));
const fmt = value => value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const macroText = values => `${fmt(values.kcal)} kcal · P ${fmt(values.protein)} g · C ${fmt(values.carbs)} g · G ${fmt(values.fat)} g`;

/**
 * Local recipe library. Persistence and fitting to a diary meal belong to onSave/onUse.
 * getFoodForIngredient resolves the current label (including personal snapshots).
 * Editing is isolated in a draft; dispose closes the picker and any camera/network work.
 */
export function renderRecipeLibrary({ h, field, button, getRecipes, getFoods, getFoodForIngredient, onSave, onUse, onError }) {
  let disposed = false, picker = null, shown = 12;
  const root = h('section', { class: 'panel recipes-panel', 'aria-label': 'Le mie ricette base' });
  const editor = h('div', { class: 'recipe-editor' });
  const list = h('div', { class: 'recipe-list' });
  const status = h('p', { class: 'helper', role: 'status', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', placeholder: 'Cerca una ricetta o un ingrediente', 'aria-label': 'Cerca nelle ricette base', oninput: () => { shown = 12; renderList(); } });
  const category = h('select', { 'aria-label': 'Filtra ricette per pasto', onchange: () => { shown = 12; renderList(); } },
    h('option', { value: '' }, 'Tutti i pasti'), ...SLOTS.map(([id, label]) => h('option', { value: id }, label)));
  const report = error => { status.textContent = error.message || String(error); onError?.(status.textContent); };

  function asMeal(recipe) {
    // Only macro overrides are needed; snapshots remain attached to their ingredients.
    const overrides = {};
    for (const item of recipe.ingredients) {
      const food = getFoodForIngredient(item);
      if (!item.foodSnapshot) overrides[item.foodId] = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, food[key]]));
    }
    return mealFromIngredients({ id: recipe.id, slot: recipe.slot, title: recipe.name, time: '', note: '', ingredients: recipe.ingredients }, overrides);
  }
  function closeEditor() {
    picker?.dispose(); picker = null; editor.replaceChildren();
  }
  function ingredientLine(item) {
    const food = getFoodForIngredient(item);
    return `${food.name} · ${formatFoodAmount(item.foodId, food, item.grams)}`;
  }
  function renderList() {
    if (disposed) return;
    const words = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
    let recipes;
    try {
      recipes = getRecipes().filter(recipe => {
        if (category.value && recipe.slot !== category.value) return false;
        const terms = normalize(`${recipe.name} ${recipe.ingredients.map(item => {
          try { return getFoodForIngredient(item).name; } catch { return ''; }
        }).join(' ')}`);
        return words.every(word => terms.includes(word));
      });
    } catch (error) { report(error); return; }
    status.textContent = `${recipes.length} ${recipes.length === 1 ? 'ricetta' : 'ricette'}${recipes.length > shown ? ` · Mostrate ${shown}` : ''}`;
    list.replaceChildren(...[h('div', { class: 'food-catalog recipe-catalog' }, ...recipes.slice(0, shown).map(recipe => {
      let summary;
      try {
        summary = [h('p', { class: 'food-calories' }, macroText(asMeal(recipe).macros)),
          h('details', {}, h('summary', {}, `Ingredienti della base · ${recipe.ingredients.length}`), h('ul', {}, ...recipe.ingredients.map(item => h('li', {}, ingredientLine(item)))))];
      } catch { summary = [h('p', { class: 'form-error' }, 'Controlla gli ingredienti di questa ricetta.')]; }
      return h('article', { class: 'food-card recipe-card' }, h('h3', {}, recipe.name),
        h('p', { class: 'helper' }, SLOTS.find(([id]) => id === recipe.slot)?.[1] || recipe.slot), ...summary,
        h('div', { class: 'form-actions' }, button('Usa nel giorno', () => { try { onUse(copy(recipe)); } catch (error) { report(error); } }, 'button primary small', { 'aria-label': `Usa nel giorno: ${recipe.name}` }),
          button('Modifica ricetta', () => openEditor(recipe), 'text-button', { 'aria-label': `Modifica ricetta: ${recipe.name}` })));
    })), !recipes.length && h('p', { class: 'helper' }, 'Nessuna ricetta trovata. Puoi crearne una nuova.'),
    recipes.length > shown && button('Mostra altre ricette', () => { shown += 12; renderList(); }, 'button secondary')].filter(Boolean));
  }
  function openEditor(original = null) {
    if (disposed) return;
    closeEditor();
    const draft = original ? copy(original) : { id: `recipe-user-${crypto.randomUUID()}`, name: '', slot: 'lunch', ingredients: [] };
    for (const item of draft.ingredients) {
      try { item.grams = quantizeFoodAmount(item.foodId, getFoodForIngredient(item), item.grams); } catch { /* Invalid labels remain editable below. */ }
    }
    const name = h('input', { type: 'text', required: true, maxlength: 200, value: draft.name, 'aria-label': 'Nome della ricetta' });
    const slot = h('select', { 'aria-label': 'Pasto abituale della ricetta' }, ...SLOTS.map(([id, label]) => h('option', { value: id, selected: id === draft.slot }, label)));
    const rows = h('div', { class: 'edit-ingredients recipe-ingredients' });
    const totals = h('p', { class: 'portion-totals', role: 'status' });
    const errors = h('p', { class: 'form-error', role: 'alert' });
    function refreshTotals() {
      try {
        for (const item of draft.ingredients) {
          const spec = quantitySpec(item.foodId, getFoodForIngredient(item));
          const display = item.grams / spec.factor;
          if (spec.factor !== 1 && (display < spec.min || display > spec.max || Math.abs(display / spec.step - Math.round(display / spec.step)) > 1e-7)) throw new Error('Per l’olio usa multipli di 0,25 cucchiai.');
        }
        totals.textContent = `Quantità base: ${macroText(asMeal(draft).macros)}`; errors.textContent = '';
      }
      catch (error) { totals.textContent = ''; errors.textContent = error.message; }
    }
    function renderIngredients() {
      rows.replaceChildren(...draft.ingredients.map((item, index) => {
        let food;
        try { food = getFoodForIngredient(item); } catch { food = { name: item.foodId, unit: 'g' }; }
        const spec = quantitySpec(item.foodId, food);
        const input = h('input', { type: 'number', min: spec.min, max: spec.max, step: spec.step, required: true, inputmode: 'decimal', value: item.grams / spec.factor, 'aria-label': `Quantità base di ${food.name}`, oninput: event => {
          const value = event.target.valueAsNumber;
          item.grams = Number.isFinite(value) && value >= 0 ? toStoredAmount(item.foodId, food, value) : NaN; refreshTotals();
        } });
        return h('div', { class: 'edit-ingredient' }, h('div', {}, h('strong', {}, food.name), food.unitNote && h('small', {}, food.unitNote)),
          h('div', { class: 'gram-control' }, input, h('span', {}, spec.unit)),
          button('Rimuovi', () => { draft.ingredients.splice(index, 1); renderIngredients(); }, 'text-button', { 'aria-label': `Rimuovi dalla ricetta: ${food.name}` }));
      }));
      if (!draft.ingredients.length) rows.append(h('p', { class: 'helper' }, 'Aggiungi il primo ingrediente dal catalogo o tramite codice a barre.'));
      refreshTotals();
    }
    picker = createMealFoodPicker({ h, field, button, getFoods, allowRemember: false, context: 'recipe',
      getUsualQuantity: (_id, _food, fallback) => fallback ?? 100,
      add: item => {
        if (disposed) return;
        if (draft.ingredients.length >= 30) throw new Error('Puoi inserire al massimo 30 ingredienti nella ricetta.');
        draft.ingredients.push(copy(item)); renderIngredients();
      },
    });
    const save = () => {
      if (disposed) return;
      try {
        if (!name.value.trim() || name.value.trim().length > 200) throw new Error('Inserisci il nome della ricetta (massimo 200 caratteri).');
        if (!SLOTS.some(([id]) => id === slot.value)) throw new Error('Scegli il pasto abituale della ricetta.');
        if (!draft.ingredients.length || draft.ingredients.length > 30) throw new Error('La ricetta deve contenere da 1 a 30 ingredienti.');
        if (draft.ingredients.some(item => !Number.isFinite(item.grams) || item.grams < .1 || item.grams > 3000)) throw new Error('Inserisci quantità base comprese tra 0,1 e 3.000 g o ml.');
        for (const item of draft.ingredients) {
          const spec = quantitySpec(item.foodId, getFoodForIngredient(item));
          const display = item.grams / spec.factor;
          if (spec.factor !== 1 && (display < spec.min || display > spec.max || Math.abs(display / spec.step - Math.round(display / spec.step)) > 1e-7)) throw new Error('Per l’olio usa multipli di 0,25 cucchiai.');
        }
        draft.name = name.value.trim(); draft.slot = slot.value;
        const checked = asMeal(draft);
        const recipe = { id: draft.id, name: draft.name, slot: draft.slot, ingredients: checked.ingredients, ...(typeof draft.source === 'string' ? { source: draft.source } : {}) };
        onSave(copy(recipe));
        closeEditor(); renderList(); status.textContent = `Ricetta salvata: ${recipe.name}. I pasti già presenti nel diario restano invariati.`;
      } catch (error) { errors.textContent = error.message; }
    };
    editor.append(h('h3', {}, original ? 'Modifica la ricetta base' : 'Nuova ricetta base'),
      h('div', { class: 'form-grid' }, field('Nome della ricetta', name), field('Pasto abituale', slot)),
      h('p', { class: 'helper' }, 'Salva ingredienti e quantità di partenza. Quando usi la ricetta nel giorno, Pasti adatta le quantità agli obiettivi del pasto.'),
      rows, picker.element, totals, errors,
      h('div', { class: 'form-actions' }, button('Salva ricetta', save, 'button primary'), button('Annulla modifica ricetta', () => { closeEditor(); status.textContent = 'Modifica annullata.'; }, 'text-button')));
    renderIngredients(); name.focus(); editor.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
  root.append(h('div', { class: 'section-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'LE TUE PREPARAZIONI'), h('h2', {}, 'Le mie ricette base'),
    h('p', {}, 'Modifica ingredienti e quantità abituali. Usa una ricetta nel giorno per calcolare le porzioni sui macro del pasto.')), button('Nuova ricetta', () => openEditor(), 'button primary')),
    editor, h('div', { class: 'form-grid' }, field('Cerca ricette', search), field('Pasto', category)), status, list);
  renderList();
  return { element: root, dispose: () => { disposed = true; picker?.dispose(); picker = null; } };
}
