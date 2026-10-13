# Releasing

How a version of the `@leastpilot/*` packages reaches npm, and what to do when
it goes wrong. Releases come from `.github/workflows/release.yml` on a version
tag, authenticated by npm trusted publishing, so no npm token is stored
anywhere.

The eight public packages (`catalog`, `cli`, `compiler`, `proxy`, `replay`,
`schema`, `validator`, `writer`) always ship together, at one version: the CLI
pins its siblings exactly, so one package alone at a new version leaves a CLI
that cannot install. `bench` is private.

npm never lets a version number be reused, even after an unpublish. A bad
release is fixed by the next patch version.

## What the workflow checks before it publishes

1. The tag is on `main`.
2. The tag is `v` plus the version every public package carries
   (`scripts/release-version.mjs`).
3. The gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
4. The pack check (`scripts/pack-check.mjs`): every package packed, the
   tarballs inspected, installed into an empty directory outside the
   checkout, and the installed binary run there. The tarballs it checked are
   the ones published.

Then `scripts/publish.mjs` publishes them dependencies first, with
provenance, skipping any version the registry already has.

## If a release fails part-way

Re-run the failed job. Versions already published are skipped and the rest
are published in order. Never bump only the packages that failed: the CLI at
the new version names its siblings at the same version.

**An auth error (E401, ENEEDAUTH) on the first package** means the OIDC
exchange did not happen, and npm logs why only at verbose level. Check that
the trusted publishers have not expired (step 3 below), that the run used the
`npm` environment, and that the workflow file is still `release.yml`; for the
detail, re-run with `NPM_CONFIG_LOGLEVEL: verbose` set on the publish step.

## One-time setup (done once, before the first release)

After the release workflow is on `main`.

A trusted publisher can only be attached to a package that already exists,
so each package's first version is a placeholder with no code, published by
hand. Every command below is run by the owner, logged in to npm with 2FA.

**1. The `npm` environment.** In the repository's settings, under
Environments, create `npm`. Under deployment branches and tags, allow only
tags matching `v*.*.*`. Adding yourself as a required reviewer makes every
release wait for a click, which is a reasonable last look before an
irreversible step.

**2. The placeholders.** From a checkout of `main`:

```bash
node scripts/placeholders.mjs "$TMPDIR/leastpilot-placeholders"
```

```bash
for d in "$TMPDIR"/leastpilot-placeholders/*; do npm publish "$d" --access public; done
```

Each is a `package.json` and a README saying it is a placeholder.

**3. The trusted publishers.** A new trusted-publisher configuration that has
not published within 2 days expires, so do this within 2 days of pushing the
first tag, or run it again. `npm trust` needs npm 11.15.0 or later, hence the
`npx`:

```bash
for p in catalog cli compiler proxy replay schema validator writer; do npx -y npm@11.21.0 trust github "@leastpilot/$p" --file release.yml --repo pkravella/mandate --env npm --allow-publish --yes; sleep 2; done
```

```bash
npx -y npm@11.21.0 trust list @leastpilot/cli
```

**4. Lock publishing down.** On npmjs.com, for each package, under Settings,
set Publishing access to "Require two-factor authentication and disallow
tokens". Trusted publishing keeps working; a stolen token does not.

**5. Deprecate the placeholders.**

```bash
for p in catalog cli compiler proxy replay schema validator writer; do npm deprecate "@leastpilot/$p@0.0.0" "placeholder with no code; install 0.2.0 or later"; done
```

## Each release

1. On a branch, set every package's `version` (all nine, `bench` included) and
   merge it to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag -a v0.2.0 -m "LeastPilot 0.2.0" <commit on main>
   ```

   ```bash
   git push origin v0.2.0
   ```

3. Approve the `npm` environment if it asks.
4. Check it from a directory with no checkout:

   ```bash
   npm view @leastpilot/cli@0.2.0 dist.attestations
   ```

   ```bash
   npm install @leastpilot/cli@0.2.0 && npm audit signatures
   ```

5. Point the Actions at it. They install from `action-install/`'s lockfile,
   so the new version reaches them only through a pull request that updates
   it. Dependabot proposes one weekly; to do it straight away:

   ```bash
   cd action-install && npm install --package-lock-only --ignore-scripts --save-exact @leastpilot/cli@0.2.0
   ```

   CI's pack job installs from the new lockfile and checks signatures, so a
   bad lock fails the pull request. Until that pull request merges, the
   Action at the release's tagged commit runs the previous CLI. Anyone
   pinning the Action should pin a commit after the update.

The `v0.1.0` tag marks a commit before the rename and was never published.
It stays where it is.
