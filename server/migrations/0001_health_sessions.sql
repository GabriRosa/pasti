-- Credentials and OAuth verifiers are encrypted before entering D1.
CREATE TABLE IF NOT EXISTS health_sessions (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_owner TEXT,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS health_sessions_expiry ON health_sessions(expires_at);
CREATE TABLE IF NOT EXISTS health_oauth_states (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS health_oauth_states_expiry ON health_oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS health_oauth_states_browser ON health_oauth_states(browser_hash);
