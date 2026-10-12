import { describe, expect, it } from "vitest";
import { findApproval, parseApprovalRef, type ApprovalComment } from "./approval.js";

const D = "a".repeat(64);
const OTHER = "b".repeat(64);
const at = "2026-10-12T10:00:00Z";
const comment = (over: Partial<ApprovalComment>): ApprovalComment => ({
  id: 1, author: "alice", body: `/mandate approve ${D}`, createdAt: at, updatedAt: at, ...over,
});

describe("findApproval", () => {
  it("accepts the requester's unedited comment carrying the exact line", () => {
    const r = findApproval([comment({ id: 7 })], D, "user:alice");
    expect(r).toMatchObject({ ok: true, comment: { id: 7, author: "alice" } });
  });

  it("accepts the line among other lines, and ignores login case", () => {
    const r = findApproval([comment({ author: "Alice", body: `Looks right.\n\n/mandate approve ${D}\n` })], D, "user:alice");
    expect(r.ok).toBe(true);
  });

  it("refuses an approval by anyone but the requester, and says whose it was", () => {
    const r = findApproval([comment({ author: "mallory" })], D, "user:alice");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/mallory.*not the requester/s);
  });

  // An admin can edit anyone's comment. An edited approval could be an
  // approval written by someone other than its author.
  it("refuses an edited comment", () => {
    const r = findApproval([comment({ updatedAt: "2026-10-12T10:05:00Z" })], D, "user:alice");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/edited/);
  });

  it("refuses an approval of a different mandate, and says what changes the digest", () => {
    const r = findApproval([comment({ body: `/mandate approve ${OTHER}` })], D, "user:alice");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/different.*mandate.*ceiling.*requester/s);
  });

  it("does not count a quoted or embedded line", () => {
    for (const body of [`> /mandate approve ${D}`, `please /mandate approve ${D}`, `\`/mandate approve ${D}\``, `/mandate approve ${D} later`]) {
      expect(findApproval([comment({ body })], D, "user:alice").ok, body).toBe(false);
    }
  });

  it("does not take a prefix of the digest", () => {
    expect(findApproval([comment({ body: `/mandate approve ${D.slice(0, 12)}` })], D, "user:alice").ok).toBe(false);
  });

  it("finds one good approval among bad ones", () => {
    const r = findApproval([
      comment({ id: 1, author: "mallory" }),
      comment({ id: 2, updatedAt: "2026-10-12T11:00:00Z" }),
      comment({ id: 3 }),
    ], D, "user:alice");
    expect(r).toMatchObject({ ok: true, comment: { id: 3 } });
  });

  it("refuses when there is no approval at all, naming the line to post", () => {
    const r = findApproval([comment({ body: "lgtm" })], D, "user:alice");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain(`/mandate approve ${D}`);
  });
});

describe("parseApprovalRef", () => {
  it("reads owner/repo#number", () => {
    expect(parseApprovalRef("acme/api#42")).toEqual({ owner: "acme", repo: "api", number: 42 });
  });
  it.each(["acme/api", "acme#4", "acme/api#0", "acme/api#x", "a/b/c#1", "acme/api#4 "])("refuses %s", (s) => {
    expect(parseApprovalRef(s)).toBeUndefined();
  });
});

describe("githubApprovalReader", () => {
  it("is undefined without the App's credentials, so --approval refuses rather than fails late", async () => {
    const { githubApprovalReader } = await import("./approval.js");
    expect(githubApprovalReader({})).toBeUndefined();
    expect(githubApprovalReader({ MANDATE_APP_ID: "1", MANDATE_INSTALLATION_ID: "x", MANDATE_APP_KEY_PATH: "/k" })).toBeUndefined();
    expect(typeof githubApprovalReader({ MANDATE_APP_ID: "1", MANDATE_INSTALLATION_ID: "2", MANDATE_APP_KEY_PATH: "/k" })).toBe("function");
  });
});

describe("githubApprovalReader, against a fake App", () => {
  const ENV = { MANDATE_APP_ID: "1", MANDATE_INSTALLATION_ID: "2", MANDATE_APP_KEY_PATH: "/k" };
  const fake = (pages: number[]) => {
    const calls: { route: string; params?: Record<string, unknown> }[] = [];
    let page = 0;
    const deps = {
      installationId: 2,
      asApp: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return { status: 201, data: { token: "ghs_x" } };
      },
      asInstallation: async (route: string, _t: string, params?: Record<string, unknown>) => {
        calls.push({ route, ...(params === undefined ? {} : { params }) });
        if (route.startsWith("DELETE")) return { status: 204, data: null };
        const n = pages[page++] ?? 0;
        return {
          status: 200,
          data: Array.from({ length: n }, (_, i) => ({
            id: page * 1000 + i, user: { login: "alice" }, body: "x",
            created_at: "t", updated_at: "t",
          })),
        };
      },
    };
    return { calls, make: () => deps };
  };

  // Probed 2026-10-12: an issues: read token is refused (403) reading the
  // comments on a pull request, which needs pull_requests: read.
  it("asks for issues and pull_requests read, on the one repository, and nothing else", async () => {
    const { githubApprovalReader } = await import("./approval.js");
    const f = fake([1]);
    await githubApprovalReader(ENV, () => "pem", f.make as never)!({ owner: "acme", repo: "api", number: 4 });
    expect(f.calls[0]?.params).toMatchObject({
      repositories: ["api"], permissions: { issues: "read", pull_requests: "read" },
    });
    expect(Object.keys((f.calls[0]?.params?.["permissions"] ?? {}) as object)).toHaveLength(2);
  });

  it("reads every page, then revokes the token", async () => {
    const { githubApprovalReader } = await import("./approval.js");
    const f = fake([100, 100, 3]);
    const cs = await githubApprovalReader(ENV, () => "pem", f.make as never)!({ owner: "acme", repo: "api", number: 4 });
    expect(cs).toHaveLength(203);
    expect(f.calls.filter((c) => c.route.startsWith("GET")).map((c) => c.params?.["page"])).toEqual([1, 2, 3]);
    expect(f.calls.at(-1)?.route).toBe("DELETE /installation/token");
  });
});
