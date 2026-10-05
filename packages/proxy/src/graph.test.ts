import { describe, expect, it } from "vitest";
import { Recorder, TraceParseError, parseJsonl, type ActionNode } from "./graph.js";

const enforced = () => new Recorder({
  mode: "enforced", mandateId: "fix-issue-42", mandateHash: "a".repeat(64),
});

const ok = (text: string) => ({ content: [{ type: "text", text }] });

describe("Recorder, allowed calls", () => {
  it("records an allowed call with its resource, branch, paths and action", () => {
    const r = enforced();
    r.recordCall({
      tool: "create_or_update_file", action: "contents.write",
      args: { owner: "acme", repo: "api", branch: "agent/42-fix", path: "src/a.ts" },
    }).completed(ok("done"));

    const [node] = r.graph().nodes;
    expect(node).toMatchObject({
      seq: 1, tool: "create_or_update_file", action: "contents.write",
      resource: "acme/api", branch: "agent/42-fix", decision: "allow", outcome: "ok",
    });
    expect(node!.paths).toEqual(["src/a.ts"]);
    expect(node!.outputBytes).toBeGreaterThan(0);
    expect(node!.outputDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  it("numbers nodes monotonically from one", () => {
    const r = enforced();
    for (let i = 0; i < 3; i++) {
      r.recordCall({
        tool: "get_file_contents", action: "contents.read",
        args: { owner: "acme", repo: "api", path: `f${i}` },
      }).completed(ok(""));
    }
    expect(r.graph().nodes.map((n) => n.seq)).toEqual([1, 2, 3]);
  });

  it("measures duration", async () => {
    const r = enforced();
    const h = r.recordCall({
      tool: "get_file_contents", action: "contents.read",
      args: { owner: "acme", repo: "api", path: "a" },
    });
    await new Promise((res) => setTimeout(res, 10));
    h.completed(ok(""));
    expect(r.graph().nodes[0]!.durationMs).toBeGreaterThanOrEqual(5);
  });

  // A handle called twice would otherwise write two nodes sharing one seq, and
  // parseJsonl rejects a trace whose seqs are not strictly increasing — so a
  // double call would corrupt the file rather than merely duplicate a row.
  it("writes one node even if the handle is completed twice", () => {
    const r = enforced();
    const h = r.recordCall({ tool: "get_file_contents", action: "contents.read", args: {} });
    h.completed(ok("first"));
    h.completed(ok("second"));
    h.upstreamFailed("late failure");
    // And the discarded completions must not consume sequence numbers: a gap
    // is as fatal to parseJsonl as a repeat.
    r.recordCall({ tool: "get_file_contents", action: "contents.read", args: {} })
      .completed(ok("next"));
    const nodes = r.graph().nodes;
    expect(nodes.map((n) => n.seq)).toEqual([1, 2]);
    expect(nodes[0]!.outcome).toBe("ok");
    expect(() => parseJsonl(r.toJsonl())).not.toThrow();
  });
});

describe("Recorder, outcomes", () => {
  // `isError` is optional on CallToolResult and is `undefined` on success,
  // never `false`. A tool GitHub refused is still a call the mandate allowed,
  // and a ground-truth trace that cannot tell the two apart is not evidence
  // about what the task needed.
  it("records an upstream error result as an allow whose outcome is error", () => {
    const r = enforced();
    r.recordCall({ tool: "issue_write", action: "issue.create", args: { owner: "a", repo: "b" } })
      .completed({ isError: true, content: [{ type: "text", text: "403" }] });
    expect(r.graph().nodes[0]).toMatchObject({ decision: "allow", outcome: "error" });
    expect(r.graph().nodes[0]!.outputBytes).toBeGreaterThan(0);
  });

  // An upstream failure arrives as a thrown McpError, so the result never
  // exists. R8 still requires the call in the trace: the mandate allowed it and
  // its `max` quota was already spent.
  it("records an allowed call that threw upstream, with no digest", () => {
    const r = enforced();
    r.recordCall({ tool: "get_file_contents", action: "contents.read", args: {} })
      .upstreamFailed("upstream exploded");
    const node = r.graph().nodes[0];
    expect(node).toMatchObject({
      decision: "allow", outcome: "upstream-failure", outputBytes: 0,
      reason: "upstream exploded",
    });
    expect(node!.outputDigest).toBeUndefined();
  });

  it("records a denied call with its clause and reason, and no output at all", () => {
    const r = enforced();
    r.recordDenial({
      tool: "merge_pull_request", action: "pull_request.merge",
      args: { owner: "acme", repo: "api", pullNumber: 1 },
      decision: {
        kind: "deny", tool: "merge_pull_request",
        clause: "mandate.grants", reason: "not granted",
      },
    });
    const node = r.graph().nodes[0];
    expect(node).toMatchObject({
      decision: "deny", clause: "mandate.grants", reason: "not granted", outputBytes: 0,
    });
    // sha256("") truncated is e3b0c44298fc, which reads as a real digest of
    // real output. A call that never ran has no digest and no outcome.
    expect(node!.outputDigest).toBeUndefined();
    expect(node!.outcome).toBeUndefined();
  });

  it("records a denial the proxy could not attribute to an operation", () => {
    const r = enforced();
    r.recordDenial({
      tool: "delete_file", args: {},
      decision: {
        kind: "deny", tool: "delete_file", clause: "mandate.grants", reason: "not granted",
      },
    });
    expect(r.graph().nodes[0]!.action).toBeUndefined();
  });
});

describe("Recorder, destinations", () => {
  // The recorder must extract destinations exactly as the enforcer does.
  // Recording a destination the enforcer never checked would make Task 17
  // replay under-grants that the proxy would never have produced.
  it("records destinations from destination-bearing fields, as host/path", () => {
    const r = enforced();
    r.recordCall({
      tool: "fork_repository", action: "repo.fork",
      args: { owner: "acme", repo: "api", url: "https://github.com/acme/api" },
    }).completed(ok(""));
    expect(r.graph().nodes[0]!.destinations).toEqual(["github.com/acme/api"]);
  });

  // The whole field value is a URL, so the only thing deciding this is that
  // `body` is not a destination-bearing field. A URL embedded mid-sentence
  // would pass whatever the field rule did, because the prefix pattern is
  // anchored — a test built that way asserts nothing.
  it("records no destination for a URL that is merely content", () => {
    const r = enforced();
    r.recordCall({
      tool: "issue_write", action: "issue.comment",
      args: { owner: "acme", repo: "api", body: "https://github.com/acme/api" },
    }).completed(ok(""));
    expect(r.graph().nodes[0]!.destinations).toEqual([]);
  });
});

describe("Recorder, output accounting", () => {
  it("digests outputs without storing repository contents", () => {
    const r = enforced();
    const secret = "SECRET_TOKEN_VALUE";
    r.recordCall({
      tool: "get_file_contents", action: "contents.read",
      args: { owner: "acme", repo: "api", path: ".env" },
    }).completed(ok(secret));
    expect(r.toJsonl()).not.toContain(secret);
    expect(r.graph().nodes[0]!.outputBytes).toBeGreaterThan(secret.length);
  });

  // `String.length` is UTF-16 code units. A field named outputBytes that
  // under-reports every non-ASCII response is not an audit record.
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const r = enforced();
    const ascii = enforced();
    r.recordCall({ tool: "t", action: "a", args: {} }).completed(ok("ééé"));
    ascii.recordCall({ tool: "t", action: "a", args: {} }).completed(ok("aaa"));
    expect(r.graph().nodes[0]!.outputBytes).toBe(ascii.graph().nodes[0]!.outputBytes + 3);
  });

  // structuredContent is a sibling of content on CallToolResult, and a tool
  // declaring an outputSchema MUST return it. Digesting only text blocks gives
  // two different results the same digest and reports zero bytes.
  it("digests the whole result, including structuredContent", () => {
    const a = enforced();
    const b = enforced();
    a.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [], structuredContent: { sha: "aaa" } });
    b.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [], structuredContent: { sha: "bbb" } });
    expect(a.graph().nodes[0]!.outputBytes).toBeGreaterThan(0);
    expect(a.graph().nodes[0]!.outputDigest).not.toBe(b.graph().nodes[0]!.outputDigest);
  });

  it("digests non-text content blocks", () => {
    const a = enforced();
    const b = enforced();
    a.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [{ type: "image", data: "AAA", mimeType: "image/png" }] });
    b.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [{ type: "image", data: "BBB", mimeType: "image/png" }] });
    expect(a.graph().nodes[0]!.outputDigest).not.toBe(b.graph().nodes[0]!.outputDigest);
  });

  // Two identical payloads that arrived with different key order must digest
  // the same, or comparing a replay against a ground-truth trace is noise.
  it("digests independently of key order", () => {
    const a = enforced();
    const b = enforced();
    a.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [], structuredContent: { x: 1, y: 2 } });
    b.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [], structuredContent: { y: 2, x: 1 } });
    expect(a.graph().nodes[0]!.outputDigest).toBe(b.graph().nodes[0]!.outputDigest);
  });

  // Content block order is meaningful, unlike mandate arrays.
  it("digests content block order as significant", () => {
    const a = enforced();
    const b = enforced();
    a.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [{ type: "text", text: "1" }, { type: "text", text: "2" }] });
    b.recordCall({ tool: "t", action: "x", args: {} })
      .completed({ content: [{ type: "text", text: "2" }, { type: "text", text: "1" }] });
    expect(a.graph().nodes[0]!.outputDigest).not.toBe(b.graph().nodes[0]!.outputDigest);
  });
});

describe("Recorder.graph", () => {
  it("returns a snapshot, not the live node list", () => {
    const r = enforced();
    r.recordCall({ tool: "t", action: "x", args: {} }).completed(ok(""));
    const first = r.graph();
    r.recordCall({ tool: "t", action: "x", args: {} }).completed(ok(""));
    expect(first.nodes).toHaveLength(1);
    expect(r.graph().nodes).toHaveLength(2);
  });
});

describe("JSONL round trip", () => {
  it("round-trips an enforced trace", () => {
    const r = enforced();
    r.recordCall({
      tool: "get_file_contents", action: "contents.read",
      args: { owner: "acme", repo: "api", path: "a" },
    }).completed(ok("x"));
    const parsed = parseJsonl(r.toJsonl());
    expect(parsed).toEqual(r.graph());
  });

  // D8: ground truth comes from runs with the recorder on and no mandate at
  // all. A format that cannot say so forces an unconstrained run to invent a
  // mandate id, and then nothing can tell ground truth from an enforced run.
  it("round-trips an unconstrained trace with no mandate at all", () => {
    const r = new Recorder({ mode: "unconstrained" });
    r.recordCall({ tool: "merge_pull_request", action: "pull_request.merge", args: {} })
      .completed(ok("merged"));
    const parsed = parseJsonl(r.toJsonl());
    expect(parsed.mode).toBe("unconstrained");
    expect(parsed.mandateId).toBeUndefined();
    expect(parsed.mandateHash).toBeUndefined();
    expect(parsed.nodes).toHaveLength(1);
  });

  it("ends every trace with a newline so it can be appended to", () => {
    const r = enforced();
    r.recordCall({ tool: "t", action: "x", args: {} }).completed(ok(""));
    expect(r.toJsonl().endsWith("\n")).toBe(true);
  });

  it("round-trips a trace with no nodes", () => {
    expect(parseJsonl(enforced().toJsonl()).nodes).toEqual([]);
  });
});

describe("parseJsonl rejects a trace it cannot trust", () => {
  const lines = (...l: unknown[]): string => l.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const header = { type: "header", mode: "enforced", mandateId: "m", mandateHash: "a".repeat(64) };
  const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "node", seq: 1, at: "2026-10-04T00:00:00.000Z", tool: "t", action: "x",
    paths: [], destinations: [], decision: "allow", outcome: "ok",
    outputBytes: 2, outputDigest: "0".repeat(12), durationMs: 1, ...over,
  });

  const bad = (src: string): TraceParseError => {
    try {
      parseJsonl(src);
    } catch (e) {
      if (e instanceof TraceParseError) return e;
      throw e;
    }
    throw new Error("expected parseJsonl to reject");
  };

  it("accepts the fixture the rejection cases are built from", () => {
    expect(parseJsonl(lines(header, node())).nodes).toHaveLength(1);
  });

  it("rejects a trace with no header", () => {
    expect(bad(lines(node())).message).toContain("header");
  });

  it("rejects a second header", () => {
    expect(bad(lines(header, header)).message).toMatch(/line 2/);
  });

  it("names the line of a syntax error", () => {
    expect(bad(`${JSON.stringify(header)}\n{not json\n`).message).toMatch(/line 2/);
  });

  it("rejects an unknown line type instead of ignoring it", () => {
    expect(bad(lines(header, { type: "summary", total: 1 })).message).toMatch(/line 2/);
  });

  it("rejects a node missing a required field", () => {
    const { tool: _t, ...noTool } = node();
    expect(bad(lines(header, noTool)).message).toMatch(/line 2/);
  });

  it("rejects a node with an unrecognized field", () => {
    expect(bad(lines(header, node({ note: "hand edited" }))).message).toMatch(/line 2/);
  });

  // "undefined" is what String(undefined) produces, so a header missing its id
  // would otherwise parse into a trace claiming the mandate called "undefined".
  it("rejects an enforced header with no mandate id", () => {
    const { mandateId: _m, ...noId } = header;
    expect(bad(lines(noId, node())).message).toMatch(/line 1/);
  });

  it("rejects an enforced header with no mandate hash", () => {
    const { mandateHash: _h, ...noHash } = header;
    expect(bad(lines(noHash, node())).message).toMatch(/line 1/);
  });

  it("rejects a header carrying a field the format does not define", () => {
    expect(bad(lines({ ...header, agent: "claude-code" }, node())).message).toMatch(/line 1/);
  });

  it("rejects an enforced header whose hash is not a sha256", () => {
    expect(bad(lines({ ...header, mandateHash: "short" }, node())).message).toMatch(/line 1/);
  });

  it("rejects an unconstrained header that claims a mandate", () => {
    expect(bad(lines({ type: "header", mode: "unconstrained", mandateId: "m" }, node()))
      .message).toMatch(/line 1/);
  });

  it("rejects an unknown mode", () => {
    expect(bad(lines({ type: "header", mode: "advisory" }, node())).message).toMatch(/line 1/);
  });

  it("rejects seq numbers that do not strictly increase", () => {
    expect(bad(lines(header, node({ seq: 1 }), node({ seq: 1 }))).message).toMatch(/seq/);
    expect(bad(lines(header, node({ seq: 2 }), node({ seq: 1 }))).message).toMatch(/seq/);
  });

  it("rejects a trace whose first seq is not one", () => {
    expect(bad(lines(header, node({ seq: 7 }))).message).toMatch(/seq/);
  });

  // Fail closed: a denial with no clause cannot be explained, and R10 requires
  // every pause to name the clause it hit.
  it("rejects a denial carrying no clause", () => {
    expect(bad(lines(header, node({
      decision: "deny", clause: undefined, outcome: undefined,
      outputBytes: 0, outputDigest: undefined,
    }))).message).toMatch(/clause/);
  });

  it("rejects an allow carrying no outcome", () => {
    expect(bad(lines(header, node({ outcome: undefined }))).message).toMatch(/line 2/);
  });

  it("rejects a denial that carries an outcome or a digest", () => {
    expect(bad(lines(header, node({ decision: "deny", clause: "c", reason: "r" })))
      .message).toMatch(/line 2/);
  });

  it("rejects an output digest that is not 12 hex characters", () => {
    expect(bad(lines(header, node({ outputDigest: "ZZZZZZZZZZZZ" }))).message).toMatch(/line 2/);
  });

  it("rejects a negative output size", () => {
    expect(bad(lines(header, node({ outputBytes: -1 }))).message).toMatch(/line 2/);
  });

  it("rejects an unreadable timestamp", () => {
    expect(bad(lines(header, node({ at: "whenever" }))).message).toMatch(/line 2/);
  });

  it("ignores blank lines", () => {
    expect(parseJsonl(`${JSON.stringify(header)}\n\n${JSON.stringify(node())}\n\n`).nodes)
      .toHaveLength(1);
  });

  it("rejects an empty file", () => {
    expect(bad("").message).toContain("header");
  });
});

describe("the recorded node shape", () => {
  // Task 17 rebuilds the enforcer's arguments from these fields, so a facet
  // the recorder drops is a facet the replay scorer cannot check.
  it("carries every facet the argument enforcer reads", () => {
    const r = enforced();
    r.recordCall({
      tool: "create_pull_request", action: "pull_request.create",
      args: {
        owner: "acme", repo: "api", head: "agent/42-fix", base: "main",
        files: [{ path: "a.ts" }, { path: "b.ts" }], url: "https://github.com/acme/api",
      },
    }).completed(ok(""));
    const node: ActionNode = r.graph().nodes[0]!;
    expect(node.resource).toBe("acme/api");
    expect(node.branch).toBe("agent/42-fix");
    expect(node.base).toBe("main");
    expect(node.paths).toEqual(["a.ts", "b.ts"]);
    expect(node.destinations).toEqual(["github.com/acme/api"]);
  });

  // Observed live: the agent's first call is `path: "/"`, how
  // github-mcp-server lists the repository root, and `repoPath` normalizes the
  // slash off — so the recorded path is the empty string. It is logged verbatim
  // because the record must be what the enforcer decided on, not a tidied
  // version of it. The consequence belongs to Task 17: rebuilding `path: ""`
  // into an argument object yields no path at all, because `extractArgs`
  // ignores empty strings, so a replay checks one fewer facet than the run did.
  it("records the repository root as the empty path the enforcer saw", () => {
    const r = enforced();
    r.recordCall({
      tool: "get_file_contents", action: "repo.read",
      args: { owner: "acme", repo: "api", path: "/" },
    }).completed(ok(""));
    expect(r.graph().nodes[0]!.paths).toEqual([""]);
    expect(parseJsonl(r.toJsonl()).nodes[0]!.paths).toEqual([""]);
  });

  it("never stores a raw argument value that is not an enforced facet", () => {
    const r = enforced();
    r.recordDenial({
      tool: "create_or_update_file", action: "contents.write",
      args: { owner: "acme", repo: "api", content: "ghp_SUPERSECRETTOKEN", path: "a.ts" },
      decision: {
        kind: "deny", tool: "create_or_update_file",
        clause: "contents.write.branches", reason: "no branch named",
      },
    });
    expect(r.toJsonl()).not.toContain("ghp_SUPERSECRETTOKEN");
  });
});
