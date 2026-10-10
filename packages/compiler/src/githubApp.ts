import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GitHubResponse, MintDeps } from "./token.js";

/**
 * App-level authentication, without `@octokit/auth-app`.
 *
 * The plan called for that package. It is not needed here and carries a cost:
 * its value is JWT signing plus installation-token caching, and nothing here
 * caches: a session mints one token and ends before it expires (see
 * `capToCredential`). What is left is twenty lines of RS256 over a two-field
 * payload.
 *
 * It also sidesteps a key-format question. GitHub hands out a PKCS#1 key
 * (`BEGIN RSA PRIVATE KEY`); Node's classic `crypto.createSign` signs it
 * directly, which was verified against the real `GET /app` before this was
 * written. Octokit's JWT path goes through WebCrypto, which wants PKCS#8.
 *
 * The private key is read here and never returned, logged, or put in an error.
 */

const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export interface AppCredentials {
  readonly appId: string | number;
  readonly installationId: number;
  /** The PEM itself, or `privateKeyPath` to read it from disk. */
  readonly privateKey?: string;
  readonly privateKeyPath?: string;
}

/**
 * A short-lived app JWT.
 *
 * `iat` is backdated a minute because GitHub rejects a token issued in its
 * future, and a developer laptop's clock drifts. `exp` is nine minutes, inside
 * GitHub's ten-minute ceiling.
 */
export function appJwt(appId: string | number, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.`
    + `${b64url({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end()
    .sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

const API = "https://api.github.com";

export interface RequestShape {
  readonly method: string;
  readonly path: string;
  /** Absent for a method that carries no body. */
  readonly body?: Record<string, unknown>;
}

/** Methods with no request body, whose leftover params belong in the query. */
const BODYLESS: ReadonlySet<string> = new Set(["GET", "HEAD", "DELETE"]);

/**
 * Splits `"POST /a/{b}/c"`, fills `{placeholders}` from `params`, and puts
 * whatever is left where that method carries it.
 *
 * Leftover params used to go into a body unconditionally, and the body was then
 * correctly dropped for a GET — so `state` and `per_page` on a list call
 * silently vanished and GitHub answered with defaults and no error.
 */
export function requestShape(
  route: string, params: Readonly<Record<string, unknown>>,
): RequestShape {
  const [method = "GET", template = "/"] = route.split(" ");
  const used = new Set<string>();
  const path = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    used.add(key);
    return encodeURIComponent(String(params[key]));
  });

  const leftover = Object.entries(params)
    .filter(([k, v]) => !used.has(k) && v !== undefined);

  if (!BODYLESS.has(method.toUpperCase())) {
    return { method, path, body: Object.fromEntries(leftover) };
  }

  if (leftover.length === 0) return { method, path };
  const query = new URLSearchParams();
  for (const [k, v] of leftover) query.append(k, String(v));
  return { method, path: `${path}?${query.toString()}` };
}

/**
 * A `MintDeps` backed by `fetch`.
 *
 * It does not throw on a 4xx: `mintToken` reads the status and GitHub's own
 * message, which is what a reviewer needs to see when an installation is
 * missing a permission.
 */
export function githubAppDeps(creds: AppCredentials): MintDeps {
  const pem = creds.privateKey
    ?? readFileSync(
      creds.privateKeyPath ?? (() => {
        throw new Error("githubAppDeps needs privateKey or privateKeyPath");
      })(),
      "utf8",
    );

  const call = async (
    route: string, authorization: string, params: Readonly<Record<string, unknown>>,
  ): Promise<GitHubResponse> => {
    const { method, path, body } = requestShape(route, params);
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return { status: 204, data: null };
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body from GitHub is a response we cannot act on; the status
      // still carries the decision, and mintToken fails closed on it.
      data = { message: `non-JSON response (${text.length} bytes)` };
    }
    return { status: response.status, data };
  };

  return {
    installationId: creds.installationId,
    asApp: (route, params) => call(route, `Bearer ${appJwt(creds.appId, pem)}`, params),
    asInstallation: (route, token, params) => call(route, `Bearer ${token}`, params ?? {}),
  };
}
