const B64_HEAD_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const DECODER = new TextDecoder();

function bytesFromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, "");
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function maybeDecodeGrpcWebText(body: Uint8Array, contentType: string): Uint8Array {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("grpc-web-text")) {
    return bytesFromBase64(DECODER.decode(body));
  }

  const head = DECODER.decode(body.subarray(0, Math.min(body.length, 2048)));
  if (head && B64_HEAD_RE.test(head)) {
    try {
      return bytesFromBase64(DECODER.decode(body));
    } catch {
      return body;
    }
  }
  return body;
}

function parseTrailerBlock(payload: Uint8Array): Record<string, string> {
  const text = DECODER.decode(payload);
  const trailers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes(":")) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = String(rawKey || "").trim().toLowerCase();
    let value = rest.join(":").trim();
    if (!key) continue;
    if (key === "grpc-message") {
      try {
        value = decodeURIComponent(value);
      } catch {
        // ignore malformed grpc-message values
      }
    }
    trailers[key] = value;
  }
  return trailers;
}

function toLowerHeaders(headers?: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = String(value ?? "");
  }
  return out;
}

function toHttpEquiv(code: number): number {
  switch (code) {
    case 0:
    case -1:
      return 200;
    case 16:
      return 401;
    case 7:
      return 403;
    case 8:
      return 429;
    case 4:
      return 504;
    case 14:
      return 503;
    default:
      return 502;
  }
}

export interface GrpcStatus {
  code: number;
  message: string;
  ok: boolean;
  httpEquiv: number;
}

export function encodeGrpcWebPayload(data: Uint8Array | ArrayBuffer): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(5 + bytes.length);
  out[0] = 0x00;
  new DataView(out.buffer).setUint32(1, bytes.length, false);
  out.set(bytes, 5);
  return out;
}

export function parseGrpcWebPayload(
  body: Uint8Array,
  contentType = "",
  headers?: Headers | Record<string, string>,
): { messages: Uint8Array[]; trailers: Record<string, string>; status: GrpcStatus } {
  const decoded = maybeDecodeGrpcWebText(body, contentType);
  const messages: Uint8Array[] = [];
  const trailers: Record<string, string> = {};

  let offset = 0;
  while (offset + 5 <= decoded.length) {
    const flag = decoded[offset] ?? 0;
    const length = new DataView(
      decoded.buffer,
      decoded.byteOffset + offset + 1,
      4,
    ).getUint32(0, false);
    offset += 5;
    if (offset + length > decoded.length) break;
    const payload = decoded.slice(offset, offset + length);
    offset += length;

    if ((flag & 0x80) === 0x80) {
      Object.assign(trailers, parseTrailerBlock(payload));
      continue;
    }
    if ((flag & 0x01) === 0x01) {
      throw new Error("Compressed grpc-web frames are not supported");
    }
    messages.push(payload);
  }

  const lowerHeaders = toLowerHeaders(headers);
  if (!trailers["grpc-status"] && lowerHeaders["grpc-status"]) {
    trailers["grpc-status"] = lowerHeaders["grpc-status"];
  }
  if (!trailers["grpc-message"] && lowerHeaders["grpc-message"]) {
    trailers["grpc-message"] = lowerHeaders["grpc-message"];
  }

  const rawCode = String(trailers["grpc-status"] ?? "").trim();
  const parsedCode = rawCode ? Number(rawCode) : -1;
  const code = Number.isFinite(parsedCode) ? parsedCode : -1;
  const message = String(trailers["grpc-message"] ?? "").trim();

  return {
    messages,
    trailers,
    status: {
      code,
      message,
      ok: code === 0 || code === -1,
      httpEquiv: toHttpEquiv(code),
    },
  };
}

export async function parseGrpcWebResponse(
  response: Response,
): Promise<{ messages: Uint8Array[]; trailers: Record<string, string>; status: GrpcStatus }> {
  return parseGrpcWebPayload(
    new Uint8Array(await response.arrayBuffer()),
    response.headers.get("content-type") ?? "",
    response.headers,
  );
}
