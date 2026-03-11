import type { Env } from "../env";
import { dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

export type AdminJobKind = "token_refresh" | "token_nsfw";
export type AdminJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AdminJob {
  id: string;
  kind: AdminJobKind;
  status: AdminJobStatus;
  total: number;
  processed: number;
  success: number;
  failed: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string;
  cancel_requested: boolean;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface AdminJobRow {
  id: string;
  kind: AdminJobKind;
  status: AdminJobStatus;
  total: number;
  processed: number;
  success: number;
  failed: number;
  payload_json: string;
  result_json: string | null;
  error: string;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toJob(row: AdminJobRow | null): AdminJob | null {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    total: row.total,
    processed: row.processed,
    success: row.success,
    failed: row.failed,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    result: parseJson<Record<string, unknown> | null>(row.result_json, null),
    error: row.error ?? "",
    cancel_requested: Boolean(row.cancel_requested),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

export async function createJob(
  db: Env["DB"],
  args: { kind: AdminJobKind; total: number; payload?: Record<string, unknown> },
): Promise<AdminJob> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = nowMs();
  await dbRun(
    db,
    `INSERT INTO admin_jobs(
      id, kind, status, total, processed, success, failed,
      payload_json, result_json, error, cancel_requested,
      created_at, updated_at, started_at, finished_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      args.kind,
      "queued",
      Math.max(0, Math.floor(args.total || 0)),
      0,
      0,
      0,
      JSON.stringify(args.payload ?? {}),
      null,
      "",
      0,
      now,
      now,
      null,
      null,
    ],
  );
  return (await getJob(db, id))!;
}

export async function getJob(db: Env["DB"], id: string): Promise<AdminJob | null> {
  const row = await dbFirst<AdminJobRow>(db, "SELECT * FROM admin_jobs WHERE id = ?", [id]);
  return toJob(row);
}

export async function startJob(db: Env["DB"], id: string): Promise<void> {
  const now = nowMs();
  await dbRun(
    db,
    "UPDATE admin_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
    [now, now, id],
  );
}

export async function updateJobProgress(
  db: Env["DB"],
  id: string,
  args: { processed: number; success: number; failed: number; result?: Record<string, unknown> | null },
): Promise<void> {
  const now = nowMs();
  await dbRun(
    db,
    "UPDATE admin_jobs SET processed = ?, success = ?, failed = ?, result_json = ?, updated_at = ? WHERE id = ?",
    [
      Math.max(0, Math.floor(args.processed || 0)),
      Math.max(0, Math.floor(args.success || 0)),
      Math.max(0, Math.floor(args.failed || 0)),
      JSON.stringify(args.result ?? null),
      now,
      id,
    ],
  );
}

export async function finishJob(db: Env["DB"], id: string, result: Record<string, unknown>): Promise<void> {
  const now = nowMs();
  await dbRun(
    db,
    "UPDATE admin_jobs SET status = 'completed', result_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
    [JSON.stringify(result), now, now, id],
  );
}

export async function failJob(db: Env["DB"], id: string, error: string, result?: Record<string, unknown>): Promise<void> {
  const now = nowMs();
  await dbRun(
    db,
    "UPDATE admin_jobs SET status = 'failed', error = ?, result_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
    [error.slice(0, 500), JSON.stringify(result ?? null), now, now, id],
  );
}

export async function requestCancelJob(db: Env["DB"], id: string): Promise<boolean> {
  const now = nowMs();
  await dbRun(db, "UPDATE admin_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?", [now, id]);
  const row = await getJob(db, id);
  return Boolean(row);
}

export async function cancelJob(db: Env["DB"], id: string, result?: Record<string, unknown>): Promise<void> {
  const now = nowMs();
  await dbRun(
    db,
    "UPDATE admin_jobs SET status = 'cancelled', result_json = ?, updated_at = ?, finished_at = ? WHERE id = ?",
    [JSON.stringify(result ?? null), now, now, id],
  );
}
