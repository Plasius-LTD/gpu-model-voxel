# TDR 0001: Bounded PVOX 1.0 record layouts

- Status: Accepted
- Date: 2026-08-24

The artifact uses the root header and section identifiers published by
`@plasius/asset-contracts` 0.4. Directory entries are 128 bytes:

| Offset | Type | Meaning |
|---:|---|---|
| 0 | `u32` | section FourCC/type |
| 4 | `u16` | section version |
| 6 | `u16` | flags, zero in v1 |
| 8 | `u64` | aligned byte offset |
| 16 | `u64` | exact section byte length |
| 24 | `u32` | fixed record bytes, zero for DATA |
| 28 | `u32` | record count |
| 32 | `sha256[32]` | governed section hash |
| 64 | `zero[64]` | reserved |

Entries are strictly ordered by numeric type then version. Section bytes are
256-byte aligned and must not overlap. Every byte between the directory and the
first section, between sections, and after the final section is zero. The
artifact uses the minimal number of complete 64-KiB pages for that section
closure; padding is not part of any section.

The required static sections use the fixed widths from the shared registry.
The executable source beside this TDR exports the exact field offsets. `DATA`
contains one bounded brick payload per BRIK record: a 64-byte occupancy mask, a
64-byte active-sample mask, then one 16-byte fixed surface sample for every set
bit in Morton-local order. General compression, JSON, images, URIs, shaders,
scripts, and external dependencies are forbidden.

The `plasius.gpu-model-static-demo/1` profile is narrower than the general PVOX
contract: a grid is at most 64³ cells, with 512 bricks, hierarchy depth 3, 585
nodes, 262,144 occupied samples, 256 surfaces, and 4,521,984 artifact bytes.
ROOT, LEVL, NODE, and BRIK are reconstructed as one closure. Node Morton
prefixes are interpreted at their recorded depth; their full-resolution bounds
are `decode(prefix) × 2^(maximumDepth-depth)` through that minimum plus the same
span. Every non-root node has exactly one parent, every child is contained by
that parent, and each leaf address and bounds identify exactly one BRIK record.

Every emitted artifact is decoded and validated independently before return.
Root, directory, section, page-set, artifact, compilation-input, and runtime
profile SHA-256 values use the domain-separated preimages from
`@plasius/asset-contracts`. The compilation-input preimage also contains the
exact verified-document profile identifier so a future input-profile revision
cannot collide with this compiler's identity.
