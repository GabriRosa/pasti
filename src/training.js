const DAY_MS = 86400000;
const TYPES = ['rest', 'run', 'strength'];
const LABELS = { rest: 'Riposo', run: 'Corsa', strength: 'Sala attrezzi' };

function calendarDay(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('La data di allenamento deve avere formato AAAA-MM-GG.');
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year < 1900 || year > 2100) throw new Error('Scegli una data di allenamento tra il 1900 e il 2100.');
  const value = Date.UTC(year, month - 1, day);
  if (new Date(value).toISOString().slice(0, 10) !== dateKey) throw new Error('La data di allenamento non esiste.');
  return value / DAY_MS;
}

export function validateTrainingPlan(plan) {
  if (plan === undefined) return undefined;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Il programma di allenamento non ha un formato valido.');
  const allowed = plan.mode === 'alternating' ? ['mode', 'startDate', 'firstType']
    : plan.mode === 'weekly' ? ['mode', 'days'] : null;
  if (!allowed || Object.keys(plan).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(plan, key))) {
    throw new Error('Scegli un programma valido: alternanza oppure settimana personalizzata.');
  }
  if (plan.mode === 'alternating') {
    calendarDay(plan.startDate);
    if (!['run', 'strength'].includes(plan.firstType)) throw new Error('La prima attività deve essere corsa oppure sala attrezzi.');
  } else if (!Array.isArray(plan.days) || plan.days.length !== 7 || !Array.from(plan.days).every(type => TYPES.includes(type))) {
    throw new Error('Indica sette attività settimanali: riposo, corsa o sala attrezzi, a partire dalla domenica.');
  }
  return plan;
}

export function trainingForDate(profile, dateKey) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Completa prima il profilo di allenamento.');
  const day = calendarDay(dateKey);
  const plan = validateTrainingPlan(profile.trainingPlan);
  const time = profile.trainingTime ?? '06:00';
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Inserisci l’orario di allenamento nel formato HH:MM.');
  let type;
  if (plan?.mode === 'alternating') {
    const offset = day - calendarDay(plan.startDate);
    const sameType = ((offset % 2) + 2) % 2 === 0;
    type = sameType ? plan.firstType : plan.firstType === 'run' ? 'strength' : 'run';
  } else if (plan?.mode === 'weekly') {
    type = plan.days[new Date(day * DAY_MS).getUTCDay()];
  } else {
    const days = profile.trainingDays ?? [];
    if (!Array.isArray(days) || new Set(days).size !== days.length || !Array.from(days).every(value => Number.isInteger(value) && value >= 0 && value <= 6)) {
      throw new Error('I giorni di allenamento devono essere compresi tra domenica (0) e sabato (6).');
    }
    type = days.includes(new Date(day * DAY_MS).getUTCDay()) ? 'strength' : 'rest';
  }
  return { type, label: LABELS[type], time: type === 'rest' ? '' : time };
}
