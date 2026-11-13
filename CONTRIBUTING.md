# Contributing

## Setup

```sh
npm install
npm test
```

Node ≥ 20 is required.

## Before opening a PR

```sh
npm run typecheck
npm run lint
npm test
npm run coverage   # ≥ 90% line coverage on codec/, encoding/ and session/
```

If you change the parser, also run `npm run fuzz` (1,000,000 iterations). If you change the session, the
client or the delivery tracker, run `npm run soak` (200,000 messages with receipts and disconnections,
memory must stay flat).

Add a changeset describing the change for users:

```sh
npx changeset
```

## Releasing (maintainer)

Releases are published by hand, not by CI. The documentation site (API reference, guides, coverage
badge) is published by the `Docs` workflow on every push to `main`.

```sh
npm run version-packages          # applies the changesets: version, CHANGELOG, jsr.json
git commit -am "chore: release X.Y.Z" && git tag vX.Y.Z && git push --follow-tags
npm publish                       # runs typecheck, tests and build first (prepublishOnly)
npm run jsr:publish
gh release create vX.Y.Z --notes-from-tag
```

To preview the documentation site locally: `npm run docs && npm run coverage && node scripts/coverage-badge.mjs`
(site in `docs-site/`).

## Rules

- **Layered architecture**: a layer only depends on the layers below it (`protocol` → `codec`/`encoding` → `transport` → `session` → `client`/`server`). `codec` and `encoding` never import `net`, `tls` or `events`.
- **Source of truth**: commands and TLVs are described in `src/protocol/`. The types and the codec derive from it: add a command or a TLV to the table, not to the codec.
- **Naming**: PDU fields keep the SMPP spec's snake_case (`destination_addr`); the API uses camelCase (`sendText`, `requestTimeout`).
- **Secure by default**: a security option is turned off explicitly, never turned on.
- **Errors**: always a subclass of `SmppError`. Sensitive values (passwords) never appear in an error message.
- **Zero runtime dependencies.**
- **Tests**: every bug fix comes with a regression test. An SMSC behaving differently from the spec gets an
  anonymized capture in `test/fixtures/` and a row in `docs/guides/operators.md`.
- **Comments**: in English, and only when they explain something the code does not say (a reason, a spec reference, a pitfall).
