import type { Env } from "../env";
import type { GrokSettings } from "../settings";
import { getSettings, normalizeCfCookie } from "../settings";
import { getDynamicHeaders } from "./headers";
import { encodeGrpcWebPayload, parseGrpcWebResponse, type GrpcStatus } from "./grpcWeb";
import { addTokenTag, applyCooldown, recordTokenFailure } from "../repo/tokens";

const ACCEPT_TOS_API = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion";
const SET_BIRTH_API = "https://grok.com/rest/auth/set-birth-date";
const NSFW_MGMT_API = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls";

function normalizeToken(raw: string): string {
  const token = String(raw || "").trim();
  return token.startsWith("sso=") ? token.slice(4).trim() : token;
}

function buildCookie(token: string, cfCookie: string): string {
  const items = [`sso=${token}`, `sso-rw=${token}`];
  if (cfCookie) items.push(cfCookie);
  return items.join(";");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function grpcHeaders(args: {
  settings: GrokSettings;
  pathname: string;
  cookie: string;
  origin: string;
  referer: string;
}): Record<string, string> {
  const headers = getDynamicHeaders(args.settings, args.pathname);
  headers.Cookie = args.cookie;
  headers.Origin = args.origin;
  headers.Referer = args.referer;
  headers.Accept = "*/*";
  headers["Content-Type"] = "application/grpc-web+proto";
  headers["Sec-Fetch-Dest"] = "empty";
  headers["Sec-Fetch-Mode"] = "cors";
  headers["Sec-Fetch-Site"] = "same-origin";
  headers["x-grpc-web"] = "1";
  headers["x-user-agent"] = "connect-es/2.1.1";
  headers["Cache-Control"] = "no-cache";
  headers.Pragma = "no-cache";
  return headers;
}

function isGrpcSuccessful(status: GrpcStatus): boolean {
  return status.code === 0 || status.code === -1;
}

function makeError(message: string, status: number, grpcStatus?: number): Error & {
  status?: number;
  grpcStatus?: number;
} {
  const error = new Error(message) as Error & { status?: number; grpcStatus?: number };
  error.status = status;
  if (typeof grpcStatus === "number") error.grpcStatus = grpcStatus;
  return error;
}

function deriveStatusCode(error: unknown): number {
  const candidate = (error as { status?: unknown } | null)?.status;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : 500;
}

function deriveGrpcStatus(error: unknown): number | null {
  const candidate = (error as { grpcStatus?: unknown } | null)?.grpcStatus;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
}

function randomBirthDate(): string {
  const today = new Date();
  const age = 20 + Math.floor(Math.random() * 29);
  const year = today.getUTCFullYear() - age;
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  const hour = Math.floor(Math.random() * 24);
  const minute = Math.floor(Math.random() * 60);
  const second = Math.floor(Math.random() * 60);
  const millis = Math.floor(Math.random() * 1000);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}Z`;
}

async function ensureGrpcSuccess(response: Response, operation: string): Promise<GrpcStatus> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw makeError(
      `${operation} failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`,
      response.status,
    );
  }

  const parsed = await parseGrpcWebResponse(response);
  if (!isGrpcSuccessful(parsed.status)) {
    throw makeError(
      `${operation} failed: gRPC ${parsed.status.code}${
        parsed.status.message ? ` ${parsed.status.message}` : ""
      }`,
      parsed.status.httpEquiv,
      parsed.status.code,
    );
  }
  return parsed.status;
}

export async function acceptTos(tokenRaw: string, settings: GrokSettings): Promise<GrpcStatus> {
  const token = normalizeToken(tokenRaw);
  const cookie = buildCookie(token, normalizeCfCookie(settings.cf_clearance ?? ""));
  const response = await fetch(ACCEPT_TOS_API, {
    method: "POST",
    headers: grpcHeaders({
      settings,
      pathname: "/auth_mgmt.AuthManagement/SetTosAcceptedVersion",
      cookie,
      origin: "https://accounts.x.ai",
      referer: "https://accounts.x.ai/accept-tos",
    }),
    body: encodeGrpcWebPayload(new Uint8Array([0x10, 0x01])),
  });
  return ensureGrpcSuccess(response, "accept_tos");
}

export async function setBirthDate(tokenRaw: string, settings: GrokSettings): Promise<void> {
  const token = normalizeToken(tokenRaw);
  const cookie = buildCookie(token, normalizeCfCookie(settings.cf_clearance ?? ""));
  const headers = getDynamicHeaders(settings, "/rest/auth/set-birth-date");
  headers.Cookie = cookie;
  headers.Origin = "https://grok.com";
  headers.Referer = "https://grok.com/?_s=home";
  headers["Content-Type"] = "application/json";

  const response = await fetch(SET_BIRTH_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ birthDate: randomBirthDate() }),
  });

  if (response.status !== 200 && response.status !== 204) {
    const text = await response.text().catch(() => "");
    throw makeError(
      `set_birth_date failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`,
      response.status,
    );
  }
}

export async function enableNsfwContent(
  tokenRaw: string,
  settings: GrokSettings,
): Promise<GrpcStatus> {
  const token = normalizeToken(tokenRaw);
  const cookie = buildCookie(token, normalizeCfCookie(settings.cf_clearance ?? ""));
  const response = await fetch(NSFW_MGMT_API, {
    method: "POST",
    headers: grpcHeaders({
      settings,
      pathname: "/auth_mgmt.AuthManagement/UpdateUserFeatureControls",
      cookie,
      origin: "https://grok.com",
      referer: "https://grok.com/?_s=data",
    }),
    body: hexToBytes(
      "00000000200a021001121a0a18616c776179735f73686f775f6e7366775f636f6e74656e74",
    ),
  });
  return ensureGrpcSuccess(response, "enable_nsfw");
}

export interface AccountSettingsRefreshResult {
  token: string;
  success: boolean;
  steps: {
    tos: boolean;
    birth: boolean;
    nsfw: boolean;
  };
  http_status: number;
  grpc_status: number | null;
  error: string;
}

export async function refreshAccountSettingsForToken(args: {
  env: Env;
  token: string;
  settings?: GrokSettings;
}): Promise<AccountSettingsRefreshResult> {
  const token = normalizeToken(args.token);
  const settings = args.settings ?? (await getSettings(args.env)).grok;
  const result: AccountSettingsRefreshResult = {
    token,
    success: false,
    steps: { tos: false, birth: false, nsfw: false },
    http_status: 200,
    grpc_status: null,
    error: "",
  };

  try {
    await acceptTos(token, settings);
    result.steps.tos = true;

    await setBirthDate(token, settings);
    result.steps.birth = true;

    const grpc = await enableNsfwContent(token, settings);
    result.steps.nsfw = true;
    result.grpc_status = grpc.code;
    result.success = true;

    await addTokenTag(args.env.DB, token, "nsfw");
    return result;
  } catch (error) {
    const status = deriveStatusCode(error);
    result.http_status = status;
    result.grpc_status = deriveGrpcStatus(error);
    result.error = error instanceof Error ? error.message : String(error);
    await recordTokenFailure(args.env.DB, token, status, result.error.slice(0, 200));
    await applyCooldown(args.env.DB, token, status);
    return result;
  }
}

export async function refreshAccountSettingsForTokens(args: {
  env: Env;
  tokens: string[];
  concurrency?: number;
  retries?: number;
  settings?: GrokSettings;
}): Promise<{
  results: AccountSettingsRefreshResult[];
  summary: { total: number; success: number; failed: number };
  failed: Array<{ token: string; error: string; http_status: number; grpc_status: number | null }>;
}> {
  const settings = args.settings ?? (await getSettings(args.env)).grok;
  const tokens = [...new Set(args.tokens.map(normalizeToken).filter(Boolean))];
  const concurrency = Math.max(1, Math.min(5, Math.floor(Number(args.concurrency ?? 3) || 3)));
  const retries = Math.max(0, Math.min(3, Math.floor(Number(args.retries ?? 1) || 1)));
  const results: AccountSettingsRefreshResult[] = new Array(tokens.length);

  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tokens.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= tokens.length) break;

        let current: AccountSettingsRefreshResult | null = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
          current = await refreshAccountSettingsForToken({
            env: args.env,
            token: tokens[index]!,
            settings,
          });
          if (current.success || attempt >= retries) break;
        }
        results[index] = current!;
      }
    }),
  );

  const finalResults = results.filter(Boolean);
  const successCount = finalResults.filter((item) => item.success).length;
  return {
    results: finalResults,
    summary: {
      total: finalResults.length,
      success: successCount,
      failed: finalResults.length - successCount,
    },
    failed: finalResults
      .filter((item) => !item.success)
      .map((item) => ({
        token: item.token,
        error: item.error,
        http_status: item.http_status,
        grpc_status: item.grpc_status,
      })),
  };
}
