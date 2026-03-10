import { Hono } from "hono";
import type { Env } from "../env";
import { requireApiAuth, type ApiAuthInfo } from "../auth";
import { getSettings, normalizeCfCookie } from "../settings";
import { createMediaPost, createPost } from "../grok/create";
import { buildConversationPayload, sendConversationRequest } from "../grok/conversation";
import { parseOpenAiFromGrokNdjson } from "../grok/processor";
import { uploadImage } from "../grok/upload";
import { addRequestLog } from "../repo/logs";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import { getApiKeyLimits } from "../repo/apiKeys";
import { localDayString, tryConsumeDailyUsage } from "../repo/apiKeyUsage";
import { nowMs } from "../utils/time";
import { arrayBufferToBase64 } from "../utils/base64";

export const videoRoutes = new Hono<{
  Bindings: Env;
  Variables: { apiAuth: ApiAuthInfo };
}>();

videoRoutes.use("/*", requireApiAuth);

const VIDEO_MODEL_ID = "grok-imagine-1.0-video";
const SIZE_TO_ASPECT: Record<string, string> = {
  "1280x720": "16:9",
  "720x1280": "9:16",
  "1792x1024": "3:2",
  "1024x1792": "2:3",
  "1024x1024": "1:1",
};
const QUALITY_TO_RESOLUTION: Record<string, "SD" | "HD"> = {
  standard: "SD",
  high: "HD",
};

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

function extractVideoUrl(content: string): string {
  const text = String(content || "").trim();
  if (!text) return "";
  const markdownMatch = text.match(/\[video\]\(([^)\s]+)\)/i);
  if (markdownMatch?.[1]) return markdownMatch[1].trim();
  const htmlMatch = text.match(/<source[^>]+src=["']([^"']+)["']/i);
  if (htmlMatch?.[1]) return htmlMatch[1].trim();
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  return urlMatch?.[0]?.trim().replace(/[.,)]$/, "") ?? "";
}

function normalizeModel(raw: unknown): string {
  const model = String(raw ?? VIDEO_MODEL_ID).trim() || VIDEO_MODEL_ID;
  if (model !== VIDEO_MODEL_ID) {
    throw new Error(`The model '${VIDEO_MODEL_ID}' is required for video generation.`);
  }
  return model;
}

function normalizeSize(raw: unknown): { size: string; aspectRatio: string } {
  const size = String(raw ?? "1792x1024").trim() || "1792x1024";
  const aspectRatio = SIZE_TO_ASPECT[size];
  if (!aspectRatio) {
    throw new Error(`size must be one of ${Object.keys(SIZE_TO_ASPECT).join(", ")}`);
  }
  return { size, aspectRatio };
}

function normalizeQuality(raw: unknown): { quality: string; resolution: "SD" | "HD" } {
  const quality = String(raw ?? "standard").trim().toLowerCase() || "standard";
  const resolution = QUALITY_TO_RESOLUTION[quality];
  if (!resolution) {
    throw new Error(`quality must be one of ${Object.keys(QUALITY_TO_RESOLUTION).join(", ")}`);
  }
  return { quality, resolution };
}

function normalizeSeconds(raw: unknown): number {
  const parsed = Number(raw ?? 6);
  const seconds = Number.isFinite(parsed) ? Math.floor(parsed) : 6;
  if (seconds < 6 || seconds > 30) {
    throw new Error("seconds must be between 6 and 30");
  }
  return seconds;
}

function validateReferenceValue(raw: string, param: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:")) {
    return value;
  }
  throw new Error(`${param} must be a URL or data URI`);
}

function parseImageReference(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return parseImageReference(JSON.parse(text));
      } catch {
        return validateReferenceValue(text, "image_reference");
      }
    }
    return validateReferenceValue(text, "image_reference");
  }
  if (typeof raw !== "object") {
    throw new Error("image_reference must be an object with image_url");
  }
  const obj = raw as { image_url?: unknown; file_id?: unknown };
  const imageUrl = typeof obj.image_url === "string" ? obj.image_url.trim() : "";
  const fileId = typeof obj.file_id === "string" ? obj.file_id.trim() : "";
  const hasImage = Boolean(imageUrl);
  const hasFileId = Boolean(fileId);
  if (hasImage === hasFileId) {
    throw new Error("image_reference requires exactly one of image_url or file_id");
  }
  if (hasFileId) {
    throw new Error("image_reference.file_id is not supported; please use image_reference.image_url");
  }
  return validateReferenceValue(imageUrl, "image_reference.image_url");
}

async function fileToDataUri(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) throw new Error("input_reference upload is empty");
  const contentType = String(file.type || "application/octet-stream").trim();
  return `data:${contentType};base64,${arrayBufferToBase64(bytes)}`;
}

async function enforceVideoQuota(c: any, model: string): Promise<Response | null> {
  const apiAuth = c.get("apiAuth") as ApiAuthInfo;
  if (!apiAuth?.key || apiAuth.is_admin) return null;
  const limits = await getApiKeyLimits(c.env.DB, apiAuth.key);
  if (!limits) return null;

  const day = localDayString(nowMs(), Number(c.env.CACHE_RESET_TZ_OFFSET_MINUTES ?? 480));
  const ok = await tryConsumeDailyUsage({
    db: c.env.DB,
    key: apiAuth.key,
    day,
    atMs: nowMs(),
    field: "video_used",
    inc: 1,
    limit: limits.video_limit,
  });
  if (ok) return null;
  return c.json(openAiError(`Daily quota exceeded: ${model}`, "daily_quota_exceeded"), 429);
}

function buildVideoResponse(args: {
  model: string;
  prompt: string;
  size: string;
  seconds: number;
  quality: string;
  url: string;
}): Record<string, unknown> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    id: `video_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "video",
    created_at: ts,
    completed_at: ts,
    status: "completed",
    model: args.model,
    prompt: args.prompt,
    size: args.size,
    seconds: String(args.seconds),
    quality: args.quality,
    url: args.url,
  };
}

async function handleVideoCreate(
  c: any,
  input: {
    prompt: unknown;
    model?: unknown;
    size?: unknown;
    seconds?: unknown;
    quality?: unknown;
    image_reference?: unknown;
    input_reference?: File | null;
  },
): Promise<Response> {
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = (c.get("apiAuth") as ApiAuthInfo)?.name ?? "Unknown";

  let requestedModel = VIDEO_MODEL_ID;
  try {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) return c.json(openAiError("prompt is required", "invalid_request_error"), 400);

    requestedModel = normalizeModel(input.model);
    const { size, aspectRatio } = normalizeSize(input.size);
    const { quality, resolution } = normalizeQuality(input.quality);
    const seconds = normalizeSeconds(input.seconds);

    const quotaResp = await enforceVideoQuota(c, requestedModel);
    if (quotaResp) return quotaResp;

    const settingsBundle = await getSettings(c.env);
    const chosen = await selectBestToken(c.env.DB, requestedModel);
    if (!chosen) {
      await addRequestLog(c.env.DB, {
        ip,
        model: requestedModel,
        duration: Number(((Date.now() - start) / 1000).toFixed(2)),
        status: 503,
        key_name: keyName,
        token_suffix: "",
        error: "NO_AVAILABLE_TOKEN",
      });
      return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);
    }

    const references: string[] = [];
    const imageReference = parseImageReference(input.image_reference);
    if (input.input_reference instanceof File) references.push(await fileToDataUri(input.input_reference));
    if (imageReference) references.push(imageReference);

    const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
    const cookie = cf
      ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
      : `sso-rw=${chosen.token};sso=${chosen.token}`;

    let postId = "";
    if (references.length) {
      const uploaded = await uploadImage(references[0]!, cookie, settingsBundle.grok);
      if (!uploaded.fileUri) throw new Error("Failed to upload image reference");
      const post = await createPost(uploaded.fileUri, cookie, settingsBundle.grok);
      postId = post.postId;
    } else {
      const post = await createMediaPost(
        { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt },
        cookie,
        settingsBundle.grok,
      );
      postId = post.postId;
    }
    if (!postId) throw new Error("Failed to create video post");

    const { payload, referer } = buildConversationPayload({
      requestModel: requestedModel,
      content: prompt,
      imgIds: [],
      imgUris: [],
      postId,
      videoConfig: {
        aspect_ratio: aspectRatio,
        video_length: seconds,
        resolution,
        preset: "custom",
      },
      settings: settingsBundle.grok,
    });

    const upstream = await sendConversationRequest({
      payload,
      cookie,
      settings: settingsBundle.grok,
      ...(referer ? { referer } : {}),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      await recordTokenFailure(c.env.DB, chosen.token, upstream.status, text.slice(0, 200));
      await applyCooldown(c.env.DB, chosen.token, upstream.status);
      await addRequestLog(c.env.DB, {
        ip,
        model: requestedModel,
        duration: Number(((Date.now() - start) / 1000).toFixed(2)),
        status: upstream.status,
        key_name: keyName,
        token_suffix: chosen.token.slice(-6),
        error: text.slice(0, 200),
      });
      return c.json(openAiError(text.slice(0, 200) || `Upstream ${upstream.status}`, "upstream_error"), upstream.status);
    }

    const json = await parseOpenAiFromGrokNdjson(upstream, {
      cookie,
      settings: settingsBundle.grok,
      global: settingsBundle.global,
      origin: new URL(c.req.url).origin,
      requestedModel,
    });
    const content =
      typeof (json as any)?.choices?.[0]?.message?.content === "string"
        ? ((json as any).choices[0].message.content as string)
        : "";
    const videoUrl = extractVideoUrl(content);
    if (!videoUrl) throw new Error("Video generation failed: missing video URL");

    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(((Date.now() - start) / 1000).toFixed(2)),
      status: 200,
      key_name: keyName,
      token_suffix: chosen.token.slice(-6),
      error: "",
    });
    return c.json(
      buildVideoResponse({
        model: requestedModel,
        prompt,
        size,
        seconds,
        quality,
        url: videoUrl,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(((Date.now() - start) / 1000).toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: message,
    });
    return c.json(openAiError(message || "Internal error", "internal_error"), 500);
  }
}

videoRoutes.post("/videos", async (c) => {
  const contentType = String(c.req.header("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json(openAiError("Request body must be a JSON object", "invalid_request_error"), 400);
    }
    const payload = body as Record<string, unknown>;
    return handleVideoCreate(c, {
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      seconds: payload.seconds,
      quality: payload.quality,
      image_reference: payload.image_reference,
      input_reference: null,
    });
  }

  const form = await c.req.formData();
  const inputReference = form.get("input_reference");
  return handleVideoCreate(c, {
    prompt: form.get("prompt"),
    model: form.get("model"),
    size: form.get("size"),
    seconds: form.get("seconds"),
    quality: form.get("quality"),
    image_reference: form.get("image_reference"),
    input_reference: inputReference instanceof File ? inputReference : null,
  });
});
