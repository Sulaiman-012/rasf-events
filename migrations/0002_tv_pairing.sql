-- Single shared screen link (/tv): a device shows a short code, staff claim it for a screen.
-- Idempotent: the Worker also applies this file on existing databases (src/lib.ts ensureSchema).
-- Keep statements free of ';' inside strings.

CREATE TABLE IF NOT EXISTS screen_pairings (
  token_hash TEXT    PRIMARY KEY,                                   -- sha256 of the device's secret token
  code       TEXT    NOT NULL,                                      -- 4 digits shown on the screen
  screen_id  INTEGER REFERENCES screens(id) ON DELETE CASCADE,      -- NULL until claimed by staff
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairings_code ON screen_pairings(code, expires_at);
CREATE INDEX IF NOT EXISTS idx_pairings_expires ON screen_pairings(expires_at);
