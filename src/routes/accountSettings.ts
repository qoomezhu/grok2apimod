import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdminAuth } from "../auth";
import { listTokens } from "../repo/tokens";
import { refreshAccountSettingsForTokens } from "../grok/accountSettings";

export const accountSettingsRoutes = new Hono<{ Bindings: Env }>();

const WORKER_MAX_BATCH = 20;

function normalizeToken(raw: unknown): string {
  const token = String(raw ?? "").trim();
  if (!token) return "";
  return token.startsWith("sso=") ? token.slice(4).trim() : token;
}

function uniqueTokens(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const token = normalizeToken(raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

async function resolveTargetTokens(c: any, body: any): Promise<string[]> {
  if (body?.all) {
    const rows = await listTokens(c.env.DB);
    return uniqueTokens(rows.map((row) => row.token));
  }

  const collected: unknown[] = [];
  if (typeof body?.token === "string") collected.push(body.token);
  if (Array.isArray(body?.tokens)) collected.push(...body.tokens);
  return uniqueTokens(collected);
}

async function handleRefresh(c: any): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  const tokens = await resolveTargetTokens(c, body);
  if (!tokens.length) {
    return c.json({ error: "No tokens provided", code: "NO_TOKENS" }, 400);
  }
  if (tokens.length > WORKER_MAX_BATCH) {
    return c.json(
      {
        error: `Cloudflare Workers 单次仅允许刷新 ${WORKER_MAX_BATCH} 个 Token，请分批操作。`,
        code: "BATCH_LIMIT_EXCEEDED",
      },
      400,
    );
  }

  const rawConcurrency = Number(body?.concurrency ?? 3);
  const rawRetries = Number(body?.retries ?? 1);
  const concurrency = Number.isFinite(rawConcurrency)
    ? Math.max(1, Math.min(5, Math.floor(rawConcurrency)))
    : 3;
  const retries = Number.isFinite(rawRetries)
    ? Math.max(0, Math.min(3, Math.floor(rawRetries)))
    : 1;

  const result = await refreshAccountSettingsForTokens({
    env: c.env,
    tokens,
    concurrency,
    retries,
  });
  return c.json({
    status: "success",
    summary: result.summary,
    failed: result.failed,
    results: result.results,
  });
}

accountSettingsRoutes.post(
  "/api/v1/admin/tokens/nsfw/refresh",
  requireAdminAuth,
  handleRefresh,
);
accountSettingsRoutes.post(
  "/api/v1/admin/tokens/nsfw/enable",
  requireAdminAuth,
  handleRefresh,
);
accountSettingsRoutes.post(
  "/api/v1/admin/tokens/account-settings/refresh",
  requireAdminAuth,
  handleRefresh,
);
