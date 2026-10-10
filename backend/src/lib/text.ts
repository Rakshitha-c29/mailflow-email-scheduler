const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** One-line plain-text snippet of an email body (HTML or text) for list views. */
export function toPreview(body: string, max = 160): string {
  const text = body
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    // Block-level tags separate words; inline ones (<b>, <a>…) must not add spaces.
    .replace(/<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|blockquote|section|article)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
