/** Same-origin cookie session. Only short-lived access tokens enter JS memory. */
export function createPersistentHealthClient({
  fetchImpl = (...args) => fetch(...args),
  locationRef = globalThis.location,
  historyRef = globalThis.history,
} = {}) {
  async function post(path, body = {}) {
    let response;
    try {
      response = await fetchImpl(`/api/health/${path}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Pasti-Request': '1' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
    } catch { throw { code: 'UNAVAILABLE' }; }
    if (response.status === 401 && path === 'session') return null;
    if (!response.ok) throw { code: response.status === 401 ? 'AUTH_REQUIRED' : 'UNAVAILABLE' };
    try { return await response.json(); } catch { throw { code: 'INVALID_RESPONSE' }; }
  }
  return {
    restore: () => post('session'),
    async connect(nutrition = false) {
      const result = await post('start', { nutrition });
      let destination;
      try { destination = new URL(result.url); } catch { throw { code: 'INVALID_RESPONSE' }; }
      if (destination.origin !== 'https://accounts.google.com' || destination.pathname !== '/o/oauth2/v2/auth' || destination.username || destination.password) throw { code: 'INVALID_RESPONSE' };
      locationRef.assign(destination.href);
    },
    disconnect: () => post('disconnect'),
    consumeError() {
      const url = new URL(locationRef.href);
      if (!url.searchParams.has('health_error')) return null;
      const code = url.searchParams.get('health_error');
      url.searchParams.delete('health_error');
      historyRef.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      return ['AUTH_REQUIRED', 'ACCESS_DENIED', 'ACCOUNT_NOT_LINKED', 'ACCOUNT_CHANGED', 'AUTH_CANCELLED', 'AUTH_TIMEOUT', 'OFFLINE_ACCESS_REQUIRED'].includes(code) ? code : 'UNAVAILABLE';
    },
  };
}
