# Releasing

Releases are cut by pushing a tag `node-v<version>` that matches `sdks/node/package.json`.
[`publish-npm.yml`](../.github/workflows/publish-npm.yml) then:

1. **package** — installs, typechecks, tests, builds, runs `npm pack`, rehearses
   `npm publish --dry-run`, and keeps the tarball as an artifact.
2. **release** — creates the GitHub Release for the tag and attaches the tarball (a pre-release
   for versions such as `0.2.0-alpha.1`). Anyone can install it from the Release URL:
   `npm install https://github.com/Easy-Ez/gabriel-notion/releases/download/node-v<version>/gabriel-notion-<version>.tgz`.
3. **publish** — only when the repository variable `NPM_PUBLISH` is `true`: publishes the same
   tarball to npm from the `npm` environment. Pre-release versions go to the `next` dist-tag.

## Before tagging

```bash
pnpm leak:check
```

```bash
pnpm typecheck && pnpm test && pnpm build
```

Update `sdks/node/CHANGELOG.md` and the version in `sdks/node/package.json`, commit, then tag and
push the tag.

## npm: Trusted Publishing

The workflow publishes with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers):
GitHub Actions proves its identity to npm with OIDC, no npm token is stored, and public
repositories get provenance automatically. It needs npm ≥ 11.5.1 (installed by the workflow) and
Node ≥ 22.14.0.

npm only lets you configure Trusted Publishing for a package that already exists, so the very
first version is published differently:

1. On npmjs.com, create a granular access token with publish rights only, valid for 7 days.
2. Store it as the repository secret `NPM_TOKEN`, set the repository variable `NPM_PUBLISH` to
   `true`, and create the `npm` environment.
3. Push the tag. The publish job uses the token when the secret is present.
4. On npmjs.com, add a Trusted Publisher to the package: repository `Easy-Ez/gabriel-notion`,
   workflow `publish-npm.yml`, environment `npm`. Publish again within 2 days, or the
   configuration lapses.
5. Delete the `NPM_TOKEN` secret and the token on npmjs.com. From then on the publish job uses
   Trusted Publishing.

Do not run `npm login` on a machine whose `~/.npmrc` holds another account's token for
`registry.npmjs.org`: npm keeps one token per registry host and would replace it.
