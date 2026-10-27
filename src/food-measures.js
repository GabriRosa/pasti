import { getIngredientFood } from './foods.js?v=20261027-neutral';

const OIL_IDS = new Set(['olive-oil', 'sunflower-oil', 'seed-oil', 'coconut-oil', 'rapeseed-oil']);
const number = (value, digits) => value.toLocaleString('it-IT', { maximumFractionDigits: digits });
const assertAmount = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('La quantità deve essere un numero finito e non negativo.');
};

function isOil(id, food) {
  if (OIL_IDS.has(id)) return true;
  const name = String(food?.name ?? '');
  // Foods preserved in oil keep their ordinary g/ml measure.
  const packed = /sott[’'\s-]*olio|\b(?:in|with|packed)\s+(?:(?:olive|sunflower|vegetable)\s+)?oil\b|\b(?:tonno|tuna)\b/iu.test(name);
  return food?.fat >= 80 && /\b(?:olio|oil)\b/iu.test(name) && !packed;
}

/** Stored quantities remain g/ml; tablespoons are a display/input convention. */
export function quantitySpec(id, food) {
  if (isOil(id, food)) {
    const factor = food?.unit === 'ml' ? 15 : 13.5;
    return { unit: 'cucchiai', step: .25, min: .25, max: Math.floor(3000 / factor * 4) / 4, factor };
  }
  return { unit: food?.unit ?? 'g', step: .1, min: .1, max: 3000, factor: 1 };
}

export function toDisplayAmount(id, food, stored) {
  assertAmount(stored);
  const spec = quantitySpec(id, food);
  return spec.factor === 1 || stored === 0 ? stored : Math.max(.25, Math.round(stored / spec.factor * 4) / 4);
}

export function toStoredAmount(id, food, displayed) {
  assertAmount(displayed);
  return displayed * quantitySpec(id, food).factor;
}

export function quantizeFoodAmount(id, food, stored) {
  const spec = quantitySpec(id, food);
  const displayed = toDisplayAmount(id, food, stored);
  return toStoredAmount(id, food, spec.factor === 1 ? displayed : Math.min(displayed, spec.max));
}

export function formatFoodAmount(id, food, stored) {
  const displayed = toDisplayAmount(id, food, stored);
  const spec = quantitySpec(id, food);
  if (spec.factor === 1) return `${number(displayed, 1)} ${spec.unit}`;
  const approximate = Math.abs(displayed * spec.factor - stored) > 1e-7;
  return `${approximate ? 'circa ' : ''}${number(displayed, 2)} ${displayed === 1 ? 'cucchiaio' : 'cucchiai'}`;
}

/** Normalize newly saved recipes, never persisted diary history implicitly. */
export function normalizeOilIngredients(ingredients, overrides = {}) {
  if (!Array.isArray(ingredients)) throw new Error('Gli ingredienti devono essere un elenco.');
  return ingredients.map(item => ({
    ...item,
    ...(item.foodSnapshot ? { foodSnapshot: { ...item.foodSnapshot } } : {}),
    grams: quantizeFoodAmount(item.foodId, getIngredientFood(item, overrides), item.grams),
  }));
}
