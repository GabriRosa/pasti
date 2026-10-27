import { normalizeBarcode } from './barcode.js';

const SEARCH_URL = 'https://search.openfoodfacts.org/search';
const PROXY_URL = 'https://pasti.gabri-rosso02.workers.dev/api/foods/search';
const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_SIZE = 20;
const MAX_RESPONSE_BYTES = 512 * 1024;
const caches = new WeakMap();
const clean = value => typeof value === 'string' ? value.trim().slice(0, 200) : '';
const failure = (message, code) => Object.assign(new Error(message), { code });
const unavailable = () => failure('Open Food Facts non è disponibile. Riprova o cerca tramite codice a barre.', 'UPSTREAM_UNAVAILABLE');
const interrupted = () => failure('Ricerca interrotta o scaduta. Puoi riprovare.', 'ABORTED');
const copy = result => ({ ...result, items: result.items.map(item => ({ ...item })) });

function searchInput(query, page) {
  if (typeof query !== 'string') throw failure('Inserisci un nome di almeno 2 e massimo 100 caratteri.', 'INVALID_QUERY');
  const text = query.trim().replace(/\s+/g, ' ');
  if (text.length < 2 || text.length > 100 || /[\u0000-\u001f\u007f]/.test(text)) throw failure('Inserisci un nome di almeno 2 e massimo 100 caratteri.', 'INVALID_QUERY');
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw failure('Pagina di ricerca non valida.', 'INVALID_QUERY');
  return text;
}

function searchResult(body, page) {
  if (!body || !Array.isArray(body.hits) || body.errors?.length || body.timed_out === true) throw unavailable();
  const seen = new Set(), items = [];
  for (const product of body.hits.slice(0, PAGE_SIZE)) {
    if (!product || typeof product.code !== 'string') continue;
    let barcode;
    try { barcode = normalizeBarcode(product.code); } catch { continue; }
    if (seen.has(barcode)) continue;
    seen.add(barcode);
    const brand = Array.isArray(product.brands) ? clean(product.brands.map(clean).filter(Boolean).join(', ')) : clean(product.brands);
    items.push({ barcode, name: clean(product.product_name_it) || clean(product.product_name) || clean(product.product_name_en) || `Prodotto ${barcode}`, brand });
  }
  // Search-a-licious page_count is the number of pages; count can be a lower bound.
  const exactCount = body.is_count_exact === true && Number.isSafeInteger(body.count) && body.count >= 0;
  const pageCount = Number.isSafeInteger(body.page_count) && body.page_count >= 0 ? body.page_count : null;
  const hasMore = page < MAX_PAGE && body.hits.length > 0 && (exactCount ? page * PAGE_SIZE < body.count : pageCount !== null ? page < pageCount : body.hits.length >= PAGE_SIZE);
  return { items, page, hasMore };
}

function proxyResult(body, page) {
  if (!body || !Array.isArray(body.items) || body.items.length > PAGE_SIZE || body.page !== page || typeof body.hasMore !== 'boolean') throw unavailable();
  const seen = new Set(), items = [];
  for (const item of body.items) {
    if (!item || typeof item.barcode !== 'string' || typeof item.name !== 'string' || typeof item.brand !== 'string') throw unavailable();
    let barcode;
    try { barcode = normalizeBarcode(item.barcode); } catch { continue; }
    if (seen.has(barcode)) continue;
    seen.add(barcode);
    items.push({ barcode, name: clean(item.name) || `Prodotto ${barcode}`, brand: clean(item.brand) });
  }
  return { items, page, hasMore: page < MAX_PAGE && body.hasMore };
}

async function readJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) throw unavailable();
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable(); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

async function search(query, { page = 1, signal, fetchImpl = fetch } = {}, upstream) {
  const text = searchInput(query, page);
  if (signal?.aborted) throw interrupted();
  const key = JSON.stringify([upstream, text, page]);
  let cache = caches.get(fetchImpl);
  if (!cache) { cache = new Map(); caches.set(fetchImpl, cache); }
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return copy(cached.result);
  cache.delete(key);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    // Keep plain words: the deployed engine returns no hits for quoted words.
    // Escape Lucene syntax and lowercase reserved operators in product names.
    const q = text.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&').replace(/\b(AND|OR|NOT)\b/g, word => word.toLowerCase());
    const params = upstream
      ? new URLSearchParams({ q, page: String(page), page_size: String(PAGE_SIZE), langs: 'it,en', fields: 'code,product_name,product_name_it,product_name_en,brands' })
      : new URLSearchParams({ q: text, page: String(page) });
    const response = await fetchImpl(`${upstream ? SEARCH_URL : PROXY_URL}?${params}`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (response.status === 429) throw failure('Troppe ricerche. Attendi un minuto prima di riprovare.', 'RATE_LIMITED');
    if (!upstream && response.status === 400) throw failure('Ricerca non valida. Inserisci un nome di almeno 2 e massimo 100 caratteri.', 'INVALID_QUERY');
    if (!response.ok) throw unavailable();
    const payload = await readJson(response);
    const result = upstream ? searchResult(payload, page) : proxyResult(payload, page);
    if (controller.signal.aborted) throw interrupted();
    for (const [entryKey, entry] of cache) if (entry.until <= Date.now()) cache.delete(entryKey);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, { until: Date.now() + CACHE_TTL, result });
    return copy(result);
  } catch (error) {
    if (controller.signal.aborted) throw interrupted();
    if (error instanceof TypeError) throw failure('Connessione non disponibile. Controlla la rete o cerca tramite codice a barre.', 'UPSTREAM_UNAVAILABLE');
    if (error instanceof SyntaxError) throw unavailable();
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Browser adapter through the fixed public Pasti proxy; sends only query and page. */
export async function searchFoods(query, options = {}) { return search(query, options, false); }

/** Server adapter for the official full-text API. Summaries contain no nutrients.
 * Errors expose code: INVALID_QUERY, RATE_LIMITED, UPSTREAM_UNAVAILABLE or ABORTED.
 * Resolve the selected barcode through lookupProduct for current nutrition data.
 */
export async function searchFoodsUpstream(query, options = {}) { return search(query, options, true); }
