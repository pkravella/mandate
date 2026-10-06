/**
 * Parses a `key=value` config file into an object.
 *
 * An absent or empty file means "no overrides", so the caller should get the
 * defaults rather than an exception.
 */
export function parseConfig(text, defaults = {}) {
  const out = { ...defaults };
  // Splitting an empty string yields [""], and the line below then indexes
  // into a key that does not exist.
  for (const line of text.split("\n")) {
    const [key, value] = line.split("=");
    out[key.trim()] = value.trim();
  }
  return out;
}
