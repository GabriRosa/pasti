import { getFood, foodMacros } from './foods.js';
import { calculateTargets, sumMacros } from './nutrition.js';

export const MEAL_SLOTS = Object.freeze([
  { id: 'preworkout', label: 'Prima della palestra · facoltativo' },
  { id: 'breakfast', label: 'Colazione' },
  { id: 'lunch', label: 'Pranzo' },
  { id: 'dinner', label: 'Cena' },
].map(Object.freeze));

const CARBS = ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl'];
const PROTEINS = ['chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin'];
const CARB_NAMES = { pasta: 'Pasta', rice: 'Riso', couscous: 'Couscous', potatoes: 'Patate', 'lentil-pasta-lidl': 'Pasta di lenticchie' };
const PROTEIN_NAMES = { chicken: 'pollo', eggs: 'uova', 'egg-whites': 'albumi', salmon: 'salmone', tuna: 'tonno', 'pork-tenderloin': 'filetto di maiale' };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const rotation = (value, length) => ((value % length) + length) % length;
const ingredient = (foodId, grams) => ({ foodId, grams });

function validateMeal(meal) {
  if (!meal || !MEAL_SLOTS.some(slot => slot.id === meal.slot) || !Array.isArray(meal.ingredients)) {
    throw new Error('Il pasto non ha un formato valido.');
  }
}

export function mealFromIngredients(meal, overrides = {}) {
  validateMeal(meal);
  const ingredients = meal.ingredients.map(item => {
    if (!item || typeof item.foodId !== 'string') throw new Error('Un ingrediente non è valido.');
    foodMacros(item.foodId, item.grams, overrides);
    return { foodId: item.foodId, grams: item.grams };
  });
  return { ...meal, ingredients, macros: sumMacros(ingredients.map(item => foodMacros(item.foodId, item.grams, overrides))) };
}

function dayNumber(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('La data deve avere formato AAAA-MM-GG.');
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year < 1900 || year > 2100) throw new Error('Scegli una data tra il 1900 e il 2100.');
  const time = Date.UTC(year, month - 1, day);
  if (new Date(time).toISOString().slice(0, 10) !== dateKey) throw new Error('La data selezionata non esiste.');
  return time / 86400000;
}

function clockMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function clockTime(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function previewMeal(slot, title, ingredients, note, overrides, base = {}) {
  return mealFromIngredients({ id: base.id ?? slot, slot, title, time: base.time ?? '', ingredients, note }, overrides);
}

function breakfastOptions(kcal, base, overrides) {
  // Keep packaged desserts at one example tub; adjust the accompanying cereal.
  const build = (title, fixed, cerealId, low, high, note) => {
    const fixedKcal = sumMacros(fixed.map(item => foodMacros(item.foodId, item.grams, overrides))).kcal;
    const cerealKcal = getFood(cerealId, overrides).kcal;
    if (cerealKcal <= 0) throw new Error('Per preparare le alternative, il cereale deve avere energia maggiore di zero.');
    const grams = clamp((kcal - fixedKcal) * 100 / cerealKcal, low, high);
    return previewMeal('breakfast', title, [...fixed, ingredient(cerealId, grams)], note, overrides, base);
  };
  const timing = 'Colazione dopo l’allenamento nei giorni di palestra. Orario indicativo, da adattare alla fine della seduta. ';
  return [
    build('Budino proteico, avena e banana', [ingredient('protein-pudding-lidl', 200), ingredient('banana', 100), ingredient('dark-chocolate', 10)], 'oats', 20, 100,
      timing + '3 minuti. Un vasetto da 200 g è solo un esempio: modifica grammi e valori con la confezione. Avena secca, da mescolare o mangiare a parte.'),
    build('Mousse proteica, pane e confettura', [ingredient('protein-mousse-lidl', 200), ingredient('jam', 20), ingredient('banana', 100)], 'bread', 30, 150,
      timing + '3 minuti. Un vasetto da 200 g è solo un esempio: verifica peso ed etichetta. Pane e confettura a parte.'),
    build('Yogurt greco con cioccolato fuso', [ingredient('greek-yogurt', 250), ingredient('dark-chocolate', 20), ingredient('banana', 100)], 'oats', 20, 100,
      timing + '5 minuti. Sciogli il cioccolato a intervalli brevi e versalo sullo yogurt; aggiungi avena e banana. Non sono previsti altri condimenti.'),
    build('Toast con uova e yogurt greco', [ingredient('eggs', 100), ingredient('greek-yogurt', 170), ingredient('olive-oil', 3)], 'bread', 40, 150,
      timing + '12–15 minuti. Circa 2 uova medie senza guscio, ben cotte con l’olio indicato; yogurt a parte.'),
    build('Yogurt, avena e banana', [ingredient('greek-yogurt', 300), ingredient('banana', 120), ingredient('dark-chocolate', 15)], 'oats', 20, 100,
      timing + '3 minuti, oppure prepara la sera e conserva in frigorifero. Avena pesata a secco.'),
  ];
}

function snackOptions(base, overrides) {
  const note = 'Facoltativo, 15–30 minuti prima della palestra. Porzione piccola: adatta alla tua tolleranza o saltala.';
  return [
    previewMeal('preworkout', 'Una piccola banana', [ingredient('banana', 100)], '1 minuto. ' + note, overrides, base),
    previewMeal('preworkout', 'Gallette con confettura', [ingredient('rice-cakes', 16), ingredient('jam', 10)], '2 minuti. Circa 2 gallette, verifica il peso. ' + note, overrides, base),
    previewMeal('preworkout', 'Pane e confettura', [ingredient('bread', 30), ingredient('jam', 10)], '2 minuti. ' + note, overrides, base),
  ];
}

function bounds(carbId, proteinId) {
  return {
    carb: carbId === 'potatoes' ? [80, 650] : [20, 150],
    protein: proteinId === 'salmon' ? [60, 250] : proteinId === 'egg-whites' ? [80, 300] : [50, 300],
  };
}

// Solve the two nutrient equations, then inspect feasible boundary solutions.
// This keeps the protein from pasta/legumes and carbohydrate from other foods.
function balancedPair(carb, protein, wanted, range) {
  const c = { c: carb.carbs / 100, p: carb.protein / 100 };
  const p = { c: protein.carbs / 100, p: protein.protein / 100 };
  if (c.c <= 0 || p.p <= 0) throw new Error('La sostituzione richiede carboidrati nel primo alimento e proteine nel secondo. Controlla le etichette.');
  const wc = 1 / Math.max(20, wanted.carbs) ** 2;
  const wp = 1.5 / Math.max(15, wanted.protein) ** 2;
  const candidates = [];
  const add = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) candidates.push([clamp(x, ...range.carb), clamp(y, ...range.protein)]);
  };
  const determinant = c.c * p.p - p.c * c.p;
  if (Math.abs(determinant) > 1e-10) {
    add((wanted.carbs * p.p - p.c * wanted.protein) / determinant,
      (c.c * wanted.protein - wanted.carbs * c.p) / determinant);
  }
  for (const x of range.carb) {
    const y = (wc * p.c * (wanted.carbs - c.c * x) + wp * p.p * (wanted.protein - c.p * x)) / (wc * p.c ** 2 + wp * p.p ** 2);
    add(x, y);
  }
  for (const y of range.protein) {
    const x = (wc * c.c * (wanted.carbs - p.c * y) + wp * c.p * (wanted.protein - p.p * y)) / (wc * c.c ** 2 + wp * c.p ** 2);
    add(x, y);
  }
  const score = ([x, y]) => wc * (c.c * x + p.c * y - wanted.carbs) ** 2 + wp * (c.p * x + p.p * y - wanted.protein) ** 2;
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0];
}

function mainMeal(base, wanted, carbId, proteinId, overrides, fixed = [ingredient('vegetables', 200)]) {
  const allFixed = fixed.map(item => ({ ...item }));
  let adjustableProtein = proteinId;
  if (proteinId === 'eggs') {
    // Two eggs keep this option usable; albumen supplies any additional protein.
    allFixed.push(ingredient('eggs', 100));
    adjustableProtein = 'egg-whites';
  }
  const fixedMacros = sumMacros(allFixed.map(item => foodMacros(item.foodId, item.grams, overrides)));
  const range = bounds(carbId, adjustableProtein);
  // A companion is optional when the two eggs and the cereal already suffice.
  if (proteinId === 'eggs') range.protein = [0, 300];
  const pair = balancedPair(getFood(carbId, overrides), getFood(adjustableProtein, overrides), {
    carbs: Math.max(0, wanted.carbs - fixedMacros.carbs),
    protein: Math.max(0, wanted.protein - fixedMacros.protein),
  }, range);
  const ingredients = [ingredient(carbId, pair[0]), ...allFixed];
  if (pair[1] > 0.01) ingredients.splice(proteinId === 'eggs' ? ingredients.length : 1, 0, ingredient(adjustableProtein, pair[1]));
  const beforeOil = sumMacros(ingredients.map(item => foodMacros(item.foodId, item.grams, overrides)));
  const oil = getFood('olive-oil', overrides);
  if (oil.fat > 0) {
    const grams = clamp((wanted.fat - beforeOil.fat) * 100 / oil.fat, 0, 30);
    if (grams > 0.01) ingredients.push(ingredient('olive-oil', grams));
  }
  // A legume pasta plus eggs can supply protein before supplying enough energy.
  // Complete the plate with a normal bread side rather than oversized portions.
  let extraBread = 0;
  const afterOil = sumMacros(ingredients.map(item => foodMacros(item.foodId, item.grams, overrides)));
  const bread = getFood('bread', overrides);
  if (wanted.kcal > 0 && wanted.kcal - afterOil.kcal > wanted.kcal * 0.04 && bread.kcal > 0) {
    const existingBread = ingredients.find(item => item.foodId === 'bread');
    extraBread = clamp((wanted.kcal - afterOil.kcal) * 100 / bread.kcal, 20, Math.max(0, 150 - (existingBread?.grams ?? 0)));
    if (extraBread > 0.01) {
      if (existingBread) existingBread.grams += extraBread;
      else ingredients.push(ingredient('bread', extraBread));
    }
  } else if (wanted.kcal > 0 && afterOil.kcal - wanted.kcal > wanted.kcal * 0.04 && oil.kcal > 0) {
    const oilItem = ingredients.find(item => item.foodId === 'olive-oil');
    if (oilItem) {
      oilItem.grams = Math.max(0, oilItem.grams - (afterOil.kcal - wanted.kcal) * 100 / oil.kcal);
      if (oilItem.grams <= 0.01) ingredients.splice(ingredients.indexOf(oilItem), 1);
    }
  }
  const cookMinutes = Math.max({ pasta: 20, rice: 25, couscous: 10, potatoes: 35, 'lentil-pasta-lidl': 20 }[carbId],
    { chicken: 20, eggs: 15, 'egg-whites': 10, salmon: 20, tuna: 5, 'pork-tenderloin': 25 }[proteinId]);
  const macros = sumMacros(ingredients.map(item => foodMacros(item.foodId, item.grams, overrides)));
  const deviations = ['protein', 'carbs', 'fat'].some(key => Math.abs(macros[key] - wanted[key]) > Math.max(4, wanted[key] * 0.12));
  let note = `${cookMinutes}–${cookMinutes + 5} minuti indicativi, preparazioni in parallelo. Pesi a crudo/secco; tonno sgocciolato. Verdure e tutto l’olio usato sono inclusi.`;
  const hasEggWhites = proteinId === 'eggs' && ingredients.some(item => item.foodId === 'egg-whites');
  if (proteinId === 'eggs') note += hasEggWhites
    ? ' 100 g di uova ≈ 2 uova medie senza guscio; completa con gli albumi indicati, ben cotti.'
    : ' 100 g di uova ≈ 2 uova medie senza guscio, ben cotte.';
  if (carbId === 'lentil-pasta-lidl') note += ' Le proteine delle lenticchie sono già conteggiate: la porzione del secondo è adattata. Valori Lidl da verificare sulla confezione.';
  if (extraBread > 0.01) note += ' Il pane a parte completa l’energia del pasto: i suoi carboidrati e le sue proteine sono conteggiati.';
  if (!ingredients.some(item => item.foodId === 'olive-oil')) note += ' I grassi sono già presenti negli alimenti: non è previsto olio aggiuntivo.';
  if (deviations) note += ' Le porzioni pratiche possono discostarsi dagli obiettivi: confronta i totali effettivi.';
  const proteinName = hasEggWhites ? 'uova e albumi' : PROTEIN_NAMES[proteinId];
  return previewMeal(base.slot, `${CARB_NAMES[carbId]} con ${proteinName} e verdure`, ingredients, note, overrides, base);
}

export function createDayPlan(profile, targets, dateKey, overrides = {}) {
  calculateTargets(profile); // Validate the full profile even when targets are supplied.
  sumMacros([targets]);
  if (targets.kcal <= 0) throw new Error('L’obiettivo calorico deve essere maggiore di zero.');
  const number = dayNumber(dateKey);
  const weekday = new Date(number * 86400000).getUTCDay();
  const training = (profile.trainingDays ?? []).includes(weekday);
  const trainingMinutes = clockMinutes(profile.trainingTime ?? '06:00');
  const meals = [];
  const base = slot => ({ id: `${dateKey}-${slot}`, slot, time: slot === 'lunch' ? '13:00' : slot === 'dinner' ? '20:00' : '08:00' });
  if (training && profile.includePreworkout !== false) {
    const snackBase = { ...base('preworkout'), time: clockTime(trainingMinutes - 15) };
    const snack = snackOptions(snackBase, overrides)[rotation(number, 3)];
    if (trainingMinutes < 15) snack.note += ' L’orario dello spuntino cade la sera precedente.';
    meals.push(snack);
  }
  const breakfastBase = { ...base('breakfast'), time: training && trainingMinutes < 9 * 60 ? clockTime(trainingMinutes + 90) : '08:00' };
  let breakfast = breakfastOptions(targets.kcal * 0.27, breakfastBase, overrides)[rotation(number, 5)];
  if (training && trainingMinutes >= 9 * 60) breakfast = { ...breakfast, note: breakfast.note.replace('Colazione dopo l’allenamento nei giorni di palestra.', 'Con l’orario scelto, questa colazione precede la palestra; sposta il pasto secondo la tua routine.') };
  meals.push(breakfast);
  const consumed = sumMacros(meals.map(meal => meal.macros));
  const remaining = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, Math.max(0, targets[key] - consumed[key]) / 2]));
  meals.push(mainMeal(base('lunch'), remaining, CARBS[rotation(number, 5)], PROTEINS[rotation(number, 6)], overrides));
  meals.push(mainMeal(base('dinner'), remaining, CARBS[rotation(number + 2, 5)], PROTEINS[rotation(number + 3, 6)], overrides));
  return meals;
}

export function mealAlternatives(meal, targets, overrides = {}) {
  const current = mealFromIngredients(meal, overrides);
  if (targets !== undefined) sumMacros([targets]);
  if (meal.slot === 'preworkout') return snackOptions(current, overrides);
  if (meal.slot === 'breakfast') return breakfastOptions(current.macros.kcal || targets?.kcal * 0.27 || 450, current, overrides);
  const fixed = current.ingredients.filter(item => !CARBS.includes(item.foodId) && !PROTEINS.includes(item.foodId) && item.foodId !== 'olive-oil');
  return CARBS.flatMap(carbId => PROTEINS.map(proteinId => mainMeal(current, current.macros, carbId, proteinId, overrides, fixed)));
}

export function swapMealFood(meal, oldFoodId, newFoodId, overrides = {}) {
  const current = mealFromIngredients(meal, overrides);
  const old = current.ingredients.find(item => item.foodId === oldFoodId);
  if (!old) throw new Error('L’alimento da sostituire non è presente nel pasto.');
  const oldFood = getFood(oldFoodId, overrides);
  const newFood = getFood(newFoodId, overrides);
  if (oldFoodId === newFoodId) return current;
  const main = ['lunch', 'dinner'].includes(meal.slot);
  const carbId = current.ingredients.find(item => CARBS.includes(item.foodId))?.foodId;
  const proteinId = current.ingredients.some(item => item.foodId === 'eggs') ? 'eggs' : current.ingredients.find(item => PROTEINS.includes(item.foodId))?.foodId;
  if (main && carbId && proteinId && ((CARBS.includes(oldFoodId) && CARBS.includes(newFoodId)) || (PROTEINS.includes(oldFoodId) && PROTEINS.includes(newFoodId)))) {
    const fixed = current.ingredients.filter(item => !CARBS.includes(item.foodId) && !PROTEINS.includes(item.foodId) && item.foodId !== 'olive-oil');
    return mainMeal(current, current.macros, CARBS.includes(oldFoodId) ? newFoodId : carbId,
      PROTEINS.includes(oldFoodId) ? newFoodId : proteinId, overrides, fixed);
  }
  if (oldFood.group !== newFood.group) throw new Error('Scegli un’alternativa dello stesso gruppo alimentare.');
  const key = oldFood.group === 'protein' ? 'protein' : oldFood.group === 'carb' || oldFood.group === 'fruit' ? 'carbs' : oldFood.group === 'fat' ? 'fat' : 'kcal';
  if (oldFood[key] <= 0) throw new Error('L’alimento da sostituire non contiene il nutriente scelto: modifica direttamente la porzione.');
  if (newFood[key] <= 0) throw new Error('Il nuovo alimento non contiene il nutriente necessario alla sostituzione.');
  const grams = old.grams * oldFood[key] / newFood[key];
  return mealFromIngredients({ ...current, title: current.title.replace(oldFood.name, newFood.name),
    ingredients: current.ingredients.map(item => item.foodId === oldFoodId ? ingredient(newFoodId, grams) : item),
    note: `${current.note} Sostituzione per ${key === 'kcal' ? 'energia' : 'nutriente principale'}: verifica tutti i totali ricalcolati.` }, overrides);
}
