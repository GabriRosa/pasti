const crea = code => `https://www.alimentinutrizione.it/tabelle-nutrizionali/${code}`;
const food = (id, name, group, kcal, protein, carbs, fat, unitNote, source, estimated = false) =>
  Object.freeze({ id, name, group, kcal, protein, carbs, fat, unitNote, source, estimated });

/** Values per 100 g edible portion. Traces in CREA are represented as zero. */
export const FOODS = Object.freeze([
  food('pasta', 'Pasta di semola', 'carb', 341, 13.5, 72.7, 1.2, 'Peso a crudo, pasta secca.', crea('000800')),
  food('rice', 'Riso', 'carb', 334, 6.7, 80.4, 0.4, 'Peso a crudo, riso secco.', crea('000100')),
  food('couscous', 'Couscous', 'carb', 361, 13.7, 76.5, 1.1, 'Peso a secco prima di aggiungere acqua.', crea('000045')),
  food('potatoes', 'Patate', 'carb', 72, 2, 16, 0.1, 'Peso a crudo, parte edibile senza scarti.', crea('006500')),
  food('lentil-pasta-lidl', 'Pasta di lenticchie Lidl · stima generica', 'carb', 334, 26, 50, 1.7,
    'Peso a secco. Stima di pasta 100% lenticchie; etichetta Lidl non verificata: inserisci i valori della confezione.',
    'https://shop.probios.it/prodotti/piatti-pronti-prepar/pasta/pasta-di-legumi/fusilli-100-lenticchie-rosse.html', true),
  food('chicken', 'Petto di pollo', 'protein', 100, 23.3, 0, 0.8, 'Peso a crudo, senza pelle e ossa. Consumare cotto.', crea('106500')),
  food('eggs', 'Uova intere', 'protein', 128, 12.4, 0, 8.7, 'Peso senza guscio: circa 50 g per uovo medio. Consumare cotte.', crea('181100')),
  food('egg-whites', 'Albumi', 'protein', 43, 10.7, 0, 0, 'Peso a crudo: circa 30–35 g per albume; comodi quelli pastorizzati in brick. Consumare cotti.', crea('182010')),
  food('salmon', 'Salmone', 'protein', 185, 18.4, 1, 12, 'Peso a crudo, senza lische e scarti. Consumare cotto.', crea('122400')),
  food('tuna', 'Tonno al naturale', 'protein', 103, 25.1, 0, 0.3, 'Peso sgocciolato. Il tonno sott’olio ha valori diversi.', crea('123550')),
  food('pork-tenderloin', 'Filetto di maiale', 'protein', 128, 20.65, 0, 3.53,
    'Peso a crudo, taglio filetto disossato. Consumare cotto.',
    'https://www.ars.usda.gov/ARSUserFiles/80400525/Data/Pork/Pork1-1.pdf#page=13'),
  food('olive-oil', 'Olio extravergine d’oliva', 'fat', 899, 0, 0, 99.9, 'Peso effettivamente usato, compreso l’olio di cottura.', crea('009210')),
  food('vegetables', 'Verdure · riferimento zucchine', 'vegetable', 16, 1.5, 1.7, 0.1,
    'Peso a crudo, senza scarti. Valori delle zucchine come riferimento; altre verdure possono differire.', crea('005730'), true),
  food('banana', 'Banana', 'fruit', 76, 1.2, 17.4, 0.3, 'Peso senza buccia: circa 100–120 g per banana media.', crea('007510')),
  food('rice-cakes', 'Gallette di riso', 'carb', 383, 8.6, 78, 3.3,
    'Pronte da mangiare. Circa 7–8 g a galletta, verifica la confezione. Riferimento RisoALMO.',
    'https://www.risoalmo.it/catalogo-prodotti-almo.pdf#page=10', true),
  food('jam', 'Confettura', 'breakfast', 227, 0.5, 58.7, 0, 'Pronta da mangiare; confetture con meno zuccheri hanno valori diversi.', crea('204500')),
  food('oats', 'Fiocchi d’avena', 'breakfast', 367, 8, 66.8, 7.5, 'Peso a secco; acqua aggiunta senza calorie.', crea('003030')),
  food('greek-yogurt', 'Yogurt greco bianco 0%', 'breakfast', 51, 9, 4, 0, 'Peso del prodotto; per yogurt intero o zuccherato modifica i valori.', crea('150030')),
  food('bread', 'Pane integrale', 'carb', 224, 8.5, 44.1, 1.3, 'Peso del pane pronto da mangiare.', crea('000550')),
  food('protein-pudding-lidl', 'Budino proteico Lidl/Milbona · stima', 'breakfast', 76, 10, 5.5, 1.5,
    'Esempio di vasetto da 200 g, grammatura modificabile. Stima da un budino proteico analogo; etichetta Lidl non verificata.',
    'https://shop.ehrmann.de/products/ehrmann-high-protein-pudding-chocolate', true),
  food('protein-mousse-lidl', 'Mousse proteica Lidl/Milbona · stima', 'breakfast', 74, 10, 5, 1.6,
    'Esempio di vasetto da 200 g, grammatura modificabile. Stima da una mousse proteica analoga; etichetta Lidl non verificata.',
    'https://www.ehrmann.de/high-protein-duo-mousse-vanilla-chocolate-flavour/', true),
  food('dark-chocolate', 'Cioccolato fondente', 'fat', 531, 6.6, 49.7, 33.6,
    'Peso prima di scioglierlo; il tenore di cacao e i valori cambiano tra confezioni.', crea('203020')),
]);

const BY_ID = new Map(FOODS.map(item => [item.id, item]));
const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

export function getFood(id, overrides = {}) {
  const base = BY_ID.get(id);
  if (!base) throw new Error(`Alimento non riconosciuto: ${String(id)}.`);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Le etichette personalizzate devono essere una mappa di alimenti.');
  const values = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
  if (values === undefined) return { ...base };
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Etichetta non valida per ${base.name}.`);
  const result = { ...base };
  for (const key of MACROS) {
    if (!Object.hasOwn(values, key) || typeof values[key] !== 'number' || !Number.isFinite(values[key]) || values[key] < 0) {
      throw new Error(`Per ${base.name} inserisci tutti e quattro i valori per 100 g, finiti e non negativi.`);
    }
    result[key] = values[key];
  }
  return result;
}

export function foodMacros(id, grams, overrides = {}) {
  if (typeof grams !== 'number' || !Number.isFinite(grams) || grams < 0) throw new Error('La quantità in grammi deve essere un numero finito e non negativo.');
  const item = getFood(id, overrides);
  const result = Object.fromEntries(MACROS.map(key => [key, item[key] * (grams / 100)]));
  if (Object.values(result).some(value => !Number.isFinite(value))) throw new Error('La quantità o i valori nutrizionali sono troppo grandi.');
  return result;
}
