# @plasius/gpu-model-voxel

Browser-safe deterministic tooling for the Plasius PVOX model format.

The first public profile compiles a verified, static triangle document into a
single-partition, shell-mode, LOD0 PVOX 1.0 artifact. It independently validates
the artifact, decodes its surface field, renders four deterministic review PNGs,
and can derive a disposable exposed-voxel mesh for compatibility demos.

PVOX remains the immutable asset of record. The derived triangle cache is never
catalogued and is not native sparse-field renderer evidence.

## Feature gate

Consumers must evaluate `asset.pipeline.pvox-models.enabled` before invoking
the compiler or exposing PVOX assets. This package does not evaluate remote
flags itself.

## Bounded v0 profile

- PVOX 1.0, little endian, 8×8×8 bricks, 64-KiB pages.
- One partition and one visible LOD.
- `shell` geometry with at most 200,000 source triangles.
- Base-colour/material factors only; no runtime texture/image dependency.
- At most 64 cells on the longest axis and 262,144 occupied surface voxels.
- At most 512 bricks, hierarchy depth 3, 585 hierarchy nodes, and 4,521,984
  artifact bytes (69 complete pages) for this closed 64³ profile.
- `static-render-v1` only. Physical/destruction/deformation capabilities are
  explicitly unsupported.
- Compiler input must be the exact
  `plasius.gpu-model-static-demo/1` verified-document projection; that profile
  identifier is included in the compilation-input hash.

Malformed inputs fail closed. Unknown sections/codecs, invalid hashes,
overlapping ranges, duplicate or unsorted bricks, unbounded runs, non-finite
coordinates, nonzero alignment padding, inconsistent spatial bounds, invalid
hierarchy ancestry, and trailing bytes are rejected before large allocation.

## Public API

```ts
import {
  compilePvoxStaticShellV1,
  validatePvoxV1,
  renderPvoxReviewViewsV1,
  createPvoxSurfaceMeshV1,
} from "@plasius/gpu-model-voxel";
```

See [ADR 0001](./docs/adrs/adr-0001-pvox-static-preview-boundary.md)
and [TDR 0001](./docs/tdrs/tdr-0001-pvox-v1-record-layouts.md) for the
closed demo profile and exact records.

## Development

Use Node.js 24.18.0.

```sh
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run pack:check
```

## Licence

Apache-2.0. See [LICENSE](./LICENSE).
