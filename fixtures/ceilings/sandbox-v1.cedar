// The ceiling used for the live end-to-end run against pkravella/mandate-sandbox.
//
// Identical in shape to org-policy-v12.cedar, with the repository pattern
// pointing at a real owner. Kept separate rather than loosening the example
// one, because the 21 over-grant fixtures are pinned against that file.
//
// Profile rules, all enforced by loadCeiling:
//   1. `permit` only -- deny-by-default already covers everything unstated,
//      and a `forbid` would make containment non-monotone.
//   2. `action ==` exactly one Mandate::Action from the operation catalog.
//   3. `principal` and `resource` unconstrained in the scope; all constraints
//      live in `when` / `unless`.
//   4. `when` is a conjunction of `like` / `==` over resource.repo,
//      context.branch, context.path and context.base, each optional-context
//      access guarded by `context has <attr>`.
//   5. `unless` is a disjunction of the same over context.path only.
//   6. Every policy carries an @id annotation. That id is what a rejection or
//      a runtime pause names as "the clause it hit".

@id("allow-read-any-repo")
permit (
  principal,
  action == Mandate::Action::"repo.read",
  resource
)
when { resource.repo like "pkravella/*" };

@id("allow-agent-branch-writes")
permit (
  principal,
  action == Mandate::Action::"contents.write",
  resource
)
when {
  resource.repo like "pkravella/*" &&
  context has branch && context.branch like "agent/*"
}
unless {
  context has path &&
  (context.path like ".github/workflows/*" || context.path like "*.env*")
};

@id("allow-pr-create-to-main")
permit (
  principal,
  action == Mandate::Action::"pull_request.create",
  resource
)
when {
  resource.repo like "pkravella/*" &&
  context has base && context.base == "main"
};

@id("allow-branch-create")
permit (
  principal,
  action == Mandate::Action::"branch.create",
  resource
)
when {
  resource.repo like "pkravella/*" &&
  context has branch && context.branch like "agent/*"
};

// An agent fixing an issue should be able to read it. Added here and not in
// org-policy-v12.cedar so the over-grant fixtures stay pinned against that file.
@id("allow-issue-read")
permit (
  principal,
  action == Mandate::Action::"issue.read",
  resource
)
when { resource.repo like "pkravella/*" };
