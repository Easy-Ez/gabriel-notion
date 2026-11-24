# Releasing

Releases are cut by pushing a tag `node-v<version>` that matches `sdks/node/package.json`.
[`publish-npm.yml`](../.github/workflows/publish-npm.yml) then:

1. **package** — installs, typechecks, tests, builds, runs `npm pack`, rehearses
   `npm publish --dry-run`, and keeps the tarball as an artifact.
2. **release** — creates the GitHub Release for the tag and attaches the tarball (a pre-release
   for versions such as `0.2.0-alpha.1`). Anyone can install it from the Release URL:
   `npm install https://github.com/Easy-Ez/gabriel-notion/releases/download/node-v<version>/gabriel-notion-<version>.tgz`.
3. **publish** — publishes the same tarball to npm from the `npm` environment with
   [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its
   identity to npm with OIDC, no npm token exists anywhere, and the package gets provenance.
   Pre-release versions go to the `next` dist-tag.

## Before tagging

```bash
pnpm leak:check
```

```bash
pnpm typecheck && pnpm test && pnpm build
```

Update `sdks/node/CHANGELOG.md` and the version in `sdks/node/package.json`, commit, then tag and
push the tag.

## Setup (done once)

* GitHub: the `npm` environment, deployable only from tags `node-v*`.
* npmjs.com, package settings → Trusted Publisher: GitHub Actions, repository
  `Easy-Ez/gabriel-notion`, workflow `publish-npm.yml`, environment `npm`.
* The workflow installs npm ≥ 11.5.1, which Trusted Publishing needs.

`0.1.0` was published by hand, because npm only accepts a Trusted Publisher for a package that
already exists. Do not run `npm login` on a machine whose `~/.npmrc` holds another account's token
for `registry.npmjs.org`: npm keeps one token per registry host and would replace it.
