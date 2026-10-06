/** Truncates `text` to a slug of at most `max` characters, on a word boundary. */
export function slug(text, max = 48) {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const at = cut.lastIndexOf("-");
  return at > 0 ? cut.slice(0, at) : cut;
}
