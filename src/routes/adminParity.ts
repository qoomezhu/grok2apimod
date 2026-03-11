import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdminAuth } from "../auth";
import { getSettings, normalizeImageGenerationMethod, normalizeVideoUpscaleTiming, saveSettings } from "../settings";
import { listTokens, type TokenRow } from "../repo/tokens";
import { sanitizeCopiedText, sanitizeProxyText, sanitizeStatusText, sanitizeTagList, sanitizeTokenText } from "../utils/sanitize";
import { nowMs } from "../utils/time";
import { dbRun } from "../db";
import { createJob, getJob, requestCancelJob, startJob, updateJobProgress, finishJob, failJob, cancelJob } from "../repo/jobs";
import { refreshTokenUsageForToken } from "../grok/tokenRefresh";
import { refreshAccountSettingsForToken } from "../grok/accountSettings";

export const adminParityRoutes = new Hono<{ Bindings: Env }>();

adminParityRoutes.use("/api/v1/admin/*", requireAdminAuth);

const REFRESH_JOB_LIMIT = 100;
const NSFW_JOB_LIMIT = 60;

function toPoolName(tokenType: "sso" | "ssoSuper"): "ssoBasic" | "ssoSuper" {
  return tokenType === "ssoSuper" ? "ssoSuper" : "ssoBasic";
}

function poolToTokenType(pool: unknown): "sso" | "ssoSuper" {
  return String(pool ?? "").trim() === "ssoSuper" ? "ssoSuper" : "sso";
}

function buildConfigResponse(settings: Awaited<ReturnType<typeof getSettings>>): Record<string, unknown> {
  const filterTags = String(settings.grok.filtered_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    app: {
      api_key: settings.grok.api_key ?? "",
      admin_username: settings.global.admin_username ?? "admin",
      app_key: settings.global.admin_password ?? "admin",
      app_url: settings.global.base_url ?? "",
      image_format: settings.global.image_mode ?? "url",
      video_format: "url",
    },
    grok: {
      temporary: Boolean(settings.grok.temporary),
      stream: true,
      thinking: Boolean(settings.grok.show_thinking),
      dynamic_statsig: Boolean(settings.grok.dynamic_statsig),
      filter_tags: filterTags,
      video_poster_preview: Boolean(settings.grok.video_poster_preview),
      timeout: Number(settings.grok.stream_total_timeout ?? 600),
      base_proxy_url: String(settings.grok.proxy_url ?? ""),
      asset_proxy_url: String(settings.grok.cache_proxy_url ?? ""),
      cf_clearance: String(settings.grok.cf_clearance ?? ""),
      max_retry: 3,
      retry_status_codes: Array.isArray(settings.grok.retry_status_codes) ? settings.grok.retry_status_codes : [401, 429, 403],
      image_generation_method: normalizeImageGenerationMethod(settings.grok.image_generation_method),
    },
    token: {
      auto_refresh: Boolean(settings.token.auto_refresh),
      refresh_interval_hours: Number(settings.token.refresh_interval_hours ?? 8),
      fail_threshold: Number(settings.token.fail_threshold ?? 5),
      save_delay_ms: Number(settings.token.save_delay_ms ?? 500),
      reload_interval_sec: Number(settings.token.reload_interval_sec ?? 30),
      nsfw_refresh_concurrency: Number(settings.token.nsfw_refresh_concurrency ?? 3),
      nsfw_refresh_retries: Number(settings.token.nsfw_refresh_retries ?? 1),
    },
    cache: {
      enable_auto_clean: Boolean(settings.cache.enable_auto_clean),
      limit_mb: Number(settings.cache.limit_mb ?? 1024),
      keep_base64_cache: Boolean(settings.cache.keep_base64_cache),
    },
    performance: {
      assets_max_concurrent: Number(settings.performance.assets_max_concurrent ?? 25),
      media_max_concurrent: Number(settings.performance.media_max_concurrent ?? 50),
      usage_max_concurrent: Number(settings.performance.usage_max_concurrent ?? 25),
      assets_delete_batch_size: Number(settings.performance.assets_delete_batch_size ?? 10),
      admin_assets_batch_size: Number(settings.performance.admin_assets_batch_size ?? 10),
    },
    video: {
      upscale_timing: normalizeVideoUpscaleTiming(settings.video.upscale_timing),
    },
    register: { ...settings.register },
  };
}

function parseInteger(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeRetryCodes(value: unknown): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw
    .map((item) => Number(item))
    .filter((num) => Number.isFinite(num) && num >= 100 && num <= 599)
    .map((num) => Math.floor(num));
}

async function saveExtendedConfig(c: any): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ status: "error", error: "Invalid payload" }, 400);
  }

  const appCfg = (body as any).app ?? {};
  const grokCfg = (body as any).grok ?? {};
  const tokenCfg = (body as any).token ?? {};
  const cacheCfg = (body as any).cache ?? {};
  const performanceCfg = (body as any).performance ?? {};
  const videoCfg = (body as any).video ?? {};
  const registerCfg = (body as any).register ?? {};

  await saveSettings(c.env, {
    global_config: {
      admin_username: sanitizeCopiedText(appCfg.admin_username ?? "admin"),
      admin_password: sanitizeCopiedText(appCfg.app_key ?? "admin"),
      base_url: sanitizeProxyText(appCfg.app_url ?? ""),
      image_mode: String(appCfg.image_format ?? "url") === "base64"
        ? "base64"
        : String(appCfg.image_format ?? "url") === "b64_json"
          ? "b64_json"
          : "url",
    },
    grok_config: {
      api_key: sanitizeCopiedText(appCfg.api_key ?? ""),
      proxy_url: sanitizeProxyText(grokCfg.base_proxy_url ?? ""),
      cache_proxy_url: sanitizeProxyText(grokCfg.asset_proxy_url ?? ""),
      cf_clearance: sanitizeProxyText(grokCfg.cf_clearance ?? "", true),
      filtered_tags: Array.isArray(grokCfg.filter_tags)
        ? sanitizeTagList(grokCfg.filter_tags).join(",")
        : sanitizeProxyText(grokCfg.filter_tags ?? ""),
      dynamic_statsig: Boolean(grokCfg.dynamic_statsig),
      show_thinking: Boolean(grokCfg.thinking),
      temporary: Boolean(grokCfg.temporary),
      video_poster_preview: Boolean(grokCfg.video_poster_preview),
      retry_status_codes: normalizeRetryCodes(grokCfg.retry_status_codes),
      stream_total_timeout: parseInteger(grokCfg.timeout, 600, 1, 3600),
      image_generation_method: normalizeImageGenerationMethod(grokCfg.image_generation_method),
    },
    token_config: {
      auto_refresh: Boolean(tokenCfg.auto_refresh),
      refresh_interval_hours: parseInteger(tokenCfg.refresh_interval_hours, 8, 1, 168),
      fail_threshold: parseInteger(tokenCfg.fail_threshold, 5, 1, 20),
      save_delay_ms: parseInteger(tokenCfg.save_delay_ms, 500, 0, 60000),
      reload_interval_sec: parseInteger(tokenCfg.reload_interval_sec, 30, 0, 3600),
      nsfw_refresh_concurrency: parseInteger(tokenCfg.nsfw_refresh_concurrency, 3, 1, 5),
      nsfw_refresh_retries: parseInteger(tokenCfg.nsfw_refresh_retries, 1, 0, 3),
    },
    cache_config: {
      enable_auto_clean: Boolean(cacheCfg.enable_auto_clean),
      limit_mb: parseInteger(cacheCfg.limit_mb, 1024, 1, 10240),
      keep_base64_cache: Boolean(cacheCfg.keep_base64_cache),
    },
    performance_config: {
      assets_max_concurrent: parseInteger(performanceCfg.assets_max_concurrent, 25, 1, 100),
      media_max_concurrent: parseInteger(performanceCfg.media_max_concurrent, 50, 1, 100),
      usage_max_concurrent: parseInteger(performanceCfg.usage_max_concurrent, 25, 1, 100),
      assets_delete_batch_size: parseInteger(performanceCfg.assets_delete_batch_size, 10, 1, 100),
      admin_assets_batch_size: parseInteger(performanceCfg.admin_assets_batch_size, 10, 1, 100),
    },
    video_config: {
      upscale_timing: normalizeVideoUpscaleTiming(videoCfg.upscale_timing),
    },
    register_config: {
      worker_domain: sanitizeProxyText(registerCfg.worker_domain ?? ""),
      email_domain: sanitizeProxyText(registerCfg.email_domain ?? ""),
      admin_password: sanitizeCopiedText(registerCfg.admin_password ?? ""),
      yescaptcha_key: sanitizeCopiedText(registerCfg.yescaptcha_key ?? ""),
      solver_url: sanitizeProxyText(registerCfg.solver_url ?? ""),
      solver_browser_type: sanitizeCopiedText(registerCfg.solver_browser_type ?? "camoufox"),
      solver_threads: parseInteger(registerCfg.solver_threads, 5, 1, 32),
      register_threads: parseInteger(registerCfg.register_threads, 10, 1, 64),
      default_count: parseInteger(registerCfg.default_count, 100, 1, 1000),
      auto_start_solver: Boolean(registerCfg.auto_start_solver),
      solver_debug: Boolean(registerCfg.solver_debug),
      max_errors: parseInteger(registerCfg.max_errors, 0, 0, 10000),
      max_runtime_minutes: parseInteger(registerCfg.max_runtime_minutes, 0, 0, 1440),
    },
  });

  return c.json({ status: "success", message: "配置已更新" });
}

function parseTagsJson(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function buildTokenTableRow(row: TokenRow) {
  const now = nowMs();
  const cooldown = Boolean(row.cooldown_until && row.cooldown_until > now) || row.status === "cooling";
  const exhausted = row.token_type === "ssoSuper"
    ? row.remaining_queries === 0 || row.heavy_remaining_queries === 0
    : row.remaining_queries === 0;
  const tags = parseTagsJson(row.tags);
  let status = "active";
  if (sanitizeStatusText(row.status) === "disabled") status = "disabled";
  else if (sanitizeStatusText(row.status) === "expired") status = "invalid";
  else if (cooldown) status = "cooling";
  else if (exhausted) status = "exhausted";

  return {
    token: row.token,
    pool: toPoolName(row.token_type),
    token_type: row.token_type,
    status,
    raw_status: sanitizeStatusText(row.status),
    quota: row.remaining_queries,
    quota_known: row.remaining_queries >= 0,
    heavy_quota: row.heavy_remaining_queries,
    heavy_quota_known: row.heavy_remaining_queries >= 0,
    note: row.note ?? "",
    tags,
    nsfw_enabled: tags.includes("nsfw"),
    fail_count: row.failed_count ?? 0,
    use_count: 0,
    created_time: row.created_time,
    cooldown_until: row.cooldown_until,
  };
}

function computeTokenStats(rows: ReturnType<typeof buildTokenTableRow>[]) {
  let active = 0;
  let cooling = 0;
  let exhausted = 0;
  let invalid = 0;
  let disabled = 0;
  let nsfw = 0;
  let noNsfw = 0;
  let chatQuota = 0;
  let totalCalls = 0;

  for (const row of rows) {
    if (row.nsfw_enabled) nsfw += 1;
    else noNsfw += 1;

    if (row.status === "disabled") disabled += 1;
    else if (row.status === "invalid") invalid += 1;
    else if (row.status === "cooling") cooling += 1;
    else if (row.status === "exhausted") exhausted += 1;
    else active += 1;

    if (["active", "cooling", "exhausted"].includes(row.status) && row.quota_known && row.quota > 0) {
      chatQuota += row.quota;
    }
    totalCalls += Number(row.use_count || 0);
  }

  return {
    total: rows.length,
    active,
    cooling,
    exhausted,
    invalid,
    disabled,
    nsfw,
    no_nsfw: noNsfw,
    chat_quota: chatQuota,
    image_quota: Math.floor(chatQuota / 2),
    total_calls: totalCalls,
  };
}

function collectBodyTokens(body: any): string[] {
  const values: unknown[] = [];
  if (typeof body?.token === "string") values.push(body.token);
  if (Array.isArray(body?.tokens)) values.push(...body.tokens);
  return [...new Set(values.map((item) => sanitizeTokenText(item)).filter(Boolean))];
}

async function resolveTargetTokens(env: Env, body: any): Promise<string[]> {
  if (body?.all) {
    const rows = await listTokens(env.DB);
    return [...new Set(rows.map((row) => sanitizeTokenText(row.token)).filter(Boolean))];
  }
  return collectBodyTokens(body);
}

async function runAsyncJob(args: {
  env: Env;
  jobId: string;
  kind: "token_refresh" | "token_nsfw";
  tokens: string[];
  options: { concurrency?: number; retries?: number };
}): Promise<void> {
  await startJob(args.env.DB, args.jobId);

  let processed = 0;
  let success = 0;
  let failed = 0;
  const failures: Array<{ token: string; error: string }> = [];
  const settings = await getSettings(args.env);

  try {
    for (const token of args.tokens) {
      const job = await getJob(args.env.DB, args.jobId);
      if (!job) return;
      if (job.cancel_requested) {
        await cancelJob(args.env.DB, args.jobId, {
          summary: { total: args.tokens.length, processed, success, failed },
          failed: failures,
        });
        return;
      }

      if (args.kind === "token_refresh") {
        const result = await refreshTokenUsageForToken({ env: args.env, token, settings: settings.grok });
        if (result.success) success += 1;
        else {
          failed += 1;
          failures.push({ token, error: result.error || "refresh failed" });
        }
      } else {
        let finalResult = await refreshAccountSettingsForToken({ env: args.env, token, settings: settings.grok });
        const retries = Math.max(0, Math.min(3, Math.floor(args.options.retries ?? settings.token.nsfw_refresh_retries ?? 1)));
        let attempt = 0;
        while (!finalResult.success && attempt < retries) {
          attempt += 1;
          finalResult = await refreshAccountSettingsForToken({ env: args.env, token, settings: settings.grok });
        }
        if (finalResult.success) success += 1;
        else {
          failed += 1;
          failures.push({ token, error: finalResult.error || "nsfw refresh failed" });
        }
      }

      processed += 1;
      await updateJobProgress(args.env.DB, args.jobId, {
        processed,
        success,
        failed,
        result: {
          summary: { total: args.tokens.length, processed, success, failed },
          failed: failures.slice(-20),
        },
      });
    }

    await finishJob(args.env.DB, args.jobId, {
      summary: { total: args.tokens.length, processed, success, failed },
      failed: failures,
    });
  } catch (error) {
    await failJob(args.env.DB, args.jobId, error instanceof Error ? error.message : String(error), {
      summary: { total: args.tokens.length, processed, success, failed },
      failed: failures,
    });
  }
}

adminParityRoutes.get("/api/v1/admin/config-extended", async (c) => {
  const settings = await getSettings(c.env);
  return c.json(buildConfigResponse(settings));
});

adminParityRoutes.post("/api/v1/admin/config-extended", saveExtendedConfig);

adminParityRoutes.get("/api/v1/admin/tokens/table", async (c) => {
  const rows = await listTokens(c.env.DB);
  const data = rows.map(buildTokenTableRow);
  return c.json({ success: true, data, stats: computeTokenStats(data) });
});

adminParityRoutes.post("/api/v1/admin/tokens/sync", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, message: "Invalid payload" }, 400);
  }

  const currentRows = await listTokens(c.env.DB);
  const existing = new Map(currentRows.map((row) => [row.token, row]));
  const desiredByType: Record<"sso" | "ssoSuper", Set<string>> = { sso: new Set(), ssoSuper: new Set() };
  const now = nowMs();
  const stmts: D1PreparedStatement[] = [];

  for (const [pool, items] of Object.entries(body as Record<string, unknown>)) {
    const tokenType = poolToTokenType(pool);
    const arr = Array.isArray(items) ? items : [];
    for (const item of arr) {
      const source = typeof item === "string" ? { token: item } : (item as Record<string, unknown>);
      const token = sanitizeTokenText(source.token);
      if (!token) continue;
      desiredByType[tokenType].add(token);
      const prev = existing.get(token);
      const note = sanitizeCopiedText(source.note ?? prev?.note ?? "");
      const status = sanitizeStatusText(source.status ?? prev?.status ?? "active");
      const tags = sanitizeTagList(source.tags ?? parseTagsJson(prev?.tags ?? "[]"));
      const quota = Number.isFinite(Number(source.quota)) ? Math.floor(Number(source.quota)) : prev?.remaining_queries ?? -1;
      const heavyQuota = Number.isFinite(Number(source.heavy_quota)) ? Math.floor(Number(source.heavy_quota)) : prev?.heavy_remaining_queries ?? -1;
      const createdTime = prev?.created_time ?? now;
      const failedCount = prev?.failed_count ?? 0;
      const cooldownUntil = prev?.cooldown_until ?? null;
      const lastFailureTime = prev?.last_failure_time ?? null;
      const lastFailureReason = prev?.last_failure_reason ?? null;

      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO tokens(
            token, token_type, created_time, remaining_queries, heavy_remaining_queries,
            status, failed_count, cooldown_until, last_failure_time, last_failure_reason, tags, note
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(token) DO UPDATE SET
            token_type=excluded.token_type,
            remaining_queries=excluded.remaining_queries,
            heavy_remaining_queries=excluded.heavy_remaining_queries,
            status=excluded.status,
            tags=excluded.tags,
            note=excluded.note`,
        ).bind(
          token,
          tokenType,
          createdTime,
          quota,
          tokenType === "ssoSuper" ? heavyQuota : -1,
          status,
          failedCount,
          cooldownUntil,
          lastFailureTime,
          lastFailureReason,
          JSON.stringify(tags),
          note,
        ),
      );
    }
  }

  for (const tokenType of ["sso", "ssoSuper"] as const) {
    const tokensToKeep = [...desiredByType[tokenType]];
    const existingTokens = currentRows.filter((row) => row.token_type === tokenType).map((row) => row.token);
    const toDelete = existingTokens.filter((token) => !tokensToKeep.includes(token));
    if (!toDelete.length) continue;
    const placeholders = toDelete.map(() => "?").join(",");
    stmts.push(c.env.DB.prepare(`DELETE FROM tokens WHERE token_type = ? AND token IN (${placeholders})`).bind(tokenType, ...toDelete));
  }

  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ success: true, message: "Token 已同步" });
});

adminParityRoutes.post("/api/v1/admin/tokens/status", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, message: "Invalid payload" }, 400);
  }
  const tokens = await resolveTargetTokens(c.env, body);
  const status = sanitizeStatusText((body as any).status);
  if (!["active", "disabled"].includes(status)) {
    return c.json({ success: false, message: "status must be active or disabled" }, 400);
  }
  if (!tokens.length) {
    return c.json({ success: false, message: "No tokens provided" }, 400);
  }
  const placeholders = tokens.map(() => "?").join(",");
  await dbRun(c.env.DB, `UPDATE tokens SET status = ? WHERE token IN (${placeholders})`, [status, ...tokens]);
  return c.json({ success: true, updated: tokens.length, status });
});

adminParityRoutes.post("/api/v1/admin/tokens/refresh/async", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tokens = await resolveTargetTokens(c.env, body);
  if (!tokens.length) return c.json({ status: "error", error: "No tokens provided" }, 400);
  if (tokens.length > REFRESH_JOB_LIMIT) {
    return c.json({ status: "error", error: `Cloudflare Workers 单次最多刷新 ${REFRESH_JOB_LIMIT} 个 Token` }, 400);
  }
  const job = await createJob(c.env.DB, { kind: "token_refresh", total: tokens.length, payload: { tokens } });
  (c as any).executionCtx.waitUntil(runAsyncJob({ env: c.env, jobId: job.id, kind: "token_refresh", tokens, options: {} }));
  return c.json({ status: "success", task_id: job.id, total: tokens.length });
});

adminParityRoutes.post("/api/v1/admin/tokens/nsfw/enable/async", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tokens = await resolveTargetTokens(c.env, body);
  if (!tokens.length) return c.json({ status: "error", error: "No tokens provided" }, 400);
  if (tokens.length > NSFW_JOB_LIMIT) {
    return c.json({ status: "error", error: `Cloudflare Workers 单次最多处理 ${NSFW_JOB_LIMIT} 个 Token 的 NSFW 刷新` }, 400);
  }
  const settings = await getSettings(c.env);
  const concurrency = parseInteger((body as any).concurrency, settings.token.nsfw_refresh_concurrency ?? 3, 1, 5);
  const retries = parseInteger((body as any).retries, settings.token.nsfw_refresh_retries ?? 1, 0, 3);
  const job = await createJob(c.env.DB, { kind: "token_nsfw", total: tokens.length, payload: { tokens, concurrency, retries } });
  (c as any).executionCtx.waitUntil(runAsyncJob({ env: c.env, jobId: job.id, kind: "token_nsfw", tokens, options: { concurrency, retries } }));
  return c.json({ status: "success", task_id: job.id, total: tokens.length });
});

adminParityRoutes.get("/api/v1/admin/jobs/:jobId", async (c) => {
  const job = await getJob(c.env.DB, c.req.param("jobId"));
  if (!job) return c.json({ success: false, message: "Job not found" }, 404);
  return c.json({ success: true, data: job });
});

adminParityRoutes.post("/api/v1/admin/jobs/:jobId/cancel", async (c) => {
  const ok = await requestCancelJob(c.env.DB, c.req.param("jobId"));
  if (!ok) return c.json({ success: false, message: "Job not found" }, 404);
  return c.json({ success: true, message: "Cancel requested" });
});
