# gh-aw v0.89.21: the matchers the gh-aw export is tested against

`leastpilot export gh-aw` turns a mandate into gh-aw safe-outputs. Its conformance
test does not trust a description of how gh-aw matches paths and branch names:
it runs gh-aw's own code, copied here unmodified from
[github/gh-aw](https://github.com/github/gh-aw) at tag `v0.89.21` (commit
`c35393777e5604a63721d09512263b1383301d4f`), under gh-aw's MIT licence
([LICENSE](LICENSE)).

| File | Source (actions/setup/js/) | Git blob |
| --- | --- | --- |
| `glob_pattern_helpers.cjs` | `glob_pattern_helpers.cjs`, whole file | `7f8f41db39abc0d1fdecc5a04fda79123fd7f9e1` |
| `normalize_branch_name.cjs` | `normalize_branch_name.cjs`, whole file | `6d20e27dbcbdd01f52fd7c5f5dfd5edb775e9355` |
| `is_allowed_branch.cjs` | `safe_outputs_handlers.cjs` lines 315-334, `isAllowedBranch`, plus a require and an export | `ef2a42e3c1edc8c046219c47923b3d8fceb370a5` (the source file) |

Check a copy with `git hash-object <file>` against the blob, or
`gh api repos/github/gh-aw/contents/actions/setup/js/<file>?ref=v0.89.21 --jq .sha`.

These run only in tests. Moving to a newer gh-aw means re-copying them,
re-reading the handlers they come from, and re-running the conformance test.

`frontmatter-keys.json` lists the property names gh-aw's workflow schema
accepts at each place the export writes, so a test can fail on a key gh-aw
would reject. It is generated, not written: from
`pkg/parser/schemas/main_workflow_schema.json` at the same tag (blob
`bd9981bcf238598b137e783502a09af3f83d5921`), taking for each path the keys of the object form's
`properties`. Regenerate it rather than edit it.
