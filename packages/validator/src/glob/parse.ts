export type Token =
  | { readonly kind: "lit"; readonly char: string }
  | { readonly kind: "star" }
  | { readonly kind: "globstar" }
  /** `**` immediately followed by `/`: zero or more complete path segments. */
  | { readonly kind: "globstarSlash" };

export class GlobParseError extends Error {
  constructor(message: string, public readonly glob: string) {
    super(`${message} (in ${JSON.stringify(glob)})`);
    this.name = "GlobParseError";
  }
}

const FORBIDDEN = new Set(["?", "[", "]", "{", "}", "!", "(", ")", "|", "+", "@", "\\"]);

/**
 * The restricted glob language: literal characters, `*` (a run of non-`/`),
 * `**` (any run), and `**​/` (zero or more complete segments). Anything else
 * throws, and a throw is a mandate rejection -- "reject on any doubt".
 *
 * `**​/` is a distinct token rather than `**` followed by `/` because the
 * conventional and security-relevant reading of `**​/.env*` includes a
 * repository-root `.env`. Requiring a literal slash there would silently leave
 * the root file outside every deny list that uses this idiom.
 */
export function parseGlob(src: string): Token[] {
  if (src.length === 0) throw new GlobParseError("empty glob", src);
  const out: Token[] = [];
  // By code point, not UTF-16 unit: dfaAccepts reads a value by code point and
  // Cedar's `like` matches by character, so an astral character (an emoji) is
  // one literal. Read by unit it was two lone surrogates nothing could match,
  // and a deny path naming one never denied.
  const chars = [...src];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "*") {
      if (chars[i + 1] === "*") {
        if (chars[i + 2] === "*") throw new GlobParseError("*** is not a valid glob", src);
        if (chars[i + 2] === "/") {
          out.push({ kind: "globstarSlash" });
          i += 2;
        } else {
          out.push({ kind: "globstar" });
          i += 1;
        }
        continue;
      }
      out.push({ kind: "star" });
      continue;
    }
    if (FORBIDDEN.has(c)) {
      throw new GlobParseError(`unsupported metacharacter ${JSON.stringify(c)}`, src);
    }
    out.push({ kind: "lit", char: c });
  }
  return out;
}
