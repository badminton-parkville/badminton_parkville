-- D1 (SQLite) schema. Apply with:
--   npx wrangler d1 execute badminton --local  --file=schema.sql   (local dev)
--   npx wrangler d1 execute badminton --remote --file=schema.sql   (production)

CREATE TABLE IF NOT EXISTS people (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,          -- lower-cased
  name            TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',      -- organiser-only notes
  priority_adjust REAL NOT NULL DEFAULT 0,       -- manual organiser bump (+/-)
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  location         TEXT NOT NULL DEFAULT '',
  starts_at        TEXT NOT NULL,                -- ISO-8601 UTC
  ends_at          TEXT NOT NULL,
  opens_at         TEXT NOT NULL,                -- registration opens
  dropout_deadline TEXT NOT NULL,                -- free drop-out allowed until
  capacity         INTEGER NOT NULL,
  fee              TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',     -- shown publicly
  finalised_at     TEXT,                         -- organiser confirmed the list
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id            INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  registered_at        TEXT NOT NULL,            -- server timestamp, FCFS tiebreak
  token                TEXT NOT NULL UNIQUE,     -- registrant's private manage token
  admin_added          INTEGER NOT NULL DEFAULT 0,
  withdrawn_at         TEXT,
  withdraw_kind        TEXT,                     -- 'normal' | 'reason' | 'admin'
  withdraw_reason      TEXT,
  selected             INTEGER NOT NULL DEFAULT 0, -- ticked into the playing list
  attended             INTEGER,                  -- NULL unknown, 1 yes, 0 no-show
  invalid              INTEGER NOT NULL DEFAULT 0, -- organiser-flagged invalid dropout/no-show
  note                 TEXT NOT NULL DEFAULT '',
  invited_at           TEXT,
  payment_requested_at TEXT,
  paid_at              TEXT,                     -- organiser marked as paid
  UNIQUE (session_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_reg_session ON registrations(session_id);
CREATE INDEX IF NOT EXISTS idx_reg_person  ON registrations(person_id);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
