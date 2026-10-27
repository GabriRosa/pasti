/** Public Open Food Facts reads; no profile or diary data is sent. */
export function normalizeBarcode(input) {
  const code = String(input).replace(/[\s-]/g, '');
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) throw new Error('Inserisci un codice EAN/UPC di 8, 12, 13 o 14 cifre.');
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(code[i]) * weight;
  if ((10 - sum % 10) % 10 !== Number(code.at(-1))) throw new Error('Il codice non è valido. Controlla tutte le cifre sotto le barre.');
  return code;
}
const clean = value => typeof value === 'string' ? value.trim().slice(0, 200) : '';
export function productFromResponse(body, barcode) {
  const code = normalizeBarcode(barcode);
  if (!body?.product || body.result?.id === 'product_not_found') throw new Error('Prodotto non trovato. Puoi inserire i dati della confezione a mano.');
  const p = body.product;
  const set = p.nutrition?.aggregated_set;
  const validBasis = ['100g', '100ml'].includes(set?.per) && set?.preparation === 'as_sold';
  const n = validBasis ? set.nutrients ?? {} : {};
  const value = (key, unit, max) => {
    const item = n[key];
    return item?.unit === unit && typeof item.value === 'number' && Number.isFinite(item.value) && item.value >= 0 && item.value <= max ? item.value : null;
  };
  let kcal = value('energy-kcal', 'kcal', 1000);
  const kj = value('energy-kj', 'kJ', 4184);
  if (kcal === null && kj !== null) kcal = kj / 4.184;
  return { name: clean(p.product_name_it) || clean(p.product_name), brand: clean(p.brands), barcode: code,
    unit: set?.per === '100ml' ? 'ml' : 'g', kcal, protein: value('proteins', 'g', 100),
    carbs: value('carbohydrates', 'g', 100), fat: value('fat', 'g', 100) };
}
export async function lookupProduct(barcode, { signal, fetchImpl = fetch } = {}) {
  const code = normalizeBarcode(barcode);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const params = new URLSearchParams({ fields: 'product_name,product_name_it,brands,nutrition', lc: 'it', cc: 'it', app_name: 'Pasti', app_version: '1.1' });
    const response = await fetchImpl(`https://world.openfoodfacts.org/api/v3.6/product/${code}?${params}`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (response.status === 404) throw new Error('Prodotto non trovato. Puoi inserire i dati della confezione a mano.');
    if (response.status === 429) throw new Error('Troppe ricerche. Attendi un minuto prima di riprovare.');
    if (!response.ok) throw new Error('Open Food Facts non è disponibile. Riprova o inserisci i valori a mano.');
    return productFromResponse(await response.json(), code);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Ricerca interrotta o scaduta. Puoi riprovare.');
    if (error instanceof TypeError) throw new Error('Connessione non disponibile. Controlla la rete o inserisci i valori a mano.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function validatePersonalFood(food) {
  if (!food || typeof food !== 'object' || Array.isArray(food) || Object.keys(food).some(k => !['name', 'brand', 'barcode', 'unit', 'kcal', 'protein', 'carbs', 'fat'].includes(k))) throw new Error('Formato del prodotto personale non valido.');
  for (const key of ['name', 'brand', 'barcode']) if (typeof food[key] !== 'string' || food[key].length > 200) throw new Error('Nome, marca o codice non valido.');
  if (!food.name.trim()) throw new Error('Inserisci il nome del prodotto.');
  if (food.barcode && normalizeBarcode(food.barcode) !== food.barcode) throw new Error('Codice non valido.');
  if (!['g', 'ml'].includes(food.unit)) throw new Error('Scegli grammi o millilitri.');
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) if (typeof food[key] !== 'number' || !Number.isFinite(food[key]) || food[key] < 0 || food[key] > (key === 'kcal' ? 1000 : 100)) throw new Error('Completa i quattro valori nutrizionali per 100 g o 100 ml.');
  return food;
}
let decoderPromise;
function loadDecoder() {
  if (globalThis.ZXingBrowser) return Promise.resolve(globalThis.ZXingBrowser);
  if (!decoderPromise) decoderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/zxing-browser-0.2.1.min.js', import.meta.url).href;
    script.onload = () => resolve(globalThis.ZXingBrowser);
    script.onerror = () => { script.remove(); decoderPromise = null; reject(new Error('Lettore non caricato. Riprova o inserisci il codice a mano.')); };
    document.head.append(script);
  });
  return decoderPromise;
}
/** Own the stream explicitly, including permission responses that arrive after stop(). */
export function createBarcodeScanner({ video, onCode, onError, mediaDevices = globalThis.navigator?.mediaDevices, decoder = loadDecoder }) {
  let generation = 0, stream, controls;
  const stop = () => { generation++; controls?.stop(); controls = null; stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; };
  const start = async () => {
    stop(); const current = generation;
    try {
      if (!mediaDevices?.getUserMedia) throw new Error('Fotocamera non disponibile: apri il sito in HTTPS oppure inserisci il codice a mano.');
      const library = await decoder();
      if (current !== generation) return;
      const acquired = await mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } });
      if (current !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; video.srcObject = stream;
      const reader = new library.BrowserMultiFormatOneDReader();
      const active = await reader.decodeFromVideoElement(video, result => {
        if (!result || current !== generation) return;
        let code; try { code = normalizeBarcode(result.getText()); } catch { return; }
        stop(); onCode(code);
      });
      if (current !== generation) active.stop(); else controls = active;
    } catch (error) {
      if (current !== generation) return;
      stop(); onError(error.name === 'NotAllowedError' ? 'Accesso alla fotocamera negato. Puoi abilitarlo nelle impostazioni del browser o scrivere il codice.' : error.name === 'NotFoundError' ? 'Nessuna fotocamera trovata. Inserisci il codice a mano.' : error.message);
    }
  };
  return { start, stop };
}
