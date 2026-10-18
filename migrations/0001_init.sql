-- Rasf events platform: initial schema (Cloudflare D1 / SQLite).
-- Idempotent on purpose: the Worker also runs this file automatically on first use,
-- so `wrangler d1 migrations apply` is optional. Keep statements free of ';' inside strings.
-- Times are stored as Unix epoch milliseconds (INTEGER).

CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('owner','manager')),
  pw_hash     TEXT    NOT NULL,
  pw_salt     TEXT    NOT NULL,
  pw_iter     INTEGER NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON sessions(staff_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Generic throttle log (login attempts, joins, messages).
CREATE TABLE IF NOT EXISTS throttle (
  k  TEXT    NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_throttle_k_at ON throttle(k, at);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('image','logo')),
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind, created_at);

-- File bytes as base64 split into chunks (a D1 row is limited to about 2 MB).
CREATE TABLE IF NOT EXISTS media_chunks (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  data     TEXT    NOT NULL,
  PRIMARY KEY (media_id, idx)
);

CREATE TABLE IF NOT EXISTS competitions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  start_at   INTEGER,
  end_at     INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  text           TEXT    NOT NULL,
  type           TEXT    NOT NULL CHECK (type IN ('choice','truefalse','short','essay')),
  options        TEXT    NOT NULL DEFAULT '[]',
  correct        INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 1,
  duration       INTEGER NOT NULL DEFAULT 20,
  ord            INTEGER NOT NULL DEFAULT 0,
  answered_count INTEGER NOT NULL DEFAULT 0,   -- distinct participants who answered (kept in sync by the API)
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_comp ON questions(competition_id, ord);

CREATE TABLE IF NOT EXISTS screen_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS screens (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  key              TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  group_id         INTEGER REFERENCES screen_groups(id) ON DELETE SET NULL,
  content_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL, -- NULL = show the quiz
  last_seen        INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screens_group ON screens(group_id);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  date           INTEGER,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE SET NULL,
  media_id       INTEGER REFERENCES media(id) ON DELETE SET NULL,
  group_id       INTEGER REFERENCES screen_groups(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL
);

-- Employees (token cookie, no account) and kiosk players (one row per name per screen).
CREATE TABLE IF NOT EXISTS participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT    UNIQUE,
  name       TEXT    NOT NULL,
  via_screen INTEGER NOT NULL DEFAULT 0,
  screen_id  INTEGER REFERENCES screens(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_kiosk ON participants(screen_id, name) WHERE via_screen = 1;

CREATE TABLE IF NOT EXISTS answers (
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  tries          TEXT    NOT NULL DEFAULT '[]',  -- JSON array of submitted values
  n_tries        INTEGER NOT NULL DEFAULT 0,
  correct        INTEGER,                        -- 1 correct, 0 wrong, NULL text answer / not yet
  started_at     INTEGER,
  at             INTEGER,                        -- time of last submission (= time of correct answer)
  PRIMARY KEY (participant_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_comp ON answers(competition_id, participant_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  text           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_participant ON messages(participant_id);

-- Running totals per participant per competition (keeps leaderboard reads cheap).
CREATE TABLE IF NOT EXISTS scores (
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  points          INTEGER NOT NULL DEFAULT 0,
  correct_count   INTEGER NOT NULL DEFAULT 0,
  answered        INTEGER NOT NULL DEFAULT 0,
  last_correct_at INTEGER,
  PRIMARY KEY (participant_id, competition_id)
);
CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores(competition_id, points DESC, last_correct_at);

-- Single-row live state; version increments on every change so polling clients can get 304s.
CREATE TABLE IF NOT EXISTS app_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  version               INTEGER NOT NULL DEFAULT 1,
  active_competition_id INTEGER REFERENCES competitions(id) ON DELETE SET NULL,
  active_question_id    INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  featured_message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  primary_color         TEXT    NOT NULL DEFAULT '#8d6d52',
  accent_color          TEXT    NOT NULL DEFAULT '#c6ab8c',
  background_color      TEXT    NOT NULL DEFAULT '#f3eee7',
  logo_media_id         INTEGER REFERENCES media(id) ON DELETE SET NULL
);
INSERT OR IGNORE INTO app_state (id) VALUES (1);
