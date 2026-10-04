## What this changes

<!-- One or two sentences. -->

## Why

<!-- Link the issue, or explain the problem. -->

## If this change were wrong, what could an attacker do?

<!-- Required. "Nothing — this is docs only" is a valid answer. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`)
- [ ] A test fails before this change and passes after it
- [ ] `pnpm -r test && pnpm -r typecheck && pnpm lint` pass locally
- [ ] No new path lets model output reach the compiler without `validate()`
- [ ] Every new decision path ends in a default deny
- [ ] If a catalog operation was added: risk class, GitHub App permission,
      minimum user level and prerequisites are all set
