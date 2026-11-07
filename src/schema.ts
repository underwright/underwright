// Underwright control-plane schema. Local-first: one SQLite file per workspace.
// Portable edge DDL used by both backends and applied on existing databases.

/** Artifact kinds. `blocked` is an escalation record, not a dependency edge. */
export const ARTIFACT_KINDS = ["spec", "design", "handoff", "note", "review", "blocked"] as const;

export const ARTIFACT_KIND_SQL = ARTIFACT_KINDS.map((kind) => `'${kind}'`).join(",");

export function isArtifactKind(kind: string): boolean {
  return (ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/** Helper kinds. `executable` helpers carry an entry_point run_helper can invoke. */
export const HELPER_KINDS = ["util", "pattern", "config", "fixture", "executable"] as const;

export const HELPER_KIND_SQL = HELPER_KINDS.map((kind) => `'${kind}'`).join(",");

export function isHelperKind(kind: string): boolean {
  return (HELPER_KINDS as readonly string[]).includes(kind);
}

export const TASK_DEPENDENCIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  blocker_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, blocker_id),
  CHECK (task_id <> blocker_id)
);
CREATE INDEX IF NOT EXISTS task_dependencies_blocker ON task_dependencies(blocker_id);
`;

export const JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id),
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('test','build','deploy','review','agent')),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed')),
  command      TEXT NOT NULL,
  host         TEXT,
  target_agent_id TEXT,
  runner_id    TEXT,
  lease_token  TEXT,
  lease_expires TEXT,
  agent_spec   TEXT,
  result       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT
);
`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  spec_ref      TEXT,                    -- path/URI to the governing spec artifact
  ac_ids        TEXT NOT NULL DEFAULT '[]',  -- acceptance criterion ids from the spec
  type          TEXT NOT NULL DEFAULT 'feature',  -- drives Definition-of-Done rules
  severity      TEXT NOT NULL DEFAULT 'normal',   -- low|normal|high|critical
  estimate      TEXT NOT NULL DEFAULT '',          -- S|M|L (agent-sessions); empty = unestimated
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','claimed','in_review','done','blocked')),
  priority      INTEGER NOT NULL DEFAULT 2,
  ownership     TEXT NOT NULL DEFAULT '{}',  -- {"paths": [...globs], "symbols": [...]}
  created_by    TEXT NOT NULL DEFAULT 'human',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

${TASK_DEPENDENCIES_SCHEMA}

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
  kind        TEXT NOT NULL CHECK (kind IN (${ARTIFACT_KIND_SQL})),
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
  kind        TEXT NOT NULL CHECK (kind IN (${HELPER_KIND_SQL})),
  summary     TEXT NOT NULL,
  entry_point TEXT NOT NULL DEFAULT '',  -- executable only: command template run_helper renders
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (path, symbol)
);

-- Every run_helper invocation lands here: the metrics behind tools-over-inference.
CREATE TABLE IF NOT EXISTS helper_runs (
  id          TEXT PRIMARY KEY,
  helper_name TEXT NOT NULL,
  helper_id   TEXT,
  task_id     TEXT,
  agent_id    TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('sync','job')),
  status      TEXT NOT NULL,
  command     TEXT NOT NULL DEFAULT '',
  job_id      TEXT,
  exit_code   INTEGER,
  output      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS helper_runs_task ON helper_runs(task_id);
CREATE INDEX IF NOT EXISTS helper_runs_name ON helper_runs(helper_name);

${JOBS_SCHEMA}

CREATE TABLE IF NOT EXISTS locks (
  resource      TEXT PRIMARY KEY,       -- file glob, folder, or entity ref (e.g. "src/db/**", "gh-3")
  agent_id      TEXT NOT NULL,
  task_id       TEXT,
  lease_expires TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_agent    TEXT NOT NULL,
  from_agent  TEXT NOT NULL,
  task_id     TEXT,
  body        TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS watches (
  agent_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, task_id)
);

-- Code index (tree-sitter): symbol definitions + name references, per file.
CREATE TABLE IF NOT EXISTS code_files (
  path        TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,             -- sha256 of content; unchanged hash = skip reparse
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS code_symbols (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  path      TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,               -- function|class|method|interface|type|enum|variable
  line      INTEGER NOT NULL,
  end_line  INTEGER NOT NULL,
  exported  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS code_symbols_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS code_symbols_path ON code_symbols(path);
CREATE TABLE IF NOT EXISTS code_refs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE,
  name       TEXT NOT NULL,              -- referenced identifier
  line       INTEGER NOT NULL,
  container  TEXT NOT NULL DEFAULT ''    -- enclosing symbol name ('' = top level)
);
CREATE INDEX IF NOT EXISTS code_refs_name ON code_refs(name);
CREATE INDEX IF NOT EXISTS code_refs_path ON code_refs(path);

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

// Additive Postgres migration; keep the job shape beside the SQLite source.
export const PG_JOBS_MIGRATION = `
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('test','build','deploy','review','agent'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS host TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_agent_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS runner_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS agent_spec TEXT;
UPDATE jobs SET status='queued' WHERE status='running' AND lease_expires IS NULL;
`;

// Widen artifacts.kind on databases created before the blocked escalation kind.
export const PG_ARTIFACTS_MIGRATION = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'artifacts' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE artifacts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN (${ARTIFACT_KIND_SQL}));
`;

// Executable helpers: widen helpers.kind and add the entry_point column.
export const PG_HELPERS_MIGRATION = `
ALTER TABLE helpers ADD COLUMN IF NOT EXISTS entry_point TEXT NOT NULL DEFAULT '';
ALTER TABLE helpers DROP CONSTRAINT IF EXISTS helpers_kind_check;
ALTER TABLE helpers ADD CONSTRAINT helpers_kind_check CHECK (kind IN (${HELPER_KIND_SQL}));
`;

// Every run_helper invocation lands here: the metrics behind tools-over-inference.
export const PG_HELPER_RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS helper_runs (
  id          TEXT PRIMARY KEY,
  helper_name TEXT NOT NULL,
  helper_id   TEXT,
  task_id     TEXT,
  agent_id    TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('sync','job')),
  status      TEXT NOT NULL,
  command     TEXT NOT NULL DEFAULT '',
  job_id      TEXT,
  exit_code   INT,
  output      TEXT NOT NULL DEFAULT '',
  duration_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helper_runs_task ON helper_runs(task_id);
CREATE INDEX IF NOT EXISTS helper_runs_name ON helper_runs(helper_name);
`;
