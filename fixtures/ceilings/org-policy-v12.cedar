// Example organization ceiling. Every mandate must prove it grants nothing
// beyond this.
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
when { resource.repo like "acme/*" };

@id("allow-agent-branch-writes")
permit (
  principal,
  action == Mandate::Action::"contents.write",
  resource
)
when {
  resource.repo like "acme/*" &&
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
  resource.repo like "acme/*" &&
  context has base && context.base == "main"
};

@id("allow-branch-create")
permit (
  principal,
  action == Mandate::Action::"branch.create",
  resource
)
when {
  resource.repo like "acme/*" &&
  context has branch && context.branch like "agent/*"
};
