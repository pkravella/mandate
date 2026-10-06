/**
 * Parses a `key=value` config file into an object.
 *
 * An absent or empty file means "no overrides", so the caller gets the
 * defaults back. Blank lines and comments are skipped.
 */
export function parseConfig(text, defaults = {}) {
  const out = { ...defaults };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}
