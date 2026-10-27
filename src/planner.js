import { getFood, ingredientMacros } from './foods.js?v=20261027-meal-charts';
import { calculateTargets, sumMacros } from './nutrition.js?v=20261027-meal-charts';
import { trainingForDate } from './training.js?v=20261027-meal-charts';

export const MEAL_SLOTS = Object.freeze([
  { id: 'preworkout', label: 'Prima dell’allenamento · facoltativo' },
  { id: 'breakfast', label: 'Colazione' },
  { id: 'lunch', label: 'Pranzo' },
  { id: 'dinner', label: 'Cena' },
].map(Object.freeze));

const CARBS = ['pasta', 'rice', 'couscous', 'potatoes', 'lentil-pasta-lidl', 'lentil-pasta-lidl-fresh'];
const PROTEINS = ['chicken', 'eggs', 'egg-whites', 'salmon', 'tuna', 'pork-tenderloin', 'turkey', 'cod'];
const CARB_NAMES = { pasta: 'Pasta', rice: 'Riso', couscous: 'Couscous', potatoes: 'Patate', 'lentil-pasta-lidl': 'Sedanini di lenticchie secchi', 'lentil-pasta-lidl-fresh': 'Fusilli di lenticchie freschi' };
const PROTEIN_NAMES = { chicken: 'pollo', eggs: 'uova', 'egg-whites': 'albumi', salmon: 'salmone', tuna: 'tonno', 'pork-tenderloin': 'filetto di maiale', turkey: 'tacchino', cod: 'merluzzo' };
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
    ingredientMacros(item, overrides);
    return { foodId: item.foodId, grams: item.grams, ...(item.foodSnapshot ? { foodSnapshot: { ...item.foodSnapshot } } : {}) };
  });
  return { ...meal, ingredients, macros: sumMacros(ingredients.map(item => ingredientMacros(item, overrides))) };
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
  // Keep packaged desserts at one labeled tub; adjust the accompanying cereal.
  const build = (title, fixed, cerealId, low, high, note) => {
    const fixedKcal = sumMacros(fixed.map(item => ingredientMacros(item, overrides))).kcal;
    const cerealKcal = getFood(cerealId, overrides).kcal;
    if (cerealKcal <= 0) throw new Error('Per preparare le alternative, il cereale deve avere energia maggiore di zero.');
    const grams = clamp((kcal - fixedKcal) * 100 / cerealKcal, low, high);
    return previewMeal('breakfast', title, [...fixed, ingredient(cerealId, grams)], note, overrides, base);
  };
  const timing = 'Colazione dopo l’allenamento nei giorni attivi. Orario indicativo, da adattare alla fine della seduta. ';
  const pudding = (id, flavour) => build(`Budino Milbona ${flavour}, avena e banana`,
    [ingredient(id, getFood(id, overrides).label.packGrams), ingredient('banana', 100), ingredient('dark-chocolate', 10)], 'oats', 20, 100,
    timing + `3 minuti. Un vasetto da ${getFood(id, overrides).label.packGrams} g; puoi modificare la quantità. Avena secca, da mescolare o mangiare a parte.`);
  const mousse = (id, flavour) => build(`Mousse Milbona ${flavour}, pane e confettura`,
    [ingredient(id, getFood(id, overrides).label.packGrams), ingredient('jam', 20), ingredient('banana', 100)], 'bread', 30, 150,
    timing + `3 minuti. Un vasetto da ${getFood(id, overrides).label.packGrams} g; puoi modificare la quantità. Pane e confettura a parte.`);
  return [
    pudding('protein-pudding-lidl', 'cacao'),
    pudding('protein-pudding-lidl-vanilla', 'vaniglia'),
    mousse('protein-mousse-lidl', 'cioccolato'),
    mousse('protein-mousse-lidl-vanilla', 'vaniglia'),
    build('Yogurt greco con cioccolato fuso', [ingredient('greek-yogurt', 250), ingredient('dark-chocolate', 20), ingredient('banana', 100)], 'oats', 20, 100,
      timing + '5 minuti. Sciogli il cioccolato a intervalli brevi e versalo sullo yogurt; aggiungi avena e banana. Non sono previsti altri condimenti.'),
    build('Toast con uova e yogurt greco', [ingredient('eggs', 100), ingredient('greek-yogurt', 170), ingredient('olive-oil', 3)], 'bread', 40, 150,
      timing + '12–15 minuti. Circa 2 uova medie senza guscio, ben cotte con l’olio indicato; yogurt a parte.'),
    build('Yogurt, avena e banana', [ingredient('greek-yogurt', 300), ingredient('banana', 120), ingredient('dark-chocolate', 15)], 'oats', 20, 100,
      timing + '3 minuti, oppure prepara la sera e conserva in frigorifero. Avena pesata a secco.'),
  ];
}

function snackOptions(base, overrides) {
  const note = 'Facoltativo, 15–30 minuti prima dell’allenamento. Porzione piccola: adatta alla tua tolleranza o saltala.';
  return [
    previewMeal('preworkout', 'Una piccola banana', [ingredient('banana', 100)], '1 minuto. ' + note, overrides, base),
    previewMeal('preworkout', 'Gallette con confettura', [ingredient('rice-cakes', 16), ingredient('jam', 10)], '2 minuti. Circa 2 gallette, verifica il peso. ' + note, overrides, base),
    previewMeal('preworkout', 'Pane e confettura', [ingredient('bread', 30), ingredient('jam', 10)], '2 minuti. ' + note, overrides, base),
  ];
}

function bounds(carbId, proteinId) {
  return {
    carb: carbId === 'potatoes' ? [80, 650] : carbId === 'lentil-pasta-lidl-fresh' ? [50, 300] : [20, 150],
    protein: proteinId === 'salmon' ? [60, 250] : proteinId === 'egg-whites' ? [80, 300] : [50, 300],
  };
}

const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);

function solveSquare(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < vector.length; col++) {
    let pivot = col;
    for (let row = col + 1; row < rows.length; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    if (Math.abs(rows[pivot][col]) < 1e-12) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    rows[col] = rows[col].map(value => value / divisor);
    for (let row = 0; row < rows.length; row++) {
      if (row === col) continue;
      const multiplier = rows[row][col];
      rows[row] = rows[row].map((value, index) => value - multiplier * rows[col][index]);
    }
  }
  return rows.map(row => row[vector.length]);
}

// Enumerate the bounded vertices that satisfy the nutrient equalities.
// Amounts are normalized before solving so grams and kcal have stable scales.
function constrainedVertices(coefficients, targets, ranges) {
  const count = ranges.length;
  const scales = ranges.map(range => range[1] || 1);
  const rows = coefficients.map((row, index) => row.map((value, column) => value * scales[column] / Math.max(1, Math.abs(targets[index]))));
  const values = targets.map(value => value / Math.max(1, Math.abs(value)));
  const output = [];
  for (let pattern = 0; pattern < 3 ** count; pattern++) {
    let state = pattern;
    const point = Array(count).fill(0);
    const free = [];
    for (let index = 0; index < count; index++) {
      const mode = state % 3;
      state = Math.floor(state / 3);
      if (!mode) free.push(index);
      else point[index] = ranges[index][mode - 1] / scales[index];
    }
    if (free.length > rows.length) continue;
    if (free.length) {
      const remainder = values.map((value, index) => value - dot(rows[index], point));
      const matrix = free.map(a => free.map(b => rows.reduce((total, row) => total + row[a] * row[b], 0)));
      const vector = free.map(a => rows.reduce((total, row, index) => total + row[a] * remainder[index], 0));
      const solved = solveSquare(matrix, vector);
      if (!solved) continue;
      free.forEach((column, index) => { point[column] = solved[index]; });
    }
    if (point.some((value, index) => !Number.isFinite(value) || value < ranges[index][0] / scales[index] - 1e-9 || value > ranges[index][1] / scales[index] + 1e-9)) continue;
    if (rows.some((row, index) => Math.abs(dot(row, point) - values[index]) > 1e-8)) continue;
    output.push(point.map((value, index) => clamp(value * scales[index], ...ranges[index])));
  }
  return output;
}

function balancedAmounts(foods, wanted, range) {
  const coefficients = key => foods.map(food => food[key] / 100);
  const proteinRow = coefficients('protein');
  const carbRow = coefficients('carbs');
  const energyRow = coefficients('kcal');
  const fatRow = coefficients('fat');
  if (foods[0].carbs <= 0 || foods[1].protein <= 0) throw new Error('La sostituzione richiede carboidrati nel primo alimento e proteine nel secondo. Controlla le etichette.');
  const ranges = [range.carb, range.protein, [0, 150], [0, 30]];
  const proteinTarget = clamp(wanted.protein, dot(proteinRow, ranges.map(item => item[0])), dot(proteinRow, ranges.map(item => item[1])));
  const initialRanges = ranges.slice(0, 3);
  const p3 = proteinRow.slice(0, 3);
  const c3 = carbRow.slice(0, 3);
  let initial = constrainedVertices([p3, c3], [proteinTarget, wanted.carbs], initialRanges);
  if (!initial.length) {
    initial = constrainedVertices([p3], [proteinTarget], initialRanges);
    initial.sort((a, b) => Math.abs(dot(c3, a) - wanted.carbs) - Math.abs(dot(c3, b) - wanted.carbs) || a[2] - b[2]);
  } else initial.sort((a, b) => a[2] - b[2]);
  if (!initial.length) throw new Error('Non riesco a comporre il pasto con questi valori: controlla le etichette.');
  let amounts = [...initial[0], 0];
  if (foods[3].fat > 0) amounts[3] = clamp((wanted.fat - dot(fatRow, amounts)) / (foods[3].fat / 100), ...ranges[3]);
  if (wanted.kcal <= 0 || Math.abs(dot(energyRow, amounts) - wanted.kcal) <= wanted.kcal * 0.04) return amounts;

  // Changing oil alone preserves both the protein and carbohydrate equations.
  if (foods[3].protein === 0 && foods[3].carbs === 0 && foods[3].kcal > 0) {
    const requiredOil = amounts[3] + (wanted.kcal - dot(energyRow, amounts)) / (foods[3].kcal / 100);
    if (requiredOil >= 0 && requiredOil <= 30) return [...amounts.slice(0, 3), requiredOil];
  }

  // Bread participates in the protein equality here, before the meat is fixed.
  const energyVertices = constrainedVertices([proteinRow, energyRow], [proteinTarget, wanted.kcal], ranges);
  if (!energyVertices.length) {
    const bounded = constrainedVertices([proteinRow], [proteinTarget], ranges);
    bounded.sort((a, b) => Math.abs(dot(energyRow, a) - wanted.kcal) - Math.abs(dot(energyRow, b) - wanted.kcal));
    return bounded[0] ?? amounts;
  }
  const features = point => [dot(carbRow, point) / Math.max(20, wanted.carbs), dot(fatRow, point) / Math.max(10, wanted.fat), point[2] / 150 * 0.01];
  const target = [wanted.carbs / Math.max(20, wanted.carbs), wanted.fat / Math.max(10, wanted.fat), 0];
  const score = point => features(point).reduce((total, value, index) => total + (value - target[index]) ** 2, 0);
  let best = energyVertices[0];
  for (const candidate of energyVertices) if (score(candidate) < score(best)) best = candidate;
  for (let a = 0; a < energyVertices.length; a++) for (let b = a + 1; b < energyVertices.length; b++) {
    const left = features(energyVertices[a]);
    const delta = features(energyVertices[b]).map((value, index) => value - left[index]);
    const length = dot(delta, delta);
    if (!length) continue;
    const mix = clamp(dot(delta, target.map((value, index) => value - left[index])) / length, 0, 1);
    const point = energyVertices[a].map((value, index) => value + mix * (energyVertices[b][index] - value));
    if (score(point) < score(best)) best = point;
  }
  const exact = constrainedVertices([proteinRow, energyRow, carbRow, fatRow], [proteinTarget, wanted.kcal, wanted.carbs, wanted.fat], ranges);
  for (const point of exact) if (score(point) < score(best)) best = point;
  return best;
}

function mainMeal(base, wanted, carbId, proteinId, overrides, fixed = [ingredient('vegetables', 200)]) {
  const allFixed = fixed.map(item => ({ ...item }));
  let adjustableProtein = proteinId;
  if (proteinId === 'eggs') {
    // Two eggs keep this option usable; albumen supplies any additional protein.
    allFixed.push(ingredient('eggs', 100));
    adjustableProtein = 'egg-whites';
  }
  const fixedMacros = sumMacros(allFixed.map(item => ingredientMacros(item, overrides)));
  const range = bounds(carbId, adjustableProtein);
  // A companion is optional when the two eggs and the cereal already suffice.
  if (proteinId === 'eggs') range.protein = [0, 300];
  const foods = [getFood(carbId, overrides), getFood(adjustableProtein, overrides), getFood('bread', overrides), getFood('olive-oil', overrides)];
  const amounts = balancedAmounts(foods, {
    kcal: wanted.kcal - fixedMacros.kcal,
    carbs: Math.max(0, wanted.carbs - fixedMacros.carbs),
    protein: Math.max(0, wanted.protein - fixedMacros.protein),
    fat: wanted.fat - fixedMacros.fat,
  }, range);
  const ingredients = [ingredient(carbId, amounts[0]), ...allFixed];
  if (amounts[1] > 1e-7) ingredients.splice(proteinId === 'eggs' ? ingredients.length : 1, 0, ingredient(adjustableProtein, amounts[1]));
  if (amounts[2] > 1e-7) ingredients.push(ingredient('bread', amounts[2]));
  if (amounts[3] > 1e-7) ingredients.push(ingredient('olive-oil', amounts[3]));
  const cookMinutes = Math.max({ pasta: 20, rice: 25, couscous: 10, potatoes: 35, 'lentil-pasta-lidl': 20, 'lentil-pasta-lidl-fresh': 15 }[carbId],
    { chicken: 20, eggs: 15, 'egg-whites': 10, salmon: 20, tuna: 5, 'pork-tenderloin': 25, turkey: 20, cod: 20 }[proteinId]);
  const macros = sumMacros(ingredients.map(item => ingredientMacros(item, overrides)));
  const deviations = ['protein', 'carbs', 'fat'].some(key => Math.abs(macros[key] - wanted[key]) > Math.max(4, wanted[key] * 0.12));
  let note = `${cookMinutes}–${cookMinutes + 5} minuti indicativi, preparazioni in parallelo. Pesi prima della cottura: pasta secca a secco, pasta fresca come da confezione; tonno sgocciolato. Verdure e tutto l’olio usato sono inclusi.`;
  const hasEggWhites = proteinId === 'eggs' && ingredients.some(item => item.foodId === 'egg-whites');
  if (proteinId === 'eggs') note += hasEggWhites
    ? ' 100 g di uova ≈ 2 uova medie senza guscio; completa con gli albumi indicati, ben cotti.'
    : ' 100 g di uova ≈ 2 uova medie senza guscio, ben cotte.';
  if (carbId.startsWith('lentil-pasta-lidl')) note += ' Le proteine delle lenticchie sono già conteggiate: la porzione del secondo è adattata.';
  if (amounts[2] > 1e-7) note += ' Il pane a parte completa il pasto; le sue proteine sono già sottratte alla quota del secondo.';
  if (!ingredients.some(item => item.foodId === 'olive-oil')) note += ' I grassi sono già presenti negli alimenti: non è previsto olio aggiuntivo.';
  if (deviations) note += ' Le porzioni pratiche possono discostarsi dagli obiettivi: confronta i totali effettivi.';
  if (Math.abs(macros.protein - wanted.protein) > 0.05) note += ` Proteine: ${macros.protein.toFixed(1)} g rispetto a ${wanted.protein.toFixed(1)} g del pasto di riferimento; il vincolo delle porzioni impedisce l’equivalenza esatta.`;
  const proteinName = hasEggWhites ? 'uova e albumi' : PROTEIN_NAMES[proteinId];
  return previewMeal(base.slot, `${CARB_NAMES[carbId]} con ${proteinName} e verdure`, ingredients, note, overrides, base);
}

// Fixed portions selected explicitly in the profile; their real totals stay visible.
function chocolateBreakfast(base, overrides) {
  return previewMeal('breakfast', 'Shaker, yogurt e cioccolato fondente', [
    ingredient('skim-milk', 250), ingredient('whey', 30), ingredient('greek-yogurt-fage', 150),
    ingredient('oats', 20), ingredient('chocolate-85', 30), ingredient('apple', 150),
  ], 'Uno shaker al giorno: 30 g di polvere in 250 ml di latte scremato. Yogurt con avena e cioccolato, anche fuso; mela a parte. Stessa colazione dopo corsa o pesi. Nessuna frutta secca. Le quantità dipendono dalle etichette indicate.', overrides, base);
}

function chocolateBreakfastOptions(base, overrides) {
  const reference = chocolateBreakfast(base, overrides);
  const options = [reference];
  for (const dairyId of ['protein-pudding-lidl', 'protein-pudding-lidl-vanilla', 'protein-mousse-lidl', 'protein-mousse-lidl-vanilla']) {
    const fixed = reference.ingredients.filter(item => !['greek-yogurt-fage', 'oats'].includes(item.foodId));
    const fixedMacros = sumMacros(fixed.map(item => ingredientMacros(item, overrides)));
    const dairy = getFood(dairyId, overrides); const oats = getFood('oats', overrides);
    const kcal = reference.macros.kcal - fixedMacros.kcal;
    const protein = reference.macros.protein - fixedMacros.protein;
    const determinant = dairy.kcal * oats.protein - oats.kcal * dairy.protein;
    if (Math.abs(determinant) < 1e-8) continue;
    const dairyGrams = 100 * (kcal * oats.protein - oats.kcal * protein) / determinant;
    const oatGrams = 100 * (dairy.kcal * protein - kcal * dairy.protein) / determinant;
    if (dairyGrams <= 0 || dairyGrams > 500 || oatGrams < 0 || oatGrams > 150) continue;
    options.push(previewMeal('breakfast', `Shaker e ${dairy.name}`, [...fixed, ingredient(dairyId, Math.round(dairyGrams / 5) * 5), ...(oatGrams > 0 ? [ingredient('oats', Math.max(5, Math.round(oatGrams / 5) * 5))] : [])],
      `Uno shaker con 250 ml di latte scremato e 30 g di whey. Porzione di dessert adattata alle proteine e alle calorie della colazione base: il vasetto intero è da ${dairy.label.packGrams} g. Cioccolato e mela inclusi; conserva il resto del dessert secondo etichetta. Controlla i grassi e i carboidrati ricalcolati.`, overrides, base));
  }
  options.push(previewMeal('breakfast', 'Shaker, yogurt e fondente 70%', reference.ingredients.map(item => item.foodId === 'chocolate-85' ? ingredient('chocolate-70', item.grams) : item),
    reference.note + ' Variante con 30 g di fondente 70%: calorie e macro leggermente diversi.', overrides, base));
  return options;
}

function chocolateDayPlan(profile, dateKey, overrides) {
  const session = trainingForDate(profile, dateKey);
  const training = session.type !== 'rest';
  const minutes = clockMinutes(session.time || profile.trainingTime || '06:00');
  const base = (slot, time) => ({ id: `${dateKey}-${slot}`, slot, time });
  const breakfast = chocolateBreakfast(base('breakfast', training && minutes < 540 ? clockTime(minutes + 60) : '08:00'), overrides);
  breakfast.note += training ? ' Orario indicativo: mangia dopo la fine effettiva della seduta.' : ' Giorno di riposo: stessi alimenti e quantità.';
  return [
    previewMeal('preworkout', training ? 'Banana prima dell’allenamento' : 'Banana come spuntino', [ingredient('banana', 120)],
      training ? '120 g senza buccia. Piccolo spuntino subito prima, secondo tolleranza; puoi anticiparlo o spostarlo alla colazione. Se lo salti, i totali pianificati diminuiscono.' : '120 g senza buccia. Puoi mangiarla insieme alla colazione: le calorie giornaliere restano uguali.', overrides, base('preworkout', training ? clockTime(minutes - 5) : '10:30')),
    breakfast,
    previewMeal('lunch', 'Pasta al pomodoro, pollo e zucchine', [ingredient('pasta', 90), ingredient('chicken', 120), ingredient('passata', 150), ingredient('vegetables', 250), ingredient('olive-oil', 30)],
      'Pasta 90 g a secco; pollo 120 g a crudo; passata 150 g; zucchine 250 g a crudo. Olio EVO 30 g totali, compresa la cottura. Puoi scegliere le alternative con porzioni ricalcolate.', overrides, base('lunch', '13:00')),
    previewMeal('dinner', 'Riso, merluzzo, zucchine e mela', [ingredient('rice', 65), ingredient('cod', 220), ingredient('vegetables', 250), ingredient('olive-oil', 30), ingredient('apple', 150)],
      'Riso 65 g a secco; merluzzo 220 g a crudo al netto del ghiaccio; zucchine 250 g a crudo; mela 150 g edibili. Olio EVO 30 g totali, compresa la cottura.', overrides, base('dinner', '20:00')),
  ];
}

export function createDayPlan(profile, targets, dateKey, overrides = {}) {
  calculateTargets(profile); // Validate the full profile even when targets are supplied.
  sumMacros([targets]);
  if (targets.kcal <= 0) throw new Error('L’obiettivo calorico deve essere maggiore di zero.');
  const number = dayNumber(dateKey);
  if (profile.mealPlan === 'chocolate-2200') return chocolateDayPlan(profile, dateKey, overrides);
  const session = trainingForDate(profile, dateKey);
  const training = session.type !== 'rest';
  const trainingMinutes = clockMinutes(session.time || profile.trainingTime || '06:00');
  const meals = [];
  const base = slot => ({ id: `${dateKey}-${slot}`, slot, time: slot === 'lunch' ? '13:00' : slot === 'dinner' ? '20:00' : '08:00' });
  if (training && profile.includePreworkout !== false) {
    const snackBase = { ...base('preworkout'), time: clockTime(trainingMinutes - 15) };
    const snack = snackOptions(snackBase, overrides)[rotation(number, 3)];
    if (trainingMinutes < 15) snack.note += ' L’orario dello spuntino cade la sera precedente.';
    meals.push(snack);
  }
  const breakfastBase = { ...base('breakfast'), time: training && trainingMinutes < 9 * 60 ? clockTime(trainingMinutes + 90) : '08:00' };
  const breakfasts = breakfastOptions(targets.kcal * 0.27, breakfastBase, overrides);
  let breakfast = breakfasts[rotation(number, breakfasts.length)];
  if (training && trainingMinutes >= 9 * 60) breakfast = { ...breakfast, note: breakfast.note.replace('Colazione dopo l’allenamento nei giorni attivi.', 'Con l’orario scelto, questa colazione precede l’allenamento; sposta il pasto secondo la tua routine.') };
  meals.push(breakfast);
  const consumed = sumMacros(meals.map(meal => meal.macros));
  const remaining = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, Math.max(0, targets[key] - consumed[key]) / 2]));
  const lunchCarb = CARBS[rotation(number, CARBS.length)];
  const lunchProtein = PROTEINS[rotation(number, PROTEINS.length)];
  const dinnerCarb = CARBS[rotation(number + 2, CARBS.length)];
  const dinnerProtein = PROTEINS[rotation(number + 3, PROTEINS.length)];
  const compose = (carbAtLunch, carbAtDinner) => {
    let lunch = mainMeal(base('lunch'), remaining, carbAtLunch, lunchProtein, overrides);
    const dinnerTargets = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, Math.max(0, targets[key] - consumed[key] - lunch.macros[key])]));
    const dinner = mainMeal(base('dinner'), dinnerTargets, carbAtDinner, dinnerProtein, overrides);
    const gap = targets.kcal - consumed.kcal - lunch.macros.kcal - dinner.macros.kcal;
    if (Math.abs(gap) > targets.kcal * 0.04) lunch = mainMeal(base('lunch'), { ...remaining, kcal: Math.max(0, lunch.macros.kcal + gap) }, carbAtLunch, lunchProtein, overrides);
    return [lunch, dinner];
  };
  const energyError = pair => Math.abs(targets.kcal - consumed.kcal - pair[0].macros.kcal - pair[1].macros.kcal);
  let pair = compose(lunchCarb, dinnerCarb);
  // Some legume/egg combinations hit their protein and portion limits first.
  // Prefer a feasible daily starch choice; all alternatives remain selectable.
  if (energyError(pair) > targets.kcal * 0.05) {
    for (let offset = 1; offset < CARBS.length; offset++) {
      const candidate = compose(CARBS[rotation(number + offset, CARBS.length)], dinnerCarb);
      if (energyError(candidate) < energyError(pair)) pair = candidate;
      if (energyError(pair) <= targets.kcal * 0.03) break;
    }
  }
  if (energyError(pair) > targets.kcal * 0.05) {
    for (let offset = 1; offset < CARBS.length; offset++) {
      const candidate = compose(lunchCarb, CARBS[rotation(number + 2 + offset, CARBS.length)]);
      if (energyError(candidate) < energyError(pair)) pair = candidate;
      if (energyError(pair) <= targets.kcal * 0.03) break;
    }
  }
  meals.push(...pair);
  return meals;
}

export function mealAlternatives(meal, targets, overrides = {}) {
  const current = mealFromIngredients(meal, overrides);
  if (targets !== undefined) sumMacros([targets]);
  if (meal.slot === 'preworkout') return snackOptions(current, overrides);
  if (meal.slot === 'breakfast' && current.ingredients.some(item => item.foodId === 'whey')) return chocolateBreakfastOptions(current, overrides);
  if (meal.slot === 'breakfast') return breakfastOptions(current.macros.kcal || targets?.kcal * 0.27 || 450, current, overrides);
  const fixed = current.ingredients.filter(item => !CARBS.includes(item.foodId) && !PROTEINS.includes(item.foodId) && !['olive-oil', 'bread'].includes(item.foodId));
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
    const fixed = current.ingredients.filter(item => !CARBS.includes(item.foodId) && !PROTEINS.includes(item.foodId) && !['olive-oil', 'bread'].includes(item.foodId));
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
