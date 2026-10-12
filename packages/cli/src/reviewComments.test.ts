import { describe, expect, it } from "vitest";
import { githubReviewComments } from "./reviewComments.js";

const ENV = { MANDATE_APP_ID: "1", MANDATE_INSTALLATION_ID: "2", MANDATE_APP_KEY_PATH: "/k" };

const fake = (opts: { pages?: number[]; postStatus?: number } = {}) => {
  const calls: { route: string; params?: Record<string, unknown> }[] = [];
  let page = 0;
  const deps = {
    installationId: 2,
    asApp: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      if (route === "GET /app") return { status: 200, data: { slug: "mandate-dev" } };
      return { status: 201, data: { token: "ghs_x" } };
    },
    asInstallation: async (route: string, _t: string, params?: Record<string, unknown>) => {
      calls.push({ route, ...(params === undefined ? {} : { params }) });
      if (route.startsWith("DELETE")) return { status: 204, data: null };
      if (route.startsWith("POST")) {
        return { status: opts.postStatus ?? 201, data: { id: 7, html_url: "https://github.com/acme/api/issues/4#issuecomment-7" } };
      }
      const n = opts.pages?.[page++] ?? 0;
      return {
        status: 200,
        data: Array.from({ length: n }, (_, i) => ({
          id: i, user: { login: "mandate-dev[bot]" }, body: "x", created_at: "2026-10-12T11:00:00Z",
        })),
      };
    },
  };
  return { calls, make: () => deps };
};

const comments = (f: ReturnType<typeof fake>) => githubReviewComments(ENV, () => "pem", f.make as never)!;

describe("githubReviewComments", () => {
  it("is undefined without the App's credentials", () => {
    expect(githubReviewComments({})).toBeUndefined();
  });

  it("names the App's own login from its slug", async () => {
    expect(await comments(fake()).botLogin()).toBe("mandate-dev[bot]");
  });

  it("reads recent comments with a read-only token on the one repository, every page, then revokes", async () => {
    const f = fake({ pages: [100, 2] });
    const cs = await comments(f).since("acme", "api", "2026-10-12T11:00:00.000Z");
    expect(cs).toHaveLength(102);
    expect(f.calls[0]?.params).toMatchObject({
      repositories: ["api"], permissions: { issues: "read", pull_requests: "read" },
    });
    const gets = f.calls.filter((c) => c.route.startsWith("GET /repos"));
    expect(gets.map((c) => c.params?.["page"])).toEqual([1, 2]);
    expect(gets[0]?.params).toMatchObject({ since: "2026-10-12T11:00:00.000Z", per_page: 100 });
    expect(f.calls.at(-1)?.route).toBe("DELETE /installation/token");
  });

  // Posting is the one write: a token for issues and pull requests on the one
  // repository, and nothing else, revoked after.
  it("posts with a token that can write comments and nothing else, then revokes", async () => {
    const f = fake();
    const r = await comments(f).post({ owner: "acme", repo: "api", number: 4 }, "hello");
    expect(r).toEqual({ id: 7, url: "https://github.com/acme/api/issues/4#issuecomment-7" });
    expect(f.calls[0]?.params).toMatchObject({
      repositories: ["api"], permissions: { issues: "write", pull_requests: "write" },
    });
    expect(Object.keys((f.calls[0]?.params?.["permissions"] ?? {}) as object)).toHaveLength(2);
    expect(f.calls.find((c) => c.route.startsWith("POST /repos"))?.params).toMatchObject({
      owner: "acme", repo: "api", issue_number: 4, body: "hello",
    });
    expect(f.calls.at(-1)?.route).toBe("DELETE /installation/token");
  });

  it("throws when the comment was not created, and still revokes", async () => {
    const f = fake({ postStatus: 403 });
    await expect(comments(f).post({ owner: "acme", repo: "api", number: 4 }, "x")).rejects.toThrow(/403/);
    expect(f.calls.at(-1)?.route).toBe("DELETE /installation/token");
  });
});
