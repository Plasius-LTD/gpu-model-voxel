# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Add deterministic bounded PVOX 1.0 shell compilation, independent validation,
  CPU four-view review rendering, browser decoding, and disposable surface-cache
  generation for the ChatGPT-to-GPU-Demo demonstration.
- Fail closed on compiler-profile drift, nonzero section padding, spatial-limit
  violations, and inconsistent ROOT/LEVL/NODE/BRIK hierarchy closures; bind the
  exact verified-document profile into compilation identity.
- Run full validation and package-inventory checks for trusted same-repository
  pull requests while rejecting external-fork execution.
- Include one decoded PVOX surface-palette index per disposable cache vertex so
  compatibility renderers can preserve surface-property groups.
- Prevent the read-only checkout credential from overriding the narrowly scoped
  release-prep GitHub App token during approved CD branch creation.
- Retry protected release-metadata merges while required checks complete so
  approved CD can proceed when repository auto-merge is disabled.
- Run pull-request and exact-main validation on GitHub-hosted Linux so release
  gates cannot wait on an unavailable self-hosted runner.
- Align GitHub CI, release preparation, immutable package sealing, npm OIDC
  publication, privacy checks, and first-publication safeguards with the
  released `@plasius/schema` v1.4.2 package template.
- Make dependency-tree auditing fail closed and pin patched build-tool
  transitive versions used by the release path.
