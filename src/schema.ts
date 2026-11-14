// Underwright control-plane schema. Local-first: one SQLite file per workspace.
// Portable edge DDL used by both backends and applied on existing databases.

/** Artifact kinds. `blocked` is an escalation record, not a dependency edge. */
export const ARTIFACT_KINDS = ["spec", "design", "handoff", "note", "review", "blocked"] as const;

export const ARTIFACT_KIND_SQL = ARTIFACT_KINDS.map((kind) => `'${kind}'`).join(",");

export function isArtifactKind(kind: string): boolean {
  return (ARTIFACT_KINDS as readonly string[]).includes(kind);
}

export const LEDGER_STATUSES = ["started", "progress", "blocked", "done", "cancelled"] as const;

/** Append-only per-task progress ledger (gh-112). operation_id is the
 *  idempotency key: retrying the same operation_id + payload returns the
 *  prior row; reusing it with a different payload is an error. Portable DDL —
 *  shared by SQLite and Postgres. */
export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_ledger (
  operation_id TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  agent_id     TEXT NOT NULL,
  job_id       TEXT,
  attempt_id   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('started','progress','blocked','done','cancelled')),
  summary      TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS task_ledger_task ON task_ledger(task_id, created_at);
`;

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
  type         TEXT NOT NULL CHECK (type IN ('test','build','deploy','review','agent','node')),
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
  finished_at  TEXT,
  target_node_id TEXT,
  node_spec TEXT,
  attempt_id TEXT,
  session_id TEXT,
  dedupe_key TEXT,
  retry_of TEXT,
  receipt_digest TEXT,
  receipt_status TEXT,
  outcome_reason TEXT,
  result_metadata TEXT
);
`;

export const JOBS_INDEXES = `
CREATE INDEX IF NOT EXISTS jobs_target_node ON jobs(target_node_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe ON jobs(target_node_id, dedupe_key)
  WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL AND target_node_id IS NOT NULL;
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
  review_of     TEXT,                              -- subject task id when type is review
  review_kind   TEXT,                              -- code | design; set with review_of
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
  kind        TEXT NOT NULL CHECK (kind IN ('util','pattern','config','fixture')),
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (path, symbol)
);

${JOBS_SCHEMA}

CREATE TABLE IF NOT EXISTS locks (
  resource      TEXT PRIMARY KEY,       -- file glob, folder, or entity ref (e.g. "src/db/**", "gh-3")
  agent_id      TEXT NOT NULL,
  task_id       TEXT,
  lease_expires TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

${LEDGER_SCHEMA}

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
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('test','build','deploy','review','agent','node'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS host TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_agent_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS runner_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS agent_spec TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_node_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS node_spec TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retry_of TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt_digest TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt_status TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS outcome_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_metadata TEXT;
CREATE INDEX IF NOT EXISTS jobs_target_node ON jobs(target_node_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe ON jobs(target_node_id, dedupe_key)
  WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL AND target_node_id IS NOT NULL;
UPDATE jobs SET status='queued' WHERE status='running' AND lease_expires IS NULL AND type <> 'node';
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

/** Portable additive node enrollment schema. ISO timestamps sort consistently on both stores. */
export const NODES_SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('approved','revoked','draining')),
  policy_json TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT,
  session_epoch TEXT, session_expires_at TEXT, capabilities_json TEXT NOT NULL DEFAULT '{}',
  capabilities_version INTEGER NOT NULL DEFAULT 0, capabilities_observed_at TEXT
);
CREATE TABLE IF NOT EXISTS node_enrollments (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, device_secret_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','redeemed')),
  expires_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
  node_id TEXT REFERENCES nodes(id), redeemed_at TEXT
);
CREATE INDEX IF NOT EXISTS node_enrollments_expiry ON node_enrollments(expires_at);
CREATE TABLE IF NOT EXISTS node_tokens (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), secret_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS node_tokens_node ON node_tokens(node_id);
CREATE TABLE IF NOT EXISTS node_workers (
  secret_hash TEXT PRIMARY KEY, node_id TEXT NOT NULL, token_id TEXT NOT NULL,
  session_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_rate_limits (
  bucket TEXT PRIMARY KEY, window_start TEXT NOT NULL, attempts INTEGER NOT NULL
);
`;
