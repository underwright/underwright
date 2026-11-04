// Underwright control-plane schema. Local-first: one SQLite file per workspace.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  spec_ref      TEXT,                    -- path/URI to the governing spec artifact
  ac_ids        TEXT NOT NULL DEFAULT '[]',  -- acceptance criterion ids from the spec
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','claimed','in_review','done','blocked')),
  priority      INTEGER NOT NULL DEFAULT 2,
  ownership     TEXT NOT NULL DEFAULT '{}',  -- {"paths": [...globs], "symbols": [...]}
  created_by    TEXT NOT NULL DEFAULT 'human',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claims (
  task_id        TEXT PRIMARY KEY REFERENCES tasks(id),
  agent_id       TEXT NOT NULL,
  lease_expires  TEXT NOT NULL,          -- ISO8601; reclaimable after expiry
  scope          TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id),
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('spec','design','handoff','note','review')),
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('test_run','ci_check','review','coverage','deploy','contract_test','security_scan','smoke_test','mutation')),
  command     TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  output      TEXT NOT NULL DEFAULT '',
  ac_ids      TEXT NOT NULL DEFAULT '[]',  -- which acceptance criteria this proves
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS helpers (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  path        TEXT NOT NULL,             -- file path or module
  symbol      TEXT NOT NULL DEFAULT '',  -- exported symbol name
  kind        TEXT NOT NULL CHECK (kind IN ('util','pattern','config','fixture')),
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (path, symbol)
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id),
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('test','build','deploy','review')),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed')),
  command      TEXT NOT NULL,
  result       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT
);

-- Append-only audit log: every mutation lands here.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Full-text search over artifacts + helpers.
CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
  entity_type, entity_id, title, content,
  tokenize = 'porter unicode61'
);
`;
