/**
 * Read-only probe. No writes, no model, $0.
 *
 * Question: does `fetchUserAuthority` actually work?
 *
 * It maps the API's answer onto `UserLevel`, which is
 * ["none","pull","triage","push","maintain","admin"], by looking for an exact
 * string match and falling back to "none". But
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission` documents its
 * `permission` field as one of admin | write | read | none -- the LEGACY
 * vocabulary. If that is what it returns, then:
 *
 *   "write" is not in UserLevel  ->  falls back to "none"  ->  every grant denied.
 *
 * Fails closed, so not a breach, but it would make the one function that closes
 * "the largest remaining hole in the trust story" reject everything. `role_name`
 * is the field that should carry the fine-grained role (triage, maintain, custom).
 *
 * Also checks that an installation token can call this endpoint at all.
 */
import { githubAppDeps } from "@mandate-dev/compiler";
import { fetchUserAuthority } from "@mandate-dev/validator";

const env = (n) => process.env[n];
const need = ["MANDATE_APP_ID", "MANDATE_INSTALLATION_ID", "MANDATE_APP_KEY_PATH", "MANDATE_TEST_REPO"];
const missing = need.filter((n) => env(n) === undefined);
if (env("MANDATE_PROBE") !== "1" || missing.length > 0) {
  console.error(`refusing to run: need MANDATE_PROBE=1 and ${need.join(", ")}`);
  if (missing.length) console.error(`missing: ${missing.join(", ")}`);
  process.exit(2);
}

const REPO = env("MANDATE_TEST_REPO");
const [OWNER, NAME] = REPO.split("/");
const deps = githubAppDeps({
  appId: env("MANDATE_APP_ID"),
  installationId: Number(env("MANDATE_INSTALLATION_ID")),
  privateKeyPath: env("MANDATE_APP_KEY_PATH"),
});

const tok = await deps.asApp("POST /app/installations/{installation_id}/access_tokens", {
  installation_id: Number(env("MANDATE_INSTALLATION_ID")),
  repositories: [NAME],
  permissions: { metadata: "read" },
});
if (tok.status !== 201) {
  console.error("could not mint a metadata-only token:", tok.status, JSON.stringify(tok.data));
  process.exit(1);
}
const token = String(tok.data.token);

console.log(`\nrepo ${REPO}\n`);
for (const login of [OWNER, "mandate-dev-pkravella[bot]", "nonexistent-user-zzz"]) {
  // ---- 1. the raw response, which is the thing in question ------------
  let raw = "(threw)";
  try {
    const res = await deps.asInstallation(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission", token,
      { owner: OWNER, repo: NAME, username: login },
    );
    const d = res.data ?? {};
    raw = `status=${res.status} permission=${JSON.stringify(d.permission)} `
      + `role_name=${JSON.stringify(d.role_name)}`;
  } catch (e) {
    raw = `threw ${e.status ?? ""} ${String(e.message).slice(0, 80)}`;
  }

  // ---- 2. what fetchUserAuthority makes of it -------------------------
  const octokit = {
    request: (route, params) => deps.asInstallation(route, token, params),
  };
  const got = await fetchUserAuthority(octokit, REPO, login);

  console.log(`${login}`);
  console.log(`  api   ${raw}`);
  console.log(`  maps to -> ${JSON.stringify(got)}`);
  console.log("");
}

console.log("=".repeat(62));
console.log("If `permission` is write/read and role_name carries push/triage,");
console.log("fetchUserAuthority maps a real collaborator to level \"none\" and");
console.log("would reject every mandate once wired in.");
try { await deps.asInstallation("DELETE /installation/token", token); } catch {}
