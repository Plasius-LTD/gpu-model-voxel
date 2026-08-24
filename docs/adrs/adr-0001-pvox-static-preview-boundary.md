# ADR 0001: PVOX static preview package boundary

- Status: Accepted
- Date: 2026-08-24
- Task: [gpu-model-voxel#2](https://github.com/Plasius-LTD/gpu-model-voxel/issues/2)
- Parent Feature: [plasius-ltd-site#2012](https://github.com/Plasius-LTD/plasius-ltd-site/issues/2012)

## Context

Plasius needs a real, inspectable PVOX artifact for a bounded ChatGPT upload
demonstration before the native sparse-field WebGPU traversal is complete.
Compilation, validation, evidence rendering, and browser decoding must share
one format owner without allowing a mesh-era runtime artifact to masquerade as
PVOX.

## Decision

`@plasius/gpu-model-voxel` owns deterministic PVOX bytes and an independent
decoder/validator. Review views are rendered from decoded PVOX LOD0. The
package may expose a disposable exposed-voxel surface mesh for compatibility
with the existing Product Studio triangle path, provided callers label it as a
derived cache and never publish it.

The first profile is fail-closed and intentionally limited to static,
texture-free, single-partition shell geometry. It accepts only the exact
`plasius.gpu-model-static-demo/1` projection, binds that identifier into the
compilation hash, and applies the 64³ limits recorded in TDR 0001 before large
decode allocations. The governing remote flag is
`asset.pipeline.pvox-models.enabled`.

## Consequences

- The demo proves PVOX compilation and PVOX-derived evidence.
- It does not prove native GPU sparse-field traversal, world editing, physical
  enrichment, provider ingestion, or production Feature acceptance.
- Exact record layouts are versioned in TDR 0001 and cannot change without a
  new section version or PVOX format version.
- Hierarchy validation reconstructs ancestry and leaf-to-brick identity rather
  than treating section hashes as sufficient structural evidence.
