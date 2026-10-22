import { validateTrainingPlan } from './training.js?v=20261023-activity';

/** Estimates for healthy adults. See docs/nutrition.md for assumptions and sources. */
export const ACTIVITY_LEVELS = Object.freeze([
  { id: 'sedentary', label: 'Poco attivo · attività e allenamenti limitati', factor: 1.2 },
  { id: 'light', label: 'Leggermente attivo · movimento e allenamenti leggeri', factor: 1.375 },
  { id: 'moderate', label: 'Moderatamente attivo · movimento e allenamenti regolari', factor: 1.55 },
  { id: 'active', label: 'Molto attivo · lavoro fisico o allenamenti frequenti', factor: 1.725 },
  { id: 'very-active', label: 'Attività elevata · lavoro fisico e allenamenti intensi', factor: 1.9 },
].map(Object.freeze));

const KEYS = ['kcal', 'protein', 'carbs', 'fat'];

function numberInRange(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}: inserisci un numero tra ${min} e ${max}.`);
  }
}

export function sumMacros(items) {
  if (!Array.isArray(items)) throw new Error('I valori nutrizionali devono essere un elenco.');
  return items.reduce((total, item) => {
    for (const key of KEYS) {
      if (!item || typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) {
        throw new Error('I valori nutrizionali devono essere numeri finiti e non negativi.');
      }
      total[key] += item[key];
      if (!Number.isFinite(total[key])) throw new Error('Il totale nutrizionale è troppo grande.');
    }
    return total;
  }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

export function calculateTargets(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Completa prima il profilo.');
  numberInRange(profile.age, 18, 100, 'Età (solo adulti)');
  numberInRange(profile.weight, 35, 250, 'Peso in kg');
  numberInRange(profile.height, 130, 230, 'Altezza in cm');
  if (!['male', 'female'].includes(profile.sex)) {
    throw new Error('Seleziona il sesso biologico usato nella formula: maschile o femminile.');
  }
  const activity = ACTIVITY_LEVELS.find(level => level.id === profile.activity);
  if (!activity) throw new Error('Seleziona un livello di attività valido.');
  if (!['lose', 'maintain', 'gain'].includes(profile.goal)) throw new Error('Seleziona un obiettivo valido.');
  if (profile.deficitKcal !== undefined && (typeof profile.deficitKcal !== 'number' || !Number.isFinite(profile.deficitKcal) || profile.deficitKcal < 0)) {
    throw new Error('Il deficit in kcal deve essere un numero finito maggiore o uguale a zero.');
  }
  validateTrainingPlan(profile.trainingPlan);
  if (profile.specialCondition !== undefined && typeof profile.specialCondition !== 'boolean') {
    throw new Error('La voce sulle condizioni particolari deve essere sì o no.');
  }
  if (profile.specialCondition) {
    throw new Error('In gravidanza, allattamento, con patologie o disturbi alimentari serve un piano personalizzato con un professionista. Il calcolo automatico è sospeso.');
  }
  if (profile.trainingDays !== undefined && (!Array.isArray(profile.trainingDays)
    || new Set(profile.trainingDays).size !== profile.trainingDays.length
    || Array.from(profile.trainingDays).some(day => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error('I giorni di allenamento devono essere compresi tra domenica (0) e sabato (6).');
  }
  if (profile.trainingTime !== undefined && (typeof profile.trainingTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(profile.trainingTime))) {
    throw new Error('Inserisci l’orario di allenamento nel formato HH:MM.');
  }

  const warnings = [];
  // Mifflin–St Jeor, commonly used rounded form, kg / cm / years.
  const bmr = 10 * profile.weight + 6.25 * profile.height - 5 * profile.age + (profile.sex === 'male' ? 5 : -161);
  const tdee = bmr * activity.factor;
  const bmi = profile.weight / (profile.height / 100) ** 2;
  const explicitDeficit = profile.goal === 'lose' && profile.deficitKcal !== undefined;
  if (explicitDeficit && profile.deficitKcal >= tdee) {
    throw new Error('Il deficit deve essere inferiore al dispendio totale giornaliero stimato (TDEE), così l’obiettivo resta positivo.');
  }
  let kcal = explicitDeficit ? tdee - profile.deficitKcal : tdee * (profile.goal === 'lose' ? 0.9 : profile.goal === 'gain' ? 1.05 : 1);
  if (bmi < 18.5) {
    warnings.push('Il rapporto peso/altezza indica possibile sottopeso: valuta le stime con un professionista.');
    if (explicitDeficit && profile.deficitKcal > 0) {
      throw new Error('Con possibile sottopeso il deficit selezionato non può essere applicato. Scegli mantenimento (0 kcal di deficit) e valuta il profilo con un professionista.');
    }
    if (profile.goal === 'lose' && !explicitDeficit) {
      kcal = tdee;
      warnings.push('Il deficit automatico è disattivato: viene mostrata solo la stima di mantenimento.');
    }
  }
  if (bmi >= 30) warnings.push('Con un rapporto peso/altezza elevato, calorie e proteine richiedono una valutazione individuale.');
  if (profile.age > 78 || profile.age === 18) warnings.push('L’età è fuori dall’intervallo 19–78 anni del campione originale: la stima è meno documentata.');
  const proteinPerKg = profile.goal === 'lose' && kcal < tdee ? 1.8 : 1.6;
  // Keep protein from crowding out the other macronutrients at extreme inputs.
  const protein = Math.min(profile.weight * proteinPerKg, kcal * 0.35 / 4);
  if (protein < profile.weight * proteinPerKg) {
    warnings.push('La stima proteica è limitata al 35% dell’energia per lasciare spazio agli altri nutrienti; personalizzala con un professionista.');
  }
  const fat = kcal * 0.3 / 9;
  const carbs = (kcal - protein * 4 - fat * 9) / 4;
  if (kcal < 1500 || kcal > 3500) warnings.push('La stima calorica è bassa o elevata rispetto a un uso comune: controlla i dati e non considerarla una prescrizione.');
  if (activity.factor >= 1.725) warnings.push('Il fattore di attività elevato include già gli allenamenti: non aggiungere altre calorie per corsa o sala attrezzi.');
  warnings.push('Sono stime iniziali per adulti sani. Il dispendio medio include già corsa, sala attrezzi e attività quotidiana; i giorni di riposo mantengono lo stesso obiettivo.');
  const energyMethod = explicitDeficit
    ? `obiettivo = TDEE − ${profile.deficitKcal} kcal`
    : `energia × ${profile.goal === 'gain' ? 1.05 : kcal < tdee ? 0.9 : 1}${profile.goal === 'lose' && kcal < tdee ? ' (profilo precedente: deficit automatico del 10%)' : ''}`;

  return {
    bmr, tdee, kcal, protein, carbs, fat, warnings,
    method: `Mifflin–St Jeor (forma arrotondata): 10 × kg + 6,25 × cm − 5 × anni ${profile.sex === 'male' ? '+ 5' : '− 161'}. Attività × ${activity.factor}; ${energyMethod}; proteine orientative ${proteinPerKg} g/kg (massimo 35% energia); grassi 30%, carboidrati residui. Fonti: https://doi.org/10.1093/ajcn/51.2.241 ; https://doi.org/10.1186/s12970-017-0177-8 . Fattori e ripartizione sono scelte orientative dell’app.`,
  };
}
