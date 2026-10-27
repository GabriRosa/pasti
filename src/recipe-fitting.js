import { getIngredientFood, ingredientMacros } from './foods.js?v=20261027-neutral';
import { sumMacros } from './nutrition.js?v=20261027-neutral';

export const MACRO_KEYS = Object.freeze(['protein', 'carbs', 'fat']);
const SLOTS = Object.freeze(['preworkout', 'breakfast', 'lunch', 'dinner']);
export const DEFAULT_MEAL_DISTRIBUTION = Object.freeze({
  preworkout: Object.freeze({ protein: 0, carbs: 10, fat: 0 }),
  breakfast: Object.freeze({ protein: 30, carbs: 25, fat: 25 }),
  lunch: Object.freeze({ protein: 35, carbs: 35, fat: 40 }),
  dinner: Object.freeze({ protein: 35, carbs: 30, fat: 35 }),
});
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundAmount = value => Math.round(value * 10) / 10;

/** Each macro has its own 100% allocation across the four meal slots. */
export function validateMealDistribution(value) {
  if (!isRecord(value) || Object.keys(value).length !== SLOTS.length || SLOTS.some(slot => !Object.hasOwn(value, slot))) {
    throw new Error('Distribuisci i macro nei quattro pasti della giornata.');
  }
  const result = {};
  for (const slot of SLOTS) {
    const row = value[slot];
    if (!isRecord(row) || Object.keys(row).length !== MACRO_KEYS.length || MACRO_KEYS.some(key => !Object.hasOwn(row, key))) {
      throw new Error('Ogni pasto deve avere una percentuale per proteine, carboidrati e grassi.');
    }
    result[slot] = {};
    for (const key of MACRO_KEYS) {
      if (!finite(row[key]) || row[key] < 0 || row[key] > 100) throw new Error('Le percentuali devono essere numeri tra 0 e 100.');
      result[slot][key] = row[key];
    }
  }
  const labels = { protein: 'proteine', carbs: 'carboidrati', fat: 'grassi' };
  for (const key of MACRO_KEYS) {
    if (Math.abs(SLOTS.reduce((sum, slot) => sum + result[slot][key], 0) - 100) > 0.01 + 1e-10) {
      throw new Error(`La somma delle percentuali di ${labels[key]} deve essere 100%.`);
    }
  }
  return result;
}

function validateTargets(value) {
  if (!isRecord(value) || MACRO_KEYS.some(key => !finite(value[key]) || value[key] < 0 || value[key] > 10000)) {
    throw new Error('Gli obiettivi dei macro devono essere numeri finiti tra 0 e 10.000 grammi.');
  }
  if (Object.hasOwn(value, 'kcal') && (!finite(value.kcal) || value.kcal < 0 || value.kcal > 200000)) {
    throw new Error('L’obiettivo calorico non è valido.');
  }
}

export function mealMacroTarget(dayTargets, distribution, slot) {
  validateTargets(dayTargets);
  if (!SLOTS.includes(slot)) throw new Error('Pasto non riconosciuto.');
  const allocation = validateMealDistribution(distribution);
  const target = Object.fromEntries(MACRO_KEYS.map(key => [key, dayTargets[key] * allocation[slot][key] / 100]));
  return { ...target, kcal: target.protein * 4 + target.carbs * 4 + target.fat * 9 };
}

/**
 * Split the residual daily P/C/F budget only among uneaten, unskipped slots.
 * Actual consumed macros are subtracted first, and overshoots stop at zero.
 * If all remaining percentages for a macro are zero, share that macro equally
 * among the remaining slots so its outstanding budget is still visible.
 */
export function remainingMealTargets(day, distribution = DEFAULT_MEAL_DISTRIBUTION) {
  if (!isRecord(day) || !Array.isArray(day.meals) || !isRecord(day.consumed ?? {})
    || !Array.isArray(day.skipped ?? [])) throw new Error('Il diario non ha un formato valido.');
  validateTargets(day.targets);
  const allocation = validateMealDistribution(distribution);
  const consumed = day.consumed ?? {};
  const eaten = sumMacros(Object.values(consumed).map(entry => entry?.meal?.macros));
  const active = [];
  const ids = new Set();
  const slots = new Set();
  for (const meal of day.meals) {
    if (!isRecord(meal) || typeof meal.id !== 'string' || !SLOTS.includes(meal.slot)
      || ids.has(meal.id) || slots.has(meal.slot)) throw new Error('I pasti del diario non sono validi.');
    ids.add(meal.id); slots.add(meal.slot);
    if (!Object.hasOwn(consumed, meal.id) && !(day.skipped ?? []).includes(meal.id)) active.push(meal.slot);
  }
  const result = Object.fromEntries(active.map(slot => [slot, {}]));
  for (const key of MACRO_KEYS) {
    const budget = Math.max(0, day.targets[key] - eaten[key]);
    const totalPercent = active.reduce((sum, slot) => sum + allocation[slot][key], 0);
    for (const slot of active) result[slot][key] = budget * (totalPercent > 0 ? allocation[slot][key] / totalPercent : 1 / active.length);
  }
  for (const target of Object.values(result)) target.kcal = target.protein * 4 + target.carbs * 4 + target.fat * 9;
  return result;
}

/**
 * Fit the existing ingredients to P/C/F, never adding foods or changing labels.
 * Adjustable quantities stay between 25% and 400% of their base, capped at 3000.
 * In balanced mode, small amounts (≤10 g/ml, except ≥70% fat) and foods without P/C/F stay fixed.
 * Proportional mode scales the whole recipe, including spices and water; explicit locks stay fixed.
 * The tiny regularizer selects amounts close to the recipe when solutions tie.
 * Label kcal are reported as-is and may differ from the energy implied by P/C/F.
 */
export function fitRecipeIngredients(ingredients, target, overrides = {}, options = {}) {
  validateTargets(target);
  if (!Array.isArray(ingredients) || ingredients.length < 1 || ingredients.length > 100) {
    throw new Error('La ricetta deve contenere da 1 a 100 ingredienti.');
  }
  if (!isRecord(options) || (options.lockedFoodIds !== undefined && (!Array.isArray(options.lockedFoodIds)
    || options.lockedFoodIds.some(id => typeof id !== 'string')))) throw new Error('Elenco delle quantità bloccate non valido.');
  const mode = options.mode ?? 'balanced';
  if (!['balanced', 'proportional'].includes(mode)) throw new Error('Modalità di adattamento della ricetta non valida.');
  const locked = new Set(options.lockedFoodIds || []);
  const zeroTarget = MACRO_KEYS.every(key => target[key] === 0);
  const normalizedBy = MACRO_KEYS.map(key => Math.max(5, target[key]));
  const rows = ingredients.map(item => {
    if (!isRecord(item) || typeof item.foodId !== 'string' || !finite(item.grams) || item.grams < 0 || item.grams > 3000) {
      throw new Error('Le quantità base devono essere numeri tra 0 e 3.000.');
    }
    const food = getIngredientFood(item, overrides);
    if (MACRO_KEYS.some(key => !finite(food[key]) || food[key] < 0 || food[key] > 100)
      || !finite(food.kcal) || food.kcal < 0 || food.kcal > 1000) throw new Error('I valori per 100 g o ml dell’ingrediente non sono validi.');
    const scale = Math.max(item.grams, 25);
    let fixed = locked.has(item.foodId) || (mode === 'balanced' && (MACRO_KEYS.every(key => food[key] === 0)
      || (item.grams <= 10 && food.fat < 70)));
    let min = fixed ? item.grams : zeroTarget ? 0 : item.grams * .25;
    let max = fixed ? item.grams : zeroTarget ? 0 : Math.min(3000, item.grams * 4);
    if (mode === 'balanced' && !fixed) {
      min = Math.ceil(min * 10 - 1e-9) / 10;
      max = Math.floor(max * 10 + 1e-9) / 10;
    }
    // A sub-decigram base may have no representable adjustable amount; preserve it.
    if (max < min) { fixed = true; min = item.grams; max = item.grams; }
    return {
      item, fixed, scale, minAmount: min, maxAmount: max, min: min / scale, max: max / scale, base: item.grams / scale,
      column: MACRO_KEYS.map((key, i) => food[key] / 100 * scale / normalizedBy[i]),
    };
  });
  const amounts = rows.map(row => clamp(row.base, row.min, row.max));
  const regularizer = 1e-7;
  if (mode === 'proportional') {
    const adjustable = rows.filter(row => !row.fixed && row.item.grams > 0);
    if (adjustable.length) {
      const column = MACRO_KEYS.map((key, k) => adjustable.reduce((sum, row) => sum + row.column[k] * row.base, 0));
      const offset = MACRO_KEYS.map((key, k) => rows.reduce((sum, row) => sum + (row.fixed ? row.column[k] * row.base : 0), 0) - target[key] / normalizedBy[k]);
      const lower = Math.max(...adjustable.map(row => row.min / row.base));
      const upper = Math.min(...adjustable.map(row => row.max / row.base));
      const numerator = regularizer - column.reduce((sum, coefficient, k) => sum + coefficient * offset[k], 0);
      const denominator = column.reduce((sum, coefficient) => sum + coefficient * coefficient, regularizer);
      const factor = clamp(numerator / denominator, lower, upper);
      rows.forEach((row, i) => { if (!row.fixed) amounts[i] = row.base * factor; });
    }
  } else {
    const remainder = MACRO_KEYS.map((key, i) => rows.reduce((sum, row, j) => sum + row.column[i] * amounts[j], 0) - target[key] / normalizedBy[i]);
    // Coordinate descent solves the convex, box-constrained quadratic in O(n) per sweep.
    // Normalization prevents energy-dense foods and larger targets dominating the fit.
    for (let iteration = 0; iteration < 10000; iteration++) {
      let largestChange = 0;
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        if (row.min === row.max) continue;
        const slope = row.column.reduce((sum, coefficient, k) => sum + coefficient * remainder[k], 0)
          + regularizer * (amounts[j] - row.base);
        const curvature = row.column.reduce((sum, coefficient) => sum + coefficient * coefficient, regularizer);
        const next = clamp(amounts[j] - slope / curvature, row.min, row.max);
        const delta = next - amounts[j];
        amounts[j] = next;
        largestChange = Math.max(largestChange, Math.abs(delta));
        for (let k = 0; k < remainder.length; k++) remainder[k] += row.column[k] * delta;
      }
      if (largestChange < 1e-9) break;
    }
  }
  const fitted = rows.map((row, index) => ({
    ...row.item,
    ...(row.item.foodSnapshot ? { foodSnapshot: { ...row.item.foodSnapshot } } : {}),
    grams: row.fixed ? row.item.grams : clamp(roundAmount(amounts[index] * row.scale), row.minAmount, row.maxAmount),
  }));
  const macros = sumMacros(fitted.map(item => ingredientMacros(item, overrides)));
  const targetKcal = target.kcal ?? target.protein * 4 + target.carbs * 4 + target.fat * 9;
  const deviation = { ...Object.fromEntries(MACRO_KEYS.map(key => [key, macros[key] - target[key]])), kcal: macros.kcal - targetKcal };
  const matched = MACRO_KEYS.every(key => Math.abs(deviation[key]) <= Math.max(0.5, target[key] * 0.01));
  return { ingredients: fitted, macros, deviation, matched };
}
