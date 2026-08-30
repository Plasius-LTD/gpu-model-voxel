import {
  PVOX_BRICK_RECORD_LAYOUT_V1,
  PVOX_COMPILER_VERSION_V1,
  PVOX_DIRECTORY_ENTRY_LAYOUT_V1,
  PVOX_PAGE_SIZE_BYTES,
  PVOX_REVIEW_VIEW_ORDER_V1,
  PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1,
  PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1,
  PVOX_STATIC_MAXIMUM_PAGES_V1,
  compilePvoxStaticShellV1,
  createPvoxSurfaceMeshV1,
  renderPvoxReviewViewsV1,
  validatePvoxV1,
} from "../src/index.js";
import {
  concatenate,
  decodeMorton3,
  hexToBytes,
  morton3,
  sha256,
  utf8,
  writeBytes,
} from "../src/binary.js";
import { cubeCompilerInput } from "./fixtures.js";
import {
  firstSectionPaddingOffset,
  locateSection,
  mutateSection,
  rehashSection,
} from "./pvox-mutations.js";
import {
  PVOX_ROOT_HEADER_LAYOUT_V1,
} from "@plasius/asset-contracts";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe("PVOX 1.0 static preview", () => {
  it("compiles deterministically and independently validates", async () => {
    const input = cubeCompilerInput();
    const first = await compilePvoxStaticShellV1(input, { longestAxisCells: 8 });
    const second = await compilePvoxStaticShellV1(input, { longestAxisCells: 8 });
    expect(first.bytes).toEqual(second.bytes);
    expect(first.evidence).toEqual(second.evidence);
    expect(first.bytes.byteLength % PVOX_PAGE_SIZE_BYTES).toBe(0);
    expect(new TextDecoder().decode(first.bytes.subarray(0, 4))).toBe("PVOX");
    expect(first.evidence.sectionEvidence).toHaveLength(13);
    expect(first.evidence.pageEvidence.length).toBeGreaterThanOrEqual(1);
    expect(first.evidence.binaryClosureHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1).toBe(4_521_984);
    expect(PVOX_STATIC_MAXIMUM_PAGES_V1).toBe(69);

    const decoded = await validatePvoxV1(first.bytes, {
      artifactSha256: first.evidence.artifactSha256,
      sourceContentHash: input.sourceEvidence.sourceContentHash,
      canonicalDocumentHash: input.canonicalDocumentHash,
      binaryClosureHash: first.evidence.binaryClosureHash,
    });
    expect(decoded.voxels).toHaveLength(first.evidence.occupiedVoxelCount);
    expect(decoded.surfaces[0]!.baseColor[0]).toBeCloseTo(0.82, 2);
    expect(decoded.geometryMode).toBe("shell");
  });

  it("binds the exact verified-document profile into the compilation identity", async () => {
    const input = cubeCompilerInput();
    const result = await compilePvoxStaticShellV1(input, { longestAxisCells: 8 });
    const options = {
      profileVersion: PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1,
      longestAxisCells: 8,
      maximumOccupiedVoxels: 262_144,
      maximumTriangleCellTests: 12_000_000,
      geometryMode: "shell",
      lodCount: 1,
    };
    const expected = await sha256(concatenate([
      utf8("PVOX-COMPILATION-INPUT-V1\0"),
      hexToBytes(input.sourceEvidence.sourceContentHash),
      hexToBytes(input.canonicalDocumentHash),
      utf8(PVOX_COMPILER_VERSION_V1),
      utf8(JSON.stringify(options)),
    ]));
    const legacyUnbound = await sha256(concatenate([
      utf8("PVOX-COMPILATION-INPUT-V1\0"),
      hexToBytes(input.sourceEvidence.sourceContentHash),
      hexToBytes(input.canonicalDocumentHash),
      utf8(PVOX_COMPILER_VERSION_V1),
      utf8(JSON.stringify({ ...options, profileVersion: undefined })),
    ]));
    expect(result.evidence.compilationInputHash).toBe(expected);
    expect(result.evidence.compilationInputHash).not.toBe(legacyUnbound);
  });

  it("emits hierarchy bounds in full-resolution brick coordinates", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 32 });
    const nodeLocation = locateSection(result.bytes, "NODE");
    const nodes = result.bytes.subarray(nodeLocation.sectionOffset, nodeLocation.sectionOffset + nodeLocation.sectionLength);
    const view = new DataView(nodes.buffer, nodes.byteOffset, nodes.byteLength);
    const maximumDepth = new DataView(result.bytes.buffer).getUint8(PVOX_ROOT_HEADER_LAYOUT_V1.maximumHierarchyDepth.offset);
    let checkedScaledPrefix = false;
    for (let offset = 0; offset < nodes.byteLength; offset += 32) {
      const depth = view.getUint8(offset + 14);
      const morton = view.getBigUint64(offset, true);
      const decoded = decodeMorton3(morton, depth);
      const span = 2 ** (maximumDepth - depth);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(view.getUint16(offset + 20 + axis * 2, true)).toBe(decoded[axis]! * span);
        expect(view.getUint16(offset + 26 + axis * 2, true)).toBe(decoded[axis]! * span + span);
      }
      if (depth < maximumDepth && decoded.some((coordinate) => coordinate > 0) && span > 1) checkedScaledPrefix = true;
    }
    expect(checkedScaledPrefix).toBe(true);
  });

  it("derives a disposable surface cache and four real PNG views", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const decoded = await validatePvoxV1(result.bytes);
    const mesh = createPvoxSurfaceMeshV1(decoded);
    expect(mesh.representation).toBe("pvox-derived-surface-cache");
    expect(mesh.sourceArtifactSha256).toBe(result.evidence.artifactSha256);
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.normals.length);
    expect(mesh.colors.length / 4).toBe(mesh.positions.length / 3);
    expect(mesh.surfaceIndices.length).toBe(mesh.positions.length / 3);
    expect(new Set(mesh.surfaceIndices)).toEqual(new Set([0]));

    const views = await renderPvoxReviewViewsV1(decoded, { width: 64, height: 64 });
    expect(views.map((view) => view.name)).toEqual(PVOX_REVIEW_VIEW_ORDER_V1);
    expect(new Set(views.map((view) => view.sha256)).size).toBe(4);
    for (const view of views) {
      expect(Array.from(view.bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
      expect(view.bytes.byteLength).toBeGreaterThan(100);
      expect(view.contentType).toBe("image/png");
    }
  });

  it("renders by validating byte input and supports governed review options", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const views = await renderPvoxReviewViewsV1(result.bytes, {
      width: 64,
      height: 80,
      background: [250, 250, 250, 255],
    });
    expect(views[0]).toMatchObject({ width: 64, height: 80 });
  });

  it("rejects header, directory, section and trailing-byte substitution", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const mutations: Uint8Array[] = [];
    const magic = result.bytes.slice();
    magic[0] = 0;
    mutations.push(magic);
    const reservedHeader = result.bytes.slice();
    reservedHeader[255] = 1;
    mutations.push(reservedHeader);
    const unknownDirectory = result.bytes.slice();
    new DataView(unknownDirectory.buffer).setUint32(256 + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionType.offset, 0x12345678, true);
    mutations.push(unknownDirectory);
    const directoryHash = result.bytes.slice();
    directoryHash[256 + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionHash.offset] = directoryHash[256 + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionHash.offset]! ^ 1;
    mutations.push(directoryHash);
    const section = result.bytes.slice();
    const firstSectionOffset = Number(new DataView(section.buffer).getBigUint64(256 + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteOffset.offset, true));
    section[firstSectionOffset] = section[firstSectionOffset]! ^ 1;
    mutations.push(section);
    const trailing = result.bytes.slice();
    trailing[trailing.length - 1] = 1;
    mutations.push(trailing);
    for (const bytes of mutations) await expect(validatePvoxV1(bytes)).rejects.toThrow();
  });

  it("rejects nonzero directory and inter-section padding", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const directoryPadding = result.bytes.slice();
    directoryPadding[firstSectionPaddingOffset(directoryPadding)] = 1;
    await expect(validatePvoxV1(directoryPadding)).rejects.toThrow(/padding/u);

    const locations = result.evidence.sectionEvidence.slice().sort((left, right) => left.byteOffset - right.byteOffset);
    const gap = locations.find((section, index) => {
      const next = locations[index + 1];
      return next !== undefined && section.byteOffset + section.byteLength < next.byteOffset;
    });
    expect(gap).toBeDefined();
    const sectionPadding = result.bytes.slice();
    sectionPadding[gap!.byteOffset + gap!.byteLength] = 1;
    await expect(validatePvoxV1(sectionPadding)).rejects.toThrow(/padding/u);
  });

  it("fails closed on self-consistent rehashed static-profile limit mutations", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const mutations = [
      await mutateSection(result.bytes, "PART", (section) => new DataView(section.buffer, section.byteOffset).setUint32(8, 65, true)),
      await mutateSection(result.bytes, "PART", (section) => new DataView(section.buffer, section.byteOffset).setUint32(24, 262_145, true)),
      await mutateSection(result.bytes, "PART", (section) => new DataView(section.buffer, section.byteOffset).setUint32(28, 257, true)),
      await mutateSection(result.bytes, "PART", (section) => new DataView(section.buffer, section.byteOffset).setBigInt64(32, 0n, true)),
      await mutateSection(result.bytes, "PART", (section) => new DataView(section.buffer, section.byteOffset).setBigInt64(40, 1n << 60n, true)),
      await mutateSection(result.bytes, "BRIK", (section) => new DataView(section.buffer, section.byteOffset).setUint16(PVOX_BRICK_RECORD_LAYOUT_V1.occupiedCount, 513, true)),
      await mutateSection(result.bytes, "BRIK", (section) => {
        const view = new DataView(section.buffer, section.byteOffset);
        view.setBigUint64(PVOX_BRICK_RECORD_LAYOUT_V1.morton, morton3(8, 0, 0), true);
        view.setInt32(PVOX_BRICK_RECORD_LAYOUT_V1.brickX, 8, true);
      }),
    ];
    for (const mutation of mutations) await expect(validatePvoxV1(mutation)).rejects.toThrow();

    const oversized = new Uint8Array(PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1 + PVOX_PAGE_SIZE_BYTES);
    await expect(validatePvoxV1(oversized)).rejects.toThrow(/byte length/u);
  });

  it("reconstructs hierarchy ancestry, containment, ranges and leaf identities", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 32 });
    const levelLocation = locateSection(result.bytes, "LEVL");
    const levels = result.bytes.subarray(levelLocation.sectionOffset, levelLocation.sectionOffset + levelLocation.sectionLength);
    const levelView = new DataView(levels.buffer, levels.byteOffset, levels.byteLength);
    const maximumDepth = new DataView(result.bytes.buffer).getUint8(PVOX_ROOT_HEADER_LAYOUT_V1.maximumHierarchyDepth.offset);
    const leafStart = levelView.getUint32(maximumDepth * 32 + 8, true);
    const leafCount = levelView.getUint32(maximumDepth * 32 + 12, true);
    expect(leafCount).toBeGreaterThan(1);

    const badRootBounds = await mutateSection(result.bytes, "ROOT", (section) => {
      const view = new DataView(section.buffer, section.byteOffset);
      view.setInt32(36, view.getInt32(36, true) + 1, true);
    });
    const badLevelRange = await mutateSection(result.bytes, "LEVL", (section) => {
      new DataView(section.buffer, section.byteOffset).setUint32(maximumDepth * 32 + 20, 0, true);
    });
    const badMortonDepth = await mutateSection(result.bytes, "NODE", (section) => {
      new DataView(section.buffer, section.byteOffset).setBigUint64(0, 1n, true);
    });
    const badChildStart = await mutateSection(result.bytes, "NODE", (section) => {
      const view = new DataView(section.buffer, section.byteOffset);
      view.setUint32(8, view.getUint32(8, true) + 1, true);
    });
    const badNodeBounds = await mutateSection(result.bytes, "NODE", (section) => {
      const view = new DataView(section.buffer, section.byteOffset);
      const target = 32;
      view.setUint16(target + 20, view.getUint16(target + 20, true) + 1, true);
    });
    const swappedLeaves = await mutateSection(result.bytes, "NODE", (section) => {
      const view = new DataView(section.buffer, section.byteOffset);
      const first = leafStart * 32 + 16;
      const second = (leafStart + 1) * 32 + 16;
      const firstIndex = view.getUint32(first, true);
      view.setUint32(first, view.getUint32(second, true), true);
      view.setUint32(second, firstIndex, true);
    });
    for (const mutation of [badRootBounds, badLevelRange, badMortonDepth, badChildStart, badNodeBounds, swappedLeaves]) {
      await expect(validatePvoxV1(mutation)).rejects.toThrow();
    }
  });

  it("rejects a fully rehashed payload-to-surface substitution", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const bytes = result.bytes.slice();
    const dataLocation = locateSection(bytes, "DATA");
    const brickLocation = locateSection(bytes, "BRIK");
    const payload = bytes.subarray(dataLocation.sectionOffset, dataLocation.sectionOffset + dataLocation.sectionLength);
    new DataView(payload.buffer, payload.byteOffset).setUint16(128, 1, true);
    await rehashSection(bytes, "DATA");
    const payloadHash = await sha256(payload);
    writeBytes(bytes, brickLocation.sectionOffset + PVOX_BRICK_RECORD_LAYOUT_V1.payloadHash, hexToBytes(payloadHash));
    await rehashSection(bytes, "BRIK");
    await expect(validatePvoxV1(bytes)).rejects.toThrow(/surface sample linkage/u);
  });

  it("rejects unknown runtime profiles and non-minimal zero-padded artifacts", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const runtimeProfile = result.bytes.slice();
    runtimeProfile[PVOX_ROOT_HEADER_LAYOUT_V1.runtimeRequestProfileHash.offset]
      = runtimeProfile[PVOX_ROOT_HEADER_LAYOUT_V1.runtimeRequestProfileHash.offset]! ^ 1;
    await expect(validatePvoxV1(runtimeProfile)).rejects.toThrow(/runtime request profile/u);

    const padded = new Uint8Array(result.bytes.byteLength + PVOX_PAGE_SIZE_BYTES);
    padded.set(result.bytes);
    const paddedView = new DataView(padded.buffer);
    paddedView.setBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.artifactByteLength.offset, BigInt(padded.byteLength), true);
    paddedView.setUint32(PVOX_ROOT_HEADER_LAYOUT_V1.pageCount.offset, padded.byteLength / PVOX_PAGE_SIZE_BYTES, true);
    await expect(validatePvoxV1(padded)).rejects.toThrow(/minimal complete-page/u);
  });

  it("enforces expected identities and closure inputs", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    await expect(validatePvoxV1(result.bytes, { artifactSha256: "0".repeat(64) })).rejects.toThrow(/artifact hash/u);
    await expect(validatePvoxV1(result.bytes, { sourceContentHash: "a".repeat(64) })).rejects.toThrow(/both source/u);
    await expect(validatePvoxV1(result.bytes, { binaryClosureHash: "a".repeat(64) })).rejects.toThrow(/source identities/u);
    await expect(validatePvoxV1(result.bytes, {
      sourceContentHash: "a".repeat(64),
      canonicalDocumentHash: "b".repeat(64),
      binaryClosureHash: "0".repeat(64),
    })).rejects.toThrow(/binary closure/u);
  });

  it("enforces render and cache limits", async () => {
    const result = await compilePvoxStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    const decoded = await validatePvoxV1(result.bytes);
    expect(() => createPvoxSurfaceMeshV1(decoded, { maximumFaces: 1 })).toThrow(/face budget/u);
    expect(() => createPvoxSurfaceMeshV1({ ...decoded, artifactSha256: "bad" })).toThrow(/static-preview profile/u);
    expect(() => createPvoxSurfaceMeshV1({ ...decoded, voxels: [decoded.voxels[0]!, decoded.voxels[0]!] })).toThrow(/duplicate voxel/u);
    expect(() => createPvoxSurfaceMeshV1({
      ...decoded,
      voxels: [{ ...decoded.voxels[0]!, grid: [decoded.gridDimensions[0], 0, 0] }],
    })).toThrow(/invalid voxel/u);
    await expect(renderPvoxReviewViewsV1(decoded, { width: 32 })).rejects.toThrow(/dimensions/u);
    await expect(renderPvoxReviewViewsV1(decoded, { background: [0, 0, 0, 999] })).rejects.toThrow(/background/u);
  });
});
