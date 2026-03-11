import { dbAll, dbFirst, dbRun } from "../db";
import type { Env } from "../env";
import { nowMs } from "../utils/time";
import { sanitizeStatusText, sanitizeTagList, sanitizeTokenText } from "../utils/sanitize";

export type TokenType = "sso" | "ssoSuper";

export interface TokenRow {
  token: string;
  token_type: TokenType;
  created_time: number;
  remaining_queries: number;
  heavy_remaining_queries: number;
  status: string;
  tags: string; // JSON string
  note: string;
  cooldown_until: number | null;
  last_failure_time: number | null;
  last_failure_reason: string | null;
  failed_count: number;
}

const MAX_FAILURES = 3;

function parseTags(tagsJson: string): string[] {
  try {
    const v = JSON.parse(tagsJson) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function tokenRowToInfo(row: TokenRow): {
  token: string;
  token_type: TokenType;
  created_time: number;
  remaining_queries: number;
  heavy_remaining_queries: number;
  status: string;
  raw_status: string;
  tags: string[];
  note: string;
  cooldown_until: number | null;
  last_failure_time: number | null;
  last_failure_reason: string;
  limit_reason: string;
  cooldown_remaining: number;
} {
  const now = nowMs();
  const cooldownRemainingMs =
    row.cooldown_until && row.cooldown_until > now ? row.cooldown_until - now : 0;
  const cooldown_remaining = cooldownRemainingMs ? Math.floor((cooldownRemainingMs + 999) / 1000) : 0;
  const exhausted = row.token_type === "ssoSuper"
    ? row.remaining_queries === 0 || row.heavy_remaining_queries === 0
    : row.remaining_queries === 0;
  const limit_reason = row.status === "disabled"
    ? "disabled"
    : row.status === "expired"
      ? "invalid"
      : cooldownRemainingMs || row.status === "cooling"
        ? "cooldown"
        : exhausted
          ? "exhausted"
          : "";

  const status = (() => {
    if (row.status === "disabled") return "已禁用";
    if (row.status === "expired") return "失效";
    if (cooldownRemainingMs || row.status === "cooling") return "冷却中";
    if (row.token_type === "ssoSuper") {
      if (row.remaining_queries === -1 && row.heavy_remaining_queries === -1) return "未使用";
      if (row.remaining_queries === 0 || row.heavy_remaining_queries === 0) return "额度耗尽";
      return "正常";
    }
    if (row.remaining_queries === -1) return "未使用";
    if (row.remaining_queries === 0) return "额度耗尽";
    return "正常";
  })();

  return {
    token: row.token,
    token_type: row.token_type,
    created_time: row.created_time,
    remaining_queries: row.remaining_queries,
    heavy_remaining_queries: row.heavy_remaining_queries,
    status,
    raw_status: sanitizeStatusText(row.status),
    tags: parseTags(row.tags),
    note: row.note ?? "",
    cooldown_until: row.cooldown_until,
    last_failure_time: row.last_failure_time,
    last_failure_reason: row.last_failure_reason ?? "",
    limit_reason,
    cooldown_remaining,
  };
}

export async function listTokens(db: Env["DB"]): Promise<TokenRow[]> {
  return dbAll<TokenRow>(
    db,
    "SELECT token, token_type, created_time, remaining_queries, heavy_remaining_queries, status, tags, note, cooldown_until, last_failure_time, last_failure_reason, failed_count FROM tokens ORDER BY created_time DESC",
  );
}

export async function addTokens(db: Env["DB"], tokens: string[], token_type: TokenType): Promise<number> {
  const now = nowMs();
  const cleaned = tokens.map((t) => sanitizeTokenText(t)).filter(Boolean);
  if (!cleaned.length) return 0;

  const stmts = cleaned.map((t) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO tokens(token, token_type, created_time, remaining_queries, heavy_remaining_queries, status, failed_count, cooldown_until, last_failure_time, last_failure_reason, tags, note) VALUES(?,?,?,?,?,'active',0,NULL,NULL,NULL,'[]','')",
      )
      .bind(t, token_type, now, -1, -1),
  );
  await db.batch(stmts);
  return cleaned.length;
}

export async function deleteTokens(db: Env["DB"], tokens: string[], token_type: TokenType): Promise<number> {
  const cleaned = tokens.map((t) => sanitizeTokenText(t)).filter(Boolean);
  if (!cleaned.length) return 0;
  const placeholders = cleaned.map(() => "?").join(",");
  const before = await dbFirst<{ c: number }>(
    db,
    `SELECT COUNT(1) as c FROM tokens WHERE token_type = ? AND token IN (${placeholders})`,
    [token_type, ...cleaned],
  );
  await dbRun(db, `DELETE FROM tokens WHERE token_type = ? AND token IN (${placeholders})`, [token_type, ...cleaned]);
  return before?.c ?? 0;
}

export async function updateTokenTags(db: Env["DB"], token: string, token_type: TokenType, tags: string[]): Promise<void> {
  const cleaned = sanitizeTagList(tags);
  await dbRun(db, "UPDATE tokens SET tags = ? WHERE token = ? AND token_type = ?", [
    JSON.stringify(cleaned),
    sanitizeTokenText(token),
    token_type,
  ]);
}

export async function addTokenTag(db: Env["DB"], token: string, tag: string): Promise<void> {
  const normalizedToken = sanitizeTokenText(token);
  const normalizedTag = String(tag || "").trim();
  if (!normalizedTag) return;
  const row = await dbFirst<{ tags: string }>(db, "SELECT tags FROM tokens WHERE token = ?", [normalizedToken]);
  const merged = new Set(parseTags(row?.tags ?? "[]"));
  merged.add(normalizedTag);
  await dbRun(db, "UPDATE tokens SET tags = ? WHERE token = ?", [JSON.stringify([...merged].sort()), normalizedToken]);
}

export async function updateTokenNote(db: Env["DB"], token: string, token_type: TokenType, note: string): Promise<void> {
  await dbRun(db, "UPDATE tokens SET note = ? WHERE token = ? AND token_type = ?", [note.trim(), sanitizeTokenText(token), token_type]);
}

export async function getAllTags(db: Env["DB"]): Promise<string[]> {
  const rows = await dbAll<{ tags: string }>(db, "SELECT tags FROM tokens");
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of parseTags(r.tags)) set.add(t);
  }
  return [...set].sort();
}

export async function selectBestToken(db: Env["DB"], model: string): Promise<{ token: string; token_type: TokenType } | null> {
  const now = nowMs();
  const isHeavy = model === "grok-4-heavy";
  const field = isHeavy ? "heavy_remaining_queries" : "remaining_queries";

  const pick = async (token_type: TokenType): Promise<{ token: string; token_type: TokenType } | null> => {
    const row = await dbFirst<{ token: string }>(
      db,
      `SELECT token FROM tokens
       WHERE token_type = ?
         AND status NOT IN ('expired', 'disabled')
         AND failed_count < ?
         AND (cooldown_until IS NULL OR cooldown_until <= ?)
         AND ${field} != 0
       ORDER BY CASE WHEN ${field} = -1 THEN 0 ELSE 1 END, ${field} DESC, created_time ASC
       LIMIT 1`,
      [token_type, MAX_FAILURES, now],
    );
    return row ? { token: row.token, token_type } : null;
  };

  if (isHeavy) return pick("ssoSuper");

  return (await pick("sso")) ?? (await pick("ssoSuper"));
}

export async function recordTokenFailure(
  db: Env["DB"],
  token: string,
  status: number,
  message: string,
): Promise<void> {
  const normalizedToken = sanitizeTokenText(token);
  const now = nowMs();
  const reason = `${status}: ${message}`;
  await dbRun(
    db,
    "UPDATE tokens SET failed_count = failed_count + 1, last_failure_time = ?, last_failure_reason = ? WHERE token = ?",
    [now, reason, normalizedToken],
  );

  const row = await dbFirst<{ failed_count: number; status: string }>(db, "SELECT failed_count, status FROM tokens WHERE token = ?", [normalizedToken]);
  if (!row || row.status === "disabled") return;
  if (status >= 400 && status < 500 && row.failed_count >= MAX_FAILURES) {
    await dbRun(db, "UPDATE tokens SET status = 'expired' WHERE token = ? AND status != 'disabled'", [normalizedToken]);
  }
}

export async function applyCooldown(db: Env["DB"], token: string, status: number): Promise<void> {
  const normalizedToken = sanitizeTokenText(token);
  const row = await dbFirst<{ status: string; remaining_queries: number }>(
    db,
    "SELECT status, remaining_queries FROM tokens WHERE token = ?",
    [normalizedToken],
  );
  if (row?.status === "disabled") return;

  const now = nowMs();
  let until: number | null = null;
  if (status === 429) {
    const remaining = row?.remaining_queries ?? -1;
    const seconds = remaining > 0 || remaining === -1 ? 3600 : 36000;
    until = now + seconds * 1000;
  } else {
    until = now + 30 * 1000;
  }
  await dbRun(db, "UPDATE tokens SET cooldown_until = ? WHERE token = ?", [until, normalizedToken]);
}

export async function updateTokenLimits(
  db: Env["DB"],
  token: string,
  updates: { remaining_queries?: number; heavy_remaining_queries?: number },
): Promise<void> {
  const normalizedToken = sanitizeTokenText(token);
  const parts: string[] = [];
  const params: unknown[] = [];
  if (typeof updates.remaining_queries === "number") {
    parts.push("remaining_queries = ?");
    params.push(updates.remaining_queries);
  }
  if (typeof updates.heavy_remaining_queries === "number") {
    parts.push("heavy_remaining_queries = ?");
    params.push(updates.heavy_remaining_queries);
  }
  if (!parts.length) return;
  params.push(normalizedToken);
  await dbRun(db, `UPDATE tokens SET ${parts.join(", ")} WHERE token = ?`, params);
}
