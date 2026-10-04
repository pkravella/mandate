import { describe, expect, it } from "vitest";
import { appJwt, requestShape } from "./githubApp.js";

describe("requestShape", () => {
  it("fills path placeholders and URL-encodes them", () => {
    const r = requestShape("GET /repos/{owner}/{repo}/pulls", { owner: "ac me", repo: "api" });
    expect(r.method).toBe("GET");
    expect(r.path.startsWith("/repos/ac%20me/api/pulls")).toBe(true);
  });

  // A GET has no body, so leftover params were being put in one and then
  // dropped -- `state` and `per_page` silently vanished and the call returned
  // defaults with no error.
  it("puts leftover GET params in the query string, not a body", () => {
    const r = requestShape("GET /repos/{owner}/{repo}/pulls", {
      owner: "acme", repo: "api", state: "closed", per_page: 100,
    });
    expect(r.path).toBe("/repos/acme/api/pulls?state=closed&per_page=100");
    expect(r.body).toBeUndefined();
  });

  it("does the same for DELETE, which also has no body", () => {
    const r = requestShape("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: "acme", repo: "api", ref: "heads/x", force: true,
    });
    expect(r.path).toBe("/repos/acme/api/git/refs/heads%2Fx?force=true");
    expect(r.body).toBeUndefined();
  });

  it("keeps leftover params as a JSON body on a POST", () => {
    const r = requestShape("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: 42, repositories: ["api"], permissions: { contents: "write" },
    });
    expect(r.path).toBe("/app/installations/42/access_tokens");
    expect(r.body).toEqual({ repositories: ["api"], permissions: { contents: "write" } });
  });

  it("omits the query string when a GET has nothing left over", () => {
    expect(requestShape("GET /app", {}).path).toBe("/app");
  });

  it("skips an undefined param rather than sending the string undefined", () => {
    const r = requestShape("GET /repos/{owner}/{repo}/pulls", {
      owner: "acme", repo: "api", state: undefined,
    });
    expect(r.path).toBe("/repos/acme/api/pulls");
  });
});

describe("appJwt", () => {
  // Generated rather than read from disk: a test must not need a real key.
  const key = `-----BEGIN PRIVATE KEY-----\n`;

  it("refuses to sign with something that is not a key", () => {
    expect(() => appJwt("123", key)).toThrow();
  });

  it("produces three dot-separated segments with the app id as issuer", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwt = appJwt("5182699", privateKey);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as
      { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe("5182699");
    // Backdated, because GitHub rejects a token issued in its future.
    expect(payload.iat).toBeLessThan(Math.floor(Date.now() / 1000));
    // Inside GitHub's ten-minute ceiling.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });
});
