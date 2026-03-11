CREATE TABLE IF NOT EXISTS admin_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('token_refresh', 'token_nsfw')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')) DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT NOT NULL DEFAULT '',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_status_updated ON admin_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_kind_created ON admin_jobs(kind, created_at DESC);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES (
  'video',
  '{"upscale_timing":"complete"}',
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
