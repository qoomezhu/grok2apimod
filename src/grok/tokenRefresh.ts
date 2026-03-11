import type { Env } from "../env";
import { dbFirst } from "../db";
import { getSettings, normalizeCfCookie, type GrokSettings } from "../settings";
import { checkRateLimits } from "./rateLimits";
import { updateTokenLimits } from "../repo/tokens";
import { sanitizeTokenText } from "../utils/sanitize";

export interface TokenRefreshResult {
  token: string;
  success: boolean;
  token_type: "sso" | "ssoSuper";
  remaining_queries: number;
  heavy_remaining_queries: number;
  error: string;
}

function buildCookie(token: string, settings: GrokSettings): string {
  const cf = normalizeCfCookie(settings.cf_clearance ?? "");
  return cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;
}

export async function refreshTokenUsageForToken(args: {
  env: Env;
  token: string;
  settings?: GrokSettings;
}): Promise<TokenRefreshResult> {
  const token = sanitizeTokenText(args.token);
  const settings = args.settings ?? (await getSettings(args.env)).grok;
  const tokenRow = await dbFirst<{ token_type: "sso" | "ssoSuper" }>(
    args.env.DB,
    "SELECT token_type FROM tokens WHERE token = ?",
    [token],
  );
  const tokenType = tokenRow?.token_type ?? "sso";
  const result: TokenRefreshResult = {
    token,
    success: false,
    token_type: tokenType,
    remaining_queries: -1,
    heavy_remaining_queries: -1,
    error: "",
  };

  try {
    const cookie = buildCookie(token, settings);
    const basic = await checkRateLimits(cookie, settings, "grok-4");
    const remaining = Number((basic as any)?.remainingTokens ?? -1);
    if (!Number.isFinite(remaining)) {
      result.error = "remainingTokens missing";
      return result;
    }

    let heavyRemaining = -1;
    if (tokenType === "ssoSuper") {
      const heavy = await checkRateLimits(cookie, settings, "grok-4-heavy");
      const value = Number((heavy as any)?.remainingTokens ?? -1);
      if (Number.isFinite(value)) heavyRemaining = value;
    }

    await updateTokenLimits(args.env.DB, token, {
      remaining_queries: Math.max(-1, Math.floor(remaining)),
      ...(tokenType === "ssoSuper"
        ? { heavy_remaining_queries: Math.max(-1, Math.floor(heavyRemaining)) }
        : {}),
    });

    result.success = true;
    result.remaining_queries = Math.max(-1, Math.floor(remaining));
    result.heavy_remaining_queries = tokenType === "ssoSuper" ? Math.max(-1, Math.floor(heavyRemaining)) : -1;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
