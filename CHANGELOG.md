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
