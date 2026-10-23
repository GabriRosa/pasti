import { getGoogleHealthDay, verifyGoogleHealthAccount } from './google-health.js?v=20261023-google-health';

export const GOOGLE_HEALTH_SCOPE = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
const REFRESH_MS = 5 * 60 * 1000;
const MESSAGES = {
  AUTH_REQUIRED: 'La sessione Google è scaduta. Ricollega il tuo account per continuare.',
  ACCESS_DENIED: 'Google non ha concesso il permesso necessario per leggere le calorie.',
  ACCOUNT_NOT_LINKED: 'Questo account non è collegato a Google Health. Accedi prima all’app Google Health con lo stesso account, poi ricollega.',
  RATE_LIMITED: 'Google ha limitato le richieste. L’aggiornamento automatico è sospeso: riprova più tardi.',
  UNAVAILABLE: 'Google Health non è raggiungibile. Puoi riprovare con Aggiorna.',
  INVALID_RESPONSE: 'La risposta di Google Health non è utilizzabile. Non sono stati aggiunti valori.',
  AUTH_CANCELLED: 'Accesso Google non completato. Il diario è rimasto invariato.',
  AUTH_TIMEOUT: 'La richiesta di accesso Google è scaduta. Puoi riprovare.',
  GIS_UNAVAILABLE: 'Il servizio di accesso Google non si è caricato. Puoi riprovare.',
};
const snapshot = value => JSON.parse(JSON.stringify(value));
const calendarDate = date => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/** Load only the official GIS script. Loading does not request health access. */
export function loadGoogleIdentityServices(documentRef = globalThis.document, {
  timeoutMs = 15000,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
} = {}) {
  return new Promise((resolve, reject) => {
    if (!documentRef?.createElement || !documentRef?.head) { reject(new Error('GIS_UNAVAILABLE')); return; }
    const script = documentRef.createElement('script');
    let settled = false;
    let timer = null;
    const finish = (service = null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      script.removeEventListener?.('load', loaded);
      script.removeEventListener?.('error', failed);
      if (service) resolve(service);
      else { script.remove(); reject(new Error('GIS_UNAVAILABLE')); }
    };
    const loaded = () => {
      if (settled) return;
      const oauth = globalThis.google?.accounts?.oauth2;
      finish(typeof oauth?.initTokenClient === 'function' ? oauth : null);
    };
    const failed = () => finish();
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    timer = setTimer(failed, timeoutMs);
    try { documentRef.head.append(script); } catch { finish(); }
  });
}

/** Tokens stay in this closure; snapshots contain only UI state and day results. */
export function createGoogleHealthSession({
  clientId = '', readDay = getGoogleHealthDay, verifyAccount = verifyGoogleHealthAccount,
  loadOAuth = loadGoogleIdentityServices, now = () => new Date(),
  setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer),
  onChange = () => {},
} = {}) {
  clientId = typeof clientId === 'string' ? clientId.trim() : '';
  let token = '';
  let expiresAt = 0;
  let oauth = null;
  let preparing = null;
  let generation = 0;
  let readRevision = 0;
  let autoTimer = null;
  let expiryTimer = null;
  let authTimer = null;
  let autoPaused = false;
  let disposed = false;
  let context = { dateKey: '', visible: true, active: false };
  let state = { status: clientId ? 'disconnected' : 'unconfigured', ready: false, busy: false, dateKey: '', data: null, error: null, stale: false };
  const emit = () => { if (!disposed) onChange(snapshot(state)); };
  const setState = update => { state = { ...state, ...update }; emit(); };
  const stopAuto = () => { if (autoTimer !== null) clearTimer(autoTimer); autoTimer = null; };
  const stopExpiry = () => { if (expiryTimer !== null) clearTimer(expiryTimer); expiryTimer = null; };
  const stopAuth = () => { if (authTimer !== null) clearTimer(authTimer); authTimer = null; };
  const validToken = () => Boolean(token) && now().getTime() < expiresAt;
  function clearCredentials() {
    token = ''; expiresAt = 0; generation += 1; readRevision += 1; stopAuto(); stopExpiry(); stopAuth();
  }
  function expire() {
    clearCredentials();
    setState({ status: 'expired', busy: false, data: null, stale: false, error: { code: 'AUTH_REQUIRED', message: MESSAGES.AUTH_REQUIRED } });
  }
  function armExpiry() {
    stopExpiry();
    if (token) expiryTimer = setTimer(expire, Math.max(0, expiresAt - now().getTime()));
  }
  function armAuto() {
    stopAuto();
    if (!disposed && validToken() && state.status === 'connected' && !state.busy && !autoPaused && context.active && context.visible && context.dateKey === calendarDate(now())) {
      autoTimer = setTimer(() => { autoTimer = null; void refresh(false); }, REFRESH_MS);
    }
  }
  function safeError(error) {
    const code = typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code) ? error.code : 'UNAVAILABLE';
    return { code, message: MESSAGES[code] };
  }
  function fail(error) {
    const safe = safeError(error);
    autoPaused = true; stopAuto();
    if (['AUTH_REQUIRED', 'ACCESS_DENIED', 'ACCOUNT_NOT_LINKED'].includes(safe.code)) {
      clearCredentials();
      setState({ status: safe.code === 'AUTH_REQUIRED' ? 'expired' : safe.code === 'ACCOUNT_NOT_LINKED' ? 'account_not_linked' : 'disconnected', busy: false, data: null, stale: false, error: safe });
    } else setState({ busy: false, stale: Boolean(state.data), error: safe });
  }
  async function prepare() {
    if (disposed || !clientId || oauth) return;
    if (preparing) return preparing;
    setState({ ready: false, error: null });
    preparing = Promise.resolve().then(loadOAuth).then(service => {
      if (disposed) return;
      if (typeof service?.initTokenClient !== 'function') throw new Error('GIS_UNAVAILABLE');
      oauth = service; setState({ ready: true, error: null });
    }).catch(() => {
      if (!disposed) setState({ ready: false, error: { code: 'GIS_UNAVAILABLE', message: MESSAGES.GIS_UNAVAILABLE } });
    }).finally(() => { preparing = null; });
    return preparing;
  }
  function connect() {
    if (disposed || !clientId || !oauth || ['authorizing', 'verifying'].includes(state.status)) return false;
    clearCredentials(); autoPaused = false;
    const connection = generation;
    setState({ status: 'authorizing', busy: true, data: null, stale: false, error: null });
    const cancelled = (code = 'AUTH_CANCELLED') => {
      if (disposed || connection !== generation) return;
      clearCredentials();
      setState({ status: 'disconnected', busy: false, data: null, error: { code, message: MESSAGES[code] } });
    };
    try {
      authTimer = setTimer(() => cancelled('AUTH_TIMEOUT'), 5 * 60 * 1000);
      const client = oauth.initTokenClient({
        client_id: clientId, scope: GOOGLE_HEALTH_SCOPE, include_granted_scopes: false,
        error_callback: () => cancelled(),
        callback: async response => {
          if (disposed || connection !== generation) return;
          stopAuth();
          if (response?.error) { fail({ code: response.error === 'access_denied' ? 'ACCESS_DENIED' : 'AUTH_REQUIRED' }); return; }
          const scopes = typeof response?.scope === 'string' ? [...new Set(response.scope.split(/\s+/).filter(Boolean))] : [];
          const rawExpiry = response?.expires_in;
          const seconds = Number(rawExpiry);
          const expiry = now().getTime() + seconds * 1000;
          if (scopes.length !== 1 || scopes[0] !== GOOGLE_HEALTH_SCOPE || typeof response?.access_token !== 'string' || !response.access_token || /\s/.test(response.access_token) || !['number', 'string'].includes(typeof rawExpiry) || !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(expiry) || expiry > 8640000000000000) {
            fail({ code: 'ACCESS_DENIED' }); return;
          }
          token = response.access_token; expiresAt = now().getTime() + seconds * 1000; armExpiry();
          setState({ status: 'verifying', busy: true });
          try {
            await verifyAccount({ accessToken: token });
            if (disposed || connection !== generation) return;
            if (!validToken()) { expire(); return; }
            setState({ status: 'connected', busy: false, error: null });
            if (context.active && context.visible) await refresh(false);
          } catch (error) { if (!disposed && connection === generation) fail(error); }
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
      return true;
    } catch { cancelled(); return false; }
  }
  async function refresh(manual = true) {
    stopAuto();
    if (disposed || !token || state.status !== 'connected') return;
    if (!validToken()) { expire(); return; }
    if (!context.active || !context.visible || state.busy || !context.dateKey || context.dateKey > calendarDate(now())) return;
    if (!manual && autoPaused) return;
    if (manual) autoPaused = false;
    const request = ++readRevision;
    const connection = generation;
    const dateKey = context.dateKey;
    setState({ busy: true, error: null });
    try {
      const result = await readDay({ accessToken: token, dateKey, now: now() });
      if (disposed || connection !== generation || request !== readRevision || dateKey !== context.dateKey || !context.active || !context.visible) return;
      if (!validToken()) { expire(); return; }
      const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const validTime = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
      if (!result || result.dateKey !== dateKey || result.source !== 'google_health' || result.timeZone !== 'Europe/Rome'
        || ![result.rangeStart, result.rangeEnd, result.fetchedAt].every(validTime)
        || ![result.totalKcal, result.activeKcal].every(value => value === null || validNumber(value))
        || !result.coverage || ![result.coverage.totalSeconds, result.coverage.activeSeconds, result.coverage.requestedSeconds].every(validNumber)
        || result.coverage.totalSeconds > result.coverage.requestedSeconds || result.coverage.activeSeconds > result.coverage.requestedSeconds) throw { code: 'INVALID_RESPONSE' };
      const safeData = { source: result.source, dateKey, timeZone: result.timeZone, rangeStart: result.rangeStart, rangeEnd: result.rangeEnd,
        fetchedAt: result.fetchedAt, totalKcal: result.totalKcal, activeKcal: result.activeKcal,
        coverage: { totalSeconds: result.coverage.totalSeconds, activeSeconds: result.coverage.activeSeconds, requestedSeconds: result.coverage.requestedSeconds } };
      setState({ busy: false, data: safeData, stale: false, error: null }); armAuto();
    } catch (error) { if (!disposed && connection === generation && request === readRevision) fail(error); }
  }
  function setContext(next) {
    const updated = { dateKey: next.dateKey, active: Boolean(next.active), visible: Boolean(next.visible) };
    if (updated.dateKey === context.dateKey && updated.active === context.active && updated.visible === context.visible) return;
    const dateChanged = updated.dateKey !== context.dateKey;
    const pageChanged = updated.active !== context.active;
    context = updated; readRevision += 1; stopAuto();
    if (dateChanged) autoPaused = false;
    setState({ dateKey: context.dateKey, busy: ['authorizing', 'verifying'].includes(state.status), ...(dateChanged || pageChanged ? { data: null, stale: false } : {}) });
    if (token && !validToken()) { expire(); return; }
    if (validToken() && state.status === 'connected' && context.active && context.visible && !autoPaused) void refresh(false);
  }
  function disconnect() {
    clearCredentials(); autoPaused = false;
    setState({ status: clientId ? 'disconnected' : 'unconfigured', busy: false, data: null, error: null, stale: false });
  }
  return {
    prepare, connect, refresh, setContext, disconnect,
    getState: () => snapshot(state),
    dispose() { if (!disposed) { clearCredentials(); disposed = true; oauth = null; state = { ...state, data: null, busy: false }; } },
  };
}
