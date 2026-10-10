# Writing an org ceiling

The ceiling is the outer bound on every mandate in your organization. A mandate
is refused unless it is provably a subset of it.

It is authored in Cedar, but in a **deliberately constrained profile** — a
subset the validator can decide by pattern algebra rather than by asking Cedar
one question at a time. This document is the contract for that profile: the six
rules, the error each violation produces, and why each one is there.

`loadCeiling` enforces every rule on load. A ceiling outside the profile does
not load at all, which is the point: a policy nobody can decide is worse than
one that is obviously too permissive, because the first looks safe.

---

## Why a profile, and not just Cedar

Cedar's `isAuthorized` answers a point question: "is *this* request allowed?"
A mandate grant is a **pattern** — `contents.write on acme/api@agent/42-*` with
`deny_paths` — so it denotes a *set* of concrete requests. Asking Cedar once per
grant with a representative resource is unsound: it proves nothing about the
other members of the set. A grant of `branch.create` on `*` would pass a probe
against `agent/42-foo` while also permitting `main`.

So containment is decided by compiling both sides to finite automata and testing
language inclusion, which also yields a **counterexample string** when it fails
— exactly what the permission diff and the pause message need to print.

Cedar keeps two real jobs. It is the **authoring format**, because platform
leads write and review policy and Cedar is a reviewable policy language with
tooling. And it is an **independent cross-check**: boundary witnesses derived
from the grant are replayed through `isAuthorized`, and if Cedar denies a
witness that the automata called contained, that is a validator bug and the
mandate is refused. Two representations that must agree is a stronger guarantee
than either alone.

The profile exists because the translation from Cedar to a glob set has to be
faithful. Everything the profile forbids is something that either cannot be
translated, or could be translated two ways.

---

## The six rules

### 1. `permit` only

```
only `permit` policies are allowed; deny-by-default already covers the rest,
and a `forbid` would make containment non-monotone
```

Anything not permitted is already denied, so a `forbid` adds nothing you cannot
express by narrowing a `permit`. What it *would* add is non-monotonicity:
adding a clause could shrink the permitted set, so "is this grant inside the
union of the permits" would stop being the right question and containment would
no longer compose.

### 2. `action ==` exactly one catalog operation

```
policy <id>: action must be `== Mandate::Action::"<id>"`, not a set or an
unconstrained scope
policy <id>: <action> is not in the operation catalog
```

One action per policy. A set would mean a single clause constrained several
operations whose facets differ, and the catalog check means a typo is a load
error rather than a clause that silently permits nothing.

### 3. `principal` and `resource` unconstrained in the scope

```
policy <id>: principal must be unconstrained in the scope
policy <id>: resource must be unconstrained in the scope
```

All constraints live in `when` / `unless`. Cedar's scope can constrain by entity
type or id, which is a second place a resource limit could hide — and a reader
comparing two clauses would have to check both. One place, consistently.

### 4. `when` is a conjunction of `like` / `==` over four attributes

```
policy <id>: a like comparison outside resource.repo, context.branch,
context.path and context.base
policy <id>: an == comparison outside the profile's attributes and string
literals
```

The four facets are `resource.repo`, `context.branch`, `context.path` and
`context.base` — the same four a mandate grant constrains. Optional context
access is guarded with `context has <attr>`.

A conjunction only, because a disjunction in `when` would denote a union of
pattern sets, and the glob language has no union operator inside a single
pattern — you would write it as two policies, which is clearer anyway.

### 5. `unless` is a disjunction over `context.path` only

```
policy <id>: an unless clause may only constrain context.path
```

`unless` is how a ceiling carves exceptions out: `.github/workflows/*`,
`*.env*`. Restricting it to paths keeps the subtraction on one facet, which is
the only form the containment check can decide — the inner set minus its deny
paths against the outer set minus its deny paths.

### 6. Every policy carries a unique `@id`

```
every policy needs an @id annotation, so a rejection or a pause can name the
clause it hit
duplicate @id "<id>"
```

That id is what a refusal prints and what a runtime pause names. R10 requires
every stop to name the clause it broke; without an id there is nothing to name.

---

## Two more load-time refusals

```
a ceiling with no permits grants nothing
```

A file that parses but contains no `permit` would reject every mandate, which is
technically safe and almost certainly a mistake — an empty file, a wrong path, a
policy that failed to parse upstream. Better to say so.

```
policy <id>: a literal "*" in a like pattern cannot be expressed in the glob
language
policy <id>: an == literal may not contain "*"
```

Our glob language has no escape, so `*` is always a wildcard. A Cedar `\*`
meaning a literal asterisk has no faithful translation, and translating it to a
wildcard would make the extracted ceiling **wider** than what you wrote.

### The one translation worth knowing

**Cedar's `like` wildcard spans `/`; ours does not.** So `like "agent/*"`
translates to the glob `agent/**`, not `agent/*`.

This matters in both directions. Mapping it to `agent/*` would make the
extracted ceiling *narrower* than the policy you wrote, and the Cedar
cross-check cannot detect that — a narrower layer 1 still implies Cedar allows
every witness, so the disagreement is invisible and the result is silent
under-granting.

It also means a ceiling clause written `like "agent/*"` really does permit
`agent/foo/bar/baz`, and a mandate granting `branches: ["agent/**"]` is inside
it. If you want one segment, say so: `like "agent/*"` cannot express that, so
constrain it in the mandate instead.

---

## Destinations are a separate file

```
loadCeiling(id, cedarSource, cedarSchema, destinationsSource)
```

Four arguments, the fourth required. `id` is a label — the CLI passes the
policy file's name — and the ceiling's identity is `sha256`, computed over the
text of all three sources, schema included. Cedar decides
(principal, action, resource) questions and has no destination in its model, so
expressing "where may repository data go" as a policy would mean inventing an
entity for it. It is a plain list beside the ceiling:

```
# The organization's own repositories.
github.com/acme

# The API and git transport hosts the App token is used against. A bare host
# would also cover every subdomain, so these are named exactly.
api.github.com
codeload.github.com
objects.githubusercontent.com
```

**An absent list permits nothing.** The parameter is required rather than
optional precisely because an optional one would quietly invert that for any
caller who forgot — which is how destinations went unchecked until Phase 3.
Point it at an empty file to say "no data may leave" deliberately.

**A bare host covers its subdomains; one with a path does not.** `github.com`
permits `gist.github.com`. `github.com/acme` does not. Verified behaviourally
against squid: with an exact `dstdomain github.com`, `gist.github.com` is
`TCP_DENIED/403`; with `.github.com` it returns 200. One predicate,
`destinationWithin`, decides this for the validator, the proxy's runtime check
and the egress compiler's allowlist, so the three layers cannot disagree about
the same destination.

This is why the example ceiling names `api.github.com` exactly rather than
writing `github.com` once. A bare entry there would hand every mandate an egress
channel to `gist.github.com`.

---

## A worked example

```cedar
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
```

Read it as: agents may read anything in `acme`, and may write anything in `acme`
on a branch under `agent/`, except workflow files and anything that looks like
an env file.

Note what it does **not** say. It does not permit `pull_request.merge`,
`secrets.read`, `workflows.write` or `repo.delete` — so no mandate can grant
them, whatever an injected issue body asks for. That is the property
`fixtures/adversarial/` exists to hold, and the refusal is
`no-ceiling-rule`: *the ceiling has no permit for X; anything not granted is
denied.*

---

## Checking your ceiling

A ceiling is a security control, so exercise it rather than trusting it:

```bash
# Does it load at all, and does a known-good mandate pass?
node packages/cli/dist/index.js validate mandate.yaml \
  --ceiling my-ceiling.cedar --schema fixtures/ceilings/schema.cedarschema \
  --ceiling-destinations my-ceiling.destinations --as alice --level push
```

Then point the seeded over-grant suite at it. `fixtures/overgrants/` holds 21
mandates that must each be refused — a wildcard repository, a write to the
default branch, an unbounded PR count, a gist exfiltration, a weakened deny
list — and `fixtures/adversarial/` holds 42 more written as attacks. A ceiling
that accepts any of them is too loose, and the counterexample in the output
tells you which clause to narrow.
