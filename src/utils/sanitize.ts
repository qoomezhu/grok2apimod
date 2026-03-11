export const COPY_CHAR_REPLACEMENTS: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u00a0": " ",
  "\u2007": " ",
  "\u202f": " ",
  "\u200b": "",
  "\u200c": "",
  "\u200d": "",
  "\ufeff": "",
};

const COPY_CHAR_REGEXP = /[\u2010\u2011\u2012\u2013\u2014\u2212\u2018\u2019\u201c\u201d\u00a0\u2007\u202f\u200b\u200c\u200d\ufeff]/g;

export function sanitizeCopiedText(value: unknown, options?: { removeAllSpaces?: boolean; asciiOnly?: boolean }): string {
  let text = String(value ?? "");
  text = text.replace(COPY_CHAR_REGEXP, (ch) => COPY_CHAR_REPLACEMENTS[ch] ?? ch);
  text = options?.removeAllSpaces ? text.replace(/\s+/g, "") : text.trim();
  if (options?.asciiOnly) {
    text = text.replace(/[^\x20-\x7E]/g, "");
  }
  return text;
}

export function sanitizeTokenText(value: unknown): string {
  let token = sanitizeCopiedText(value, { removeAllSpaces: true, asciiOnly: true });
  if (token.startsWith("sso=")) token = token.slice(4).trim();
  return token;
}

export function sanitizeTagList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = sanitizeCopiedText(item, { asciiOnly: false });
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.sort();
}

export function sanitizeStatusText(value: unknown): string {
  const status = sanitizeCopiedText(value, { asciiOnly: true }).toLowerCase();
  if (status === "invalid") return "expired";
  if (["active", "disabled", "expired", "cooling"].includes(status)) return status;
  return "active";
}

export function sanitizeProxyText(value: unknown, removeAllSpaces = false): string {
  return sanitizeCopiedText(value, { removeAllSpaces, asciiOnly: false });
}
