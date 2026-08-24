import {
  PVOX_DIRECTORY_ENTRY_BYTE_LENGTH,
  PVOX_HEADER_BYTE_LENGTH,
  PVOX_MAX_ABSOLUTE_COORDINATE_METRES,
  PVOX_MAX_ENCODED_BRICK_PAYLOAD_BYTES,
  PVOX_MAX_RUNS_PER_BRICK,
  PVOX_PAGE_SIZE_BYTES,
  PVOX_ROOT_HEADER_LAYOUT_V1,
  PVOX_SECTION_ALIGNMENT_BYTES,
  PVOX_SECTION_REGISTRY,
  decodePvoxSha256HexV1,
  encodePvoxBinaryClosureHashPreimageV1,
  encodePvoxDirectoryHashPreimageV1,
  encodePvoxNamedJsonClosurePreimageV1,
  encodePvoxPageSetHashPreimageV1,
  encodePvoxRootHashPreimageV1,
  encodePvoxRootHeaderV1,
  encodePvoxSectionHashPreimageV1,
  normalizePvoxRootHeaderForHashV1,
} from "@plasius/asset-contracts";

import {
  align,
  assertRange,
  bytesEqual,
  bytesToHex,
  concatenate,
  decodeMorton3,
  dequantizeSnorm16,
  hexToBytes,
  isZeroRange,
  morton3,
  popcountMask,
  quantizeUnorm16,
  setI64,
  setU64,
  sha256,
  utf8,
  writeBytes,
} from "./binary.js";
import type {
  PvoxCompilationEvidenceV1,
  PvoxCompileOptionsV1,
  PvoxCompileResultV1,
  PvoxDecodedSurfaceV1,
  PvoxDecodedV1,
  PvoxDecodedVoxelV1,
  PvoxPageEvidenceV1,
  PvoxSectionEvidenceV1,
  PvoxStaticCompilerInputV1,
  PvoxValidationExpectationsV1,
  Vec3,
} from "./types.js";
import {
  encodeSurfaceSampleV1,
  voxelizeStaticShellV1,
  PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1,
  PVOX_STATIC_PREVIEW_LIMITS_V1,
  type NormalizedSurfaceV1,
  type VoxelBrickV1,
  type VoxelizationResultV1,
} from "./voxelize.js";

export const PVOX_COMPILER_VERSION_V1 = "@plasius/gpu-model-voxel/0.1-static-preview" as const;
export const PVOX_FIXED_POINT_FRACTION_BITS_V1 = 24 as const;
export const PVOX_SURFACE_SAMPLE_BYTES_V1 = 16 as const;
export const PVOX_BRICK_PAYLOAD_CODEC_FIXED_V1 = 0 as const;

export const PVOX_DIRECTORY_ENTRY_LAYOUT_V1 = Object.freeze({
  sectionType: Object.freeze({ offset: 0, byteLength: 4 }),
  sectionVersion: Object.freeze({ offset: 4, byteLength: 2 }),
  flags: Object.freeze({ offset: 6, byteLength: 2 }),
  byteOffset: Object.freeze({ offset: 8, byteLength: 8 }),
  byteLength: Object.freeze({ offset: 16, byteLength: 8 }),
  recordBytes: Object.freeze({ offset: 24, byteLength: 4 }),
  recordCount: Object.freeze({ offset: 28, byteLength: 4 }),
  sectionHash: Object.freeze({ offset: 32, byteLength: 32 }),
  reserved: Object.freeze({ offset: 64, byteLength: 64 }),
} as const);

export const PVOX_PART_RECORD_LAYOUT_V1 = Object.freeze({
  partitionIndex: 0,
  lodCount: 4,
  flags: 6,
  gridX: 8,
  gridY: 12,
  gridZ: 16,
  brickCount: 20,
  occupiedVoxelCount: 24,
  surfaceCount: 28,
  cellSize: 32,
  originX: 40,
  originY: 48,
  originZ: 56,
  minimumX: 64,
  minimumY: 72,
  minimumZ: 80,
  maximumX: 88,
  maximumY: 96,
  maximumZ: 104,
} as const);

export const PVOX_BRICK_RECORD_LAYOUT_V1 = Object.freeze({
  morton: 0,
  brickX: 8,
  brickY: 12,
  brickZ: 16,
  lodLevel: 20,
  flags: 22,
  dataByteOffset: 24,
  dataByteLength: 32,
  occupiedCount: 36,
  sampleCount: 38,
  minimumSurfaceIndex: 40,
  maximumSurfaceIndex: 42,
  payloadCodec: 44,
  reserved16: 46,
  payloadHash: 48,
  localMinimumX: 80,
  localMinimumY: 81,
  localMinimumZ: 82,
  localMaximumX: 83,
  localMaximumY: 84,
  localMaximumZ: 85,
  reserved: 86,
} as const);

interface SectionDefinitionV1 {
  readonly name: keyof typeof PVOX_SECTION_REGISTRY;
  readonly type: number;
  readonly version: number;
  readonly recordBytes: number;
}

interface BuiltSectionV1 extends SectionDefinitionV1 {
  readonly bytes: Uint8Array;
  readonly recordCount: number;
  readonly hash: string;
  readonly byteOffset: number;
}

interface DirectoryRecordV1 extends PvoxSectionEvidenceV1 {
  readonly name: keyof typeof PVOX_SECTION_REGISTRY;
}

interface EncodedBrickV1 {
  readonly brick: VoxelBrickV1;
  readonly payload: Uint8Array;
  readonly payloadHash: string;
  readonly dataByteOffset: number;
}

interface OctreeNodeV1 {
  readonly depth: number;
  readonly morton: bigint;
  readonly firstChild: number;
  readonly childCount: number;
  readonly brickIndex: number;
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

const REQUIRED_STATIC_SECTIONS = (Object.entries(PVOX_SECTION_REGISTRY) as Array<[
  keyof typeof PVOX_SECTION_REGISTRY,
  (typeof PVOX_SECTION_REGISTRY)[keyof typeof PVOX_SECTION_REGISTRY],
]>)
  .filter(([, definition]) => definition.required)
  .map(([name, definition]): SectionDefinitionV1 => ({
    name,
    type: definition.type,
    version: definition.version,
    recordBytes: definition.recordBytes,
  }))
  .sort((left, right) => left.type - right.type || left.version - right.version);

const REQUIRED_SECTION_KEYS = new Set(REQUIRED_STATIC_SECTIONS.map((section) => `${section.type}:${section.version}`));
const FIXED_SCALE = 2 ** PVOX_FIXED_POINT_FRACTION_BITS_V1;
const U32_MAX = 0xffff_ffff;
const STATIC_MAXIMUM_GRID_VOXELS = PVOX_STATIC_PREVIEW_LIMITS_V1.maximumLongestAxisCells ** 3;
const STATIC_MAXIMUM_BRICKS = PVOX_STATIC_PREVIEW_LIMITS_V1.maximumBricks;
const STATIC_MAXIMUM_HIERARCHY_DEPTH = PVOX_STATIC_PREVIEW_LIMITS_V1.maximumHierarchyDepth;
const QUANTIZED_COORDINATE_LIMIT = BigInt(PVOX_MAX_ABSOLUTE_COORDINATE_METRES) * BigInt(FIXED_SCALE);

function maximumStaticHierarchyNodes(maximumDepth = STATIC_MAXIMUM_HIERARCHY_DEPTH): number {
  let total = 0;
  for (let depth = 0; depth <= maximumDepth; depth += 1) total += 8 ** depth;
  return total;
}

function calculateStaticMaximumArtifactBytes(): number {
  const maximumRecordCounts: Readonly<Record<keyof typeof PVOX_SECTION_REGISTRY, number>> = {
    PART: 1,
    LODS: 1,
    ROOT: 1,
    LEVL: STATIC_MAXIMUM_HIERARCHY_DEPTH + 1,
    NODE: maximumStaticHierarchyNodes(),
    BRIK: STATIC_MAXIMUM_BRICKS,
    DATA: STATIC_MAXIMUM_BRICKS,
    SURF: PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials,
    PHYS: PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials,
    PEVI: PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials,
    REGN: PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials,
    LAYR: PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials,
    MASS: 1,
    BOND: 0,
    CROT: 0,
    CLEV: 0,
    CNOD: 0,
    CBRK: 0,
    CDAT: 0,
  };
  let byteOffset = align(
    PVOX_HEADER_BYTE_LENGTH + REQUIRED_STATIC_SECTIONS.length * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH,
    PVOX_SECTION_ALIGNMENT_BYTES,
  );
  for (const definition of REQUIRED_STATIC_SECTIONS) {
    const byteLength = definition.name === "DATA"
      ? STATIC_MAXIMUM_BRICKS * 128 + STATIC_MAXIMUM_GRID_VOXELS * PVOX_SURFACE_SAMPLE_BYTES_V1
      : definition.recordBytes * maximumRecordCounts[definition.name];
    byteOffset = align(byteOffset + byteLength, PVOX_SECTION_ALIGNMENT_BYTES);
  }
  return align(byteOffset, PVOX_PAGE_SIZE_BYTES);
}

/** Exact largest artifact that the closed 64³ static-preview profile can emit. */
export const PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1 = calculateStaticMaximumArtifactBytes();
export const PVOX_STATIC_MAXIMUM_PAGES_V1 = PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1 / PVOX_PAGE_SIZE_BYTES;

function quantizeCoordinate(value: number): bigint {
  const quantized = Math.round(value * FIXED_SCALE);
  if (!Number.isSafeInteger(quantized)) throw new Error("PVOX fixed-point coordinate exceeds safe compilation range.");
  return BigInt(quantized);
}

function dequantizeCoordinate(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new Error("PVOX fixed-point coordinate exceeds safe decoding range.");
  return numeric / FIXED_SCALE;
}

function requireQuantizedCoordinate(value: bigint, fieldName: string): bigint {
  if (value < -QUANTIZED_COORDINATE_LIMIT || value > QUANTIZED_COORDINATE_LIMIT) {
    throw new Error(`${fieldName} exceeds the static-preview coordinate ceiling.`);
  }
  return value;
}

function quantizedSpatialProfile(voxelization: VoxelizationResultV1): {
  readonly cellSize: bigint;
  readonly origin: readonly [bigint, bigint, bigint];
  readonly bounds: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
} {
  const cellSize = quantizeCoordinate(voxelization.cellSizeMetres);
  if (cellSize <= 0n) throw new Error("PVOX quantized cell size must be positive.");
  const origin: [bigint, bigint, bigint] = [0, 1, 2].map((axis) => requireQuantizedCoordinate(
    quantizeCoordinate(voxelization.origin[axis]!),
    `PVOX origin[${axis}]`,
  )) as [bigint, bigint, bigint];
  const maximum: [bigint, bigint, bigint] = [0, 1, 2].map((axis) => requireQuantizedCoordinate(
    origin[axis]! + cellSize * BigInt(voxelization.gridDimensions[axis]!),
    `PVOX maximum[${axis}]`,
  )) as [bigint, bigint, bigint];
  return { cellSize, origin, bounds: [origin[0], origin[1], origin[2], maximum[0], maximum[1], maximum[2]] };
}

function createPartSection(
  voxelization: VoxelizationResultV1,
  spatial: ReturnType<typeof quantizedSpatialProfile>,
): Uint8Array {
  const bytes = new Uint8Array(PVOX_SECTION_REGISTRY.PART.recordBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.partitionIndex, 0, true);
  view.setUint16(PVOX_PART_RECORD_LAYOUT_V1.lodCount, 1, true);
  view.setUint16(PVOX_PART_RECORD_LAYOUT_V1.flags, 0, true);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.gridX, voxelization.gridDimensions[0], true);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.gridY, voxelization.gridDimensions[1], true);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.gridZ, voxelization.gridDimensions[2], true);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.brickCount, voxelization.bricks.length, true);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.occupiedVoxelCount, voxelization.voxels.length, true);
  view.setUint32(PVOX_PART_RECORD_LAYOUT_V1.surfaceCount, voxelization.surfaces.length, true);
  setI64(view, PVOX_PART_RECORD_LAYOUT_V1.cellSize, spatial.cellSize);
  for (let axis = 0; axis < 3; axis += 1) {
    setI64(view, PVOX_PART_RECORD_LAYOUT_V1.originX + axis * 8, spatial.origin[axis]!);
    setI64(view, PVOX_PART_RECORD_LAYOUT_V1.minimumX + axis * 8, spatial.bounds[axis]!);
    setI64(view, PVOX_PART_RECORD_LAYOUT_V1.maximumX + axis * 8, spatial.bounds[axis + 3]!);
  }
  return bytes;
}

function createLodsSection(voxelization: VoxelizationResultV1): Uint8Array {
  const bytes = new Uint8Array(PVOX_SECTION_REGISTRY.LODS.recordBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, voxelization.gridDimensions[0], true);
  view.setUint32(12, voxelization.gridDimensions[1], true);
  view.setUint32(16, voxelization.gridDimensions[2], true);
  view.setUint32(20, voxelization.bricks.length, true);
  view.setUint32(24, voxelization.voxels.length, true);
  setI64(view, 32, quantizeCoordinate(voxelization.cellSizeMetres));
  return bytes;
}

function buildOctree(bricks: readonly VoxelBrickV1[]): {
  readonly maximumDepth: number;
  readonly nodes: readonly OctreeNodeV1[];
  readonly levelSpans: readonly { depth: number; nodeStart: number; nodeCount: number }[];
} {
  if (bricks.length < 1) throw new Error("PVOX requires at least one brick.");
  const maximumCoordinate = Math.max(...bricks.flatMap((brick) => [brick.x, brick.y, brick.z]));
  const maximumDepth = maximumCoordinate === 0 ? 0 : Math.ceil(Math.log2(maximumCoordinate + 1));
  if (maximumDepth > 8) throw new Error("PVOX octree exceeds maximum hierarchy depth.");
  const prefixesByDepth: bigint[][] = [];
  for (let depth = 0; depth <= maximumDepth; depth += 1) {
    const shift = BigInt(3 * (maximumDepth - depth));
    const prefixes = [...new Set(bricks.map((brick) => (brick.morton >> shift).toString()))]
      .map((value) => BigInt(value))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    prefixesByDepth.push(prefixes);
  }
  const indexByKey = new Map<string, number>();
  const levelSpans: Array<{ depth: number; nodeStart: number; nodeCount: number }> = [];
  let nodeIndex = 0;
  for (let depth = 0; depth <= maximumDepth; depth += 1) {
    const prefixes = prefixesByDepth[depth]!;
    levelSpans.push({ depth, nodeStart: nodeIndex, nodeCount: prefixes.length });
    for (const prefix of prefixes) indexByKey.set(`${depth}:${prefix}`, nodeIndex++);
  }
  const brickIndexByMorton = new Map(bricks.map((brick, index) => [brick.morton.toString(), index]));
  const nodes: OctreeNodeV1[] = [];
  for (let depth = 0; depth <= maximumDepth; depth += 1) {
    const prefixes = prefixesByDepth[depth]!;
    for (const prefix of prefixes) {
      const isLeaf = depth === maximumDepth;
      const childPrefixes = isLeaf ? [] : prefixesByDepth[depth + 1]!.filter((candidate) => candidate >> 3n === prefix);
      const firstChild = childPrefixes.length === 0 ? U32_MAX : indexByKey.get(`${depth + 1}:${childPrefixes[0]}`)!;
      const brickIndex = isLeaf ? brickIndexByMorton.get(prefix.toString()) : undefined;
      if (isLeaf && brickIndex === undefined) throw new Error("Octree leaf does not resolve to a brick.");
      const decoded = decodeMorton3(prefix, depth);
      const span = 2 ** (maximumDepth - depth);
      const minimum = decoded.map((coordinate) => coordinate * span) as [number, number, number];
      nodes.push({
        depth,
        morton: prefix,
        firstChild,
        childCount: childPrefixes.length,
        brickIndex: brickIndex ?? U32_MAX,
        minimum,
        maximum: [minimum[0] + span, minimum[1] + span, minimum[2] + span],
      });
    }
  }
  return { maximumDepth, nodes: Object.freeze(nodes), levelSpans: Object.freeze(levelSpans) };
}

function createRootSection(octree: ReturnType<typeof buildOctree>, bricks: readonly VoxelBrickV1[]): Uint8Array {
  const bytes = new Uint8Array(PVOX_SECTION_REGISTRY.ROOT.recordBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0, true);
  view.setUint16(4, 0, true);
  view.setUint8(6, octree.maximumDepth);
  view.setUint8(7, 0);
  view.setUint32(8, 0, true);
  view.setUint32(12, octree.nodes.length, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, bricks.length, true);
  const maximum = [
    Math.max(...bricks.map((brick) => brick.x)) + 1,
    Math.max(...bricks.map((brick) => brick.y)) + 1,
    Math.max(...bricks.map((brick) => brick.z)) + 1,
  ];
  for (let axis = 0; axis < 3; axis += 1) {
    view.setInt32(24 + axis * 4, 0, true);
    view.setInt32(36 + axis * 4, maximum[axis]!, true);
  }
  return bytes;
}

function createLevelSection(octree: ReturnType<typeof buildOctree>, brickCount: number): Uint8Array {
  const recordBytes = PVOX_SECTION_REGISTRY.LEVL.recordBytes;
  const bytes = new Uint8Array(recordBytes * octree.levelSpans.length);
  const view = new DataView(bytes.buffer);
  octree.levelSpans.forEach((span, index) => {
    const offset = index * recordBytes;
    view.setUint32(offset, 0, true);
    view.setUint16(offset + 4, 0, true);
    view.setUint8(offset + 6, span.depth);
    view.setUint8(offset + 7, 0);
    view.setUint32(offset + 8, span.nodeStart, true);
    view.setUint32(offset + 12, span.nodeCount, true);
    view.setUint32(offset + 16, span.depth === octree.maximumDepth ? 0 : U32_MAX, true);
    view.setUint32(offset + 20, span.depth === octree.maximumDepth ? brickCount : 0, true);
  });
  return bytes;
}

function createNodeSection(octree: ReturnType<typeof buildOctree>): Uint8Array {
  const recordBytes = PVOX_SECTION_REGISTRY.NODE.recordBytes;
  const bytes = new Uint8Array(recordBytes * octree.nodes.length);
  const view = new DataView(bytes.buffer);
  octree.nodes.forEach((node, index) => {
    const offset = index * recordBytes;
    setU64(view, offset, node.morton);
    view.setUint32(offset + 8, node.firstChild, true);
    view.setUint16(offset + 12, node.childCount, true);
    view.setUint8(offset + 14, node.depth);
    view.setUint8(offset + 15, node.brickIndex === U32_MAX ? 0 : 1);
    view.setUint32(offset + 16, node.brickIndex, true);
    for (let axis = 0; axis < 3; axis += 1) {
      view.setUint16(offset + 20 + axis * 2, node.minimum[axis]!, true);
      view.setUint16(offset + 26 + axis * 2, node.maximum[axis]!, true);
    }
  });
  return bytes;
}

async function encodeBricks(
  bricks: readonly VoxelBrickV1[],
  surfaces: readonly NormalizedSurfaceV1[],
): Promise<readonly EncodedBrickV1[]> {
  let dataByteOffset = 0;
  const output: EncodedBrickV1[] = [];
  for (const brick of bricks) {
    if (brick.samples.length < 1 || brick.samples.length > PVOX_MAX_RUNS_PER_BRICK) {
      throw new Error("Brick sample count is outside the bounded codec range.");
    }
    const payload = new Uint8Array(128 + brick.samples.length * PVOX_SURFACE_SAMPLE_BYTES_V1);
    const occupancy = payload.subarray(0, 64);
    const active = payload.subarray(64, 128);
    let previousMorton = -1;
    brick.samples.forEach((sample, sampleIndex) => {
      if (sample.localMorton <= previousMorton || sample.localMorton > 511) {
        throw new Error("Brick samples must be unique and strictly Morton ordered.");
      }
      previousMorton = sample.localMorton;
      const maskByte = sample.localMorton >>> 3;
      const maskBit = 1 << (sample.localMorton & 7);
      occupancy[maskByte] = occupancy[maskByte]! | maskBit;
      active[maskByte] = active[maskByte]! | maskBit;
      const surface = surfaces[sample.surfaceIndex];
      if (!surface) throw new Error("Brick sample references an unknown surface.");
      writeBytes(payload, 128 + sampleIndex * PVOX_SURFACE_SAMPLE_BYTES_V1, encodeSurfaceSampleV1(sample, surface));
    });
    if (payload.byteLength > PVOX_MAX_ENCODED_BRICK_PAYLOAD_BYTES) throw new Error("Brick payload exceeds the PVOX codec ceiling.");
    const payloadHash = await sha256(payload);
    output.push({ brick, payload, payloadHash, dataByteOffset });
    dataByteOffset += payload.byteLength;
  }
  return Object.freeze(output);
}

function createBrickSection(bricks: readonly EncodedBrickV1[]): Uint8Array {
  const recordBytes = PVOX_SECTION_REGISTRY.BRIK.recordBytes;
  const bytes = new Uint8Array(recordBytes * bricks.length);
  const view = new DataView(bytes.buffer);
  bricks.forEach((encoded, index) => {
    const offset = index * recordBytes;
    const surfaces = encoded.brick.samples.map((sample) => sample.surfaceIndex);
    const locals = encoded.brick.samples.map((sample) => decodeMorton3(BigInt(sample.localMorton), 3));
    setU64(view, offset + PVOX_BRICK_RECORD_LAYOUT_V1.morton, encoded.brick.morton);
    view.setInt32(offset + PVOX_BRICK_RECORD_LAYOUT_V1.brickX, encoded.brick.x, true);
    view.setInt32(offset + PVOX_BRICK_RECORD_LAYOUT_V1.brickY, encoded.brick.y, true);
    view.setInt32(offset + PVOX_BRICK_RECORD_LAYOUT_V1.brickZ, encoded.brick.z, true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.lodLevel, 0, true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.flags, 1, true);
    setU64(view, offset + PVOX_BRICK_RECORD_LAYOUT_V1.dataByteOffset, encoded.dataByteOffset);
    view.setUint32(offset + PVOX_BRICK_RECORD_LAYOUT_V1.dataByteLength, encoded.payload.byteLength, true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.occupiedCount, encoded.brick.samples.length, true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.sampleCount, encoded.brick.samples.length, true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.minimumSurfaceIndex, Math.min(...surfaces), true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.maximumSurfaceIndex, Math.max(...surfaces), true);
    view.setUint16(offset + PVOX_BRICK_RECORD_LAYOUT_V1.payloadCodec, PVOX_BRICK_PAYLOAD_CODEC_FIXED_V1, true);
    writeBytes(bytes, offset + PVOX_BRICK_RECORD_LAYOUT_V1.payloadHash, hexToBytes(encoded.payloadHash));
    for (let axis = 0; axis < 3; axis += 1) {
      bytes[offset + PVOX_BRICK_RECORD_LAYOUT_V1.localMinimumX + axis] = Math.min(...locals.map((local) => local[axis]!));
      bytes[offset + PVOX_BRICK_RECORD_LAYOUT_V1.localMaximumX + axis] = Math.max(...locals.map((local) => local[axis]!));
    }
  });
  return bytes;
}

function createDataSection(bricks: readonly EncodedBrickV1[]): Uint8Array {
  return concatenate(bricks.map((brick) => brick.payload));
}

function createSurfaceSection(surfaces: readonly NormalizedSurfaceV1[]): Uint8Array {
  const recordBytes = PVOX_SECTION_REGISTRY.SURF.recordBytes;
  const bytes = new Uint8Array(recordBytes * surfaces.length);
  const view = new DataView(bytes.buffer);
  surfaces.forEach((surface, index) => {
    const offset = index * recordBytes;
    view.setUint32(offset, surface.surfaceIndex, true);
    bytes[offset + 4] = Math.round(surface.baseColor[0] * 255);
    bytes[offset + 5] = Math.round(surface.baseColor[1] * 255);
    bytes[offset + 6] = Math.round(surface.baseColor[2] * 255);
    bytes[offset + 7] = Math.round(surface.baseColor[3] * 255);
    view.setUint16(offset + 8, quantizeUnorm16(surface.roughness), true);
    view.setUint16(offset + 10, quantizeUnorm16(surface.metallic), true);
    view.setUint16(offset + 12, quantizeUnorm16(surface.specular), true);
    view.setUint16(offset + 14, quantizeUnorm16(surface.baseColor[3]), true);
    view.setUint16(offset + 16, quantizeUnorm16(surface.emission[0]), true);
    view.setUint16(offset + 18, quantizeUnorm16(surface.emission[1]), true);
    view.setUint16(offset + 20, quantizeUnorm16(surface.emission[2]), true);
    view.setUint16(offset + 22, 1, true);
  });
  return bytes;
}

function createPhysicalSections(surfaceCount: number): Record<"PHYS" | "PEVI" | "REGN" | "LAYR" | "MASS", Uint8Array> {
  const physical = new Uint8Array(PVOX_SECTION_REGISTRY.PHYS.recordBytes * surfaceCount);
  const evidence = new Uint8Array(PVOX_SECTION_REGISTRY.PEVI.recordBytes * surfaceCount);
  const regions = new Uint8Array(PVOX_SECTION_REGISTRY.REGN.recordBytes * surfaceCount);
  const layers = new Uint8Array(PVOX_SECTION_REGISTRY.LAYR.recordBytes * surfaceCount);
  const mass = new Uint8Array(PVOX_SECTION_REGISTRY.MASS.recordBytes);
  const physicalView = new DataView(physical.buffer);
  const evidenceView = new DataView(evidence.buffer);
  const regionView = new DataView(regions.buffer);
  const layerView = new DataView(layers.buffer);
  for (let index = 0; index < surfaceCount; index += 1) {
    const physicalOffset = index * PVOX_SECTION_REGISTRY.PHYS.recordBytes;
    const evidenceOffset = index * PVOX_SECTION_REGISTRY.PEVI.recordBytes;
    const regionOffset = index * PVOX_SECTION_REGISTRY.REGN.recordBytes;
    const layerOffset = index * PVOX_SECTION_REGISTRY.LAYR.recordBytes;
    physicalView.setUint32(physicalOffset, index, true);
    physicalView.setUint16(physicalOffset + 4, 4, true);
    physicalView.setUint16(physicalOffset + 6, 0, true);
    evidenceView.setUint32(evidenceOffset, index, true);
    evidenceView.setUint16(evidenceOffset + 4, 4, true);
    evidenceView.setUint16(evidenceOffset + 6, 0, true);
    regionView.setUint32(regionOffset, index, true);
    regionView.setUint32(regionOffset + 4, index, true);
    regionView.setUint32(regionOffset + 8, index, true);
    regionView.setUint32(regionOffset + 12, index, true);
    regionView.setUint16(regionOffset + 16, 1, true);
    regionView.setUint16(regionOffset + 18, 1, true);
    layerView.setUint32(layerOffset, index, true);
    layerView.setUint32(layerOffset + 4, 0, true);
    layerView.setUint32(layerOffset + 8, index, true);
    layerView.setUint32(layerOffset + 12, index, true);
    layerView.setUint16(layerOffset + 16, 4, true);
    layerView.setUint16(layerOffset + 18, 0, true);
  }
  const massView = new DataView(mass.buffer);
  massView.setUint32(0, 0, true);
  massView.setUint16(4, 4, true);
  massView.setUint16(6, 0, true);
  return { PHYS: physical, PEVI: evidence, REGN: regions, LAYR: layers, MASS: mass };
}

function sectionRecordCount(name: keyof typeof PVOX_SECTION_REGISTRY, voxelization: VoxelizationResultV1, octree: ReturnType<typeof buildOctree>): number {
  switch (name) {
    case "PART":
    case "LODS":
    case "ROOT":
    case "MASS":
      return 1;
    case "LEVL":
      return octree.levelSpans.length;
    case "NODE":
      return octree.nodes.length;
    case "BRIK":
    case "DATA":
      return voxelization.bricks.length;
    case "SURF":
    case "PHYS":
    case "PEVI":
    case "REGN":
    case "LAYR":
      return voxelization.surfaces.length;
    default:
      throw new Error(`Unsupported static section ${name}.`);
  }
}

async function buildSectionPayloads(voxelization: VoxelizationResultV1): Promise<{
  readonly payloads: ReadonlyMap<keyof typeof PVOX_SECTION_REGISTRY, Uint8Array>;
  readonly octree: ReturnType<typeof buildOctree>;
  readonly spatial: ReturnType<typeof quantizedSpatialProfile>;
}> {
  const octree = buildOctree(voxelization.bricks);
  const spatial = quantizedSpatialProfile(voxelization);
  const encodedBricks = await encodeBricks(voxelization.bricks, voxelization.surfaces);
  const physical = createPhysicalSections(voxelization.surfaces.length);
  const payloads = new Map<keyof typeof PVOX_SECTION_REGISTRY, Uint8Array>([
    ["PART", createPartSection(voxelization, spatial)],
    ["LODS", createLodsSection(voxelization)],
    ["ROOT", createRootSection(octree, voxelization.bricks)],
    ["LEVL", createLevelSection(octree, voxelization.bricks.length)],
    ["NODE", createNodeSection(octree)],
    ["BRIK", createBrickSection(encodedBricks)],
    ["DATA", createDataSection(encodedBricks)],
    ["SURF", createSurfaceSection(voxelization.surfaces)],
    ["PHYS", physical.PHYS],
    ["PEVI", physical.PEVI],
    ["REGN", physical.REGN],
    ["LAYR", physical.LAYR],
    ["MASS", physical.MASS],
  ]);
  return { payloads, octree, spatial };
}

async function hashCompilationInput(
  voxelization: VoxelizationResultV1,
  options: Required<Pick<PvoxCompileOptionsV1, "longestAxisCells" | "maximumOccupiedVoxels" | "maximumTriangleCellTests">>,
): Promise<string> {
  if (voxelization.profileVersion !== PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1) {
    throw new Error("PVOX compilation input profile is unsupported.");
  }
  const preimage = concatenate([
    utf8("PVOX-COMPILATION-INPUT-V1\0"),
    hexToBytes(voxelization.sourceContentHash),
    hexToBytes(voxelization.canonicalDocumentHash),
    utf8(PVOX_COMPILER_VERSION_V1),
    utf8(JSON.stringify({
      profileVersion: PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1,
      longestAxisCells: options.longestAxisCells,
      maximumOccupiedVoxels: options.maximumOccupiedVoxels,
      maximumTriangleCellTests: options.maximumTriangleCellTests,
      geometryMode: "shell",
      lodCount: 1,
    })),
  ]);
  return sha256(preimage);
}

async function hashRuntimeProfile(): Promise<string> {
  return sha256(encodePvoxNamedJsonClosurePreimageV1("runtime-request-profile", {
    profileVersion: "plasius.pvox-runtime-request/1",
    representation: "pvox",
    runtimeProfileId: "static-render-v1",
    geometryMode: "shell",
    lodCount: 1,
    brickEdgeVoxels: 8,
    pageSizeBytes: PVOX_PAGE_SIZE_BYTES,
    derivedSurfaceCacheAllowed: true,
    nativeGpuSparseTraversalQualified: false,
  }));
}

async function createDirectoryBytes(
  sections: readonly BuiltSectionV1[],
): Promise<{ readonly bytes: Uint8Array; readonly hash: string }> {
  const bytes = new Uint8Array(sections.length * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  sections.forEach((section, index) => {
    const offset = index * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH;
    view.setUint32(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionType.offset, section.type, true);
    view.setUint16(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionVersion.offset, section.version, true);
    view.setUint16(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.flags.offset, 0, true);
    setU64(view, offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteOffset.offset, section.byteOffset);
    setU64(view, offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteLength.offset, section.bytes.byteLength);
    view.setUint32(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.recordBytes.offset, section.recordBytes, true);
    view.setUint32(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.recordCount.offset, section.recordCount, true);
    writeBytes(bytes, offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionHash.offset, hexToBytes(section.hash));
  });
  const hash = await sha256(encodePvoxDirectoryHashPreimageV1(sections.length, bytes));
  return { bytes, hash };
}

function resolveCompileHashOptions(options: PvoxCompileOptionsV1): Required<Pick<PvoxCompileOptionsV1, "longestAxisCells" | "maximumOccupiedVoxels" | "maximumTriangleCellTests">> {
  return {
    longestAxisCells: options.longestAxisCells ?? 48,
    maximumOccupiedVoxels: options.maximumOccupiedVoxels ?? 262_144,
    maximumTriangleCellTests: options.maximumTriangleCellTests ?? 12_000_000,
  };
}

async function pageEvidence(bytes: Uint8Array): Promise<readonly PvoxPageEvidenceV1[]> {
  const pages: PvoxPageEvidenceV1[] = [];
  for (let byteOffset = 0, pageIndex = 0; byteOffset < bytes.byteLength; byteOffset += PVOX_PAGE_SIZE_BYTES, pageIndex += 1) {
    const page = bytes.subarray(byteOffset, byteOffset + PVOX_PAGE_SIZE_BYTES);
    if (page.byteLength !== PVOX_PAGE_SIZE_BYTES) throw new Error("PVOX pages must be complete 64-KiB records.");
    pages.push(Object.freeze({
      pageIndex,
      byteOffset,
      byteLength: PVOX_PAGE_SIZE_BYTES,
      sha256: await sha256(page),
    }));
  }
  return Object.freeze(pages);
}

async function hashPageSet(pages: readonly PvoxPageEvidenceV1[]): Promise<string> {
  return sha256(encodePvoxPageSetHashPreimageV1(pages.map((page) => ({
    pageIndex: page.pageIndex,
    byteOffset: BigInt(page.byteOffset),
    byteLength: page.byteLength,
    pageSha256: page.sha256,
  }))));
}

export async function compilePvoxStaticShellV1(
  input: PvoxStaticCompilerInputV1,
  options: PvoxCompileOptionsV1 = {},
): Promise<PvoxCompileResultV1> {
  const voxelization = voxelizeStaticShellV1(input, options);
  const { payloads, octree, spatial } = await buildSectionPayloads(voxelization);
  const directoryByteOffset = PVOX_HEADER_BYTE_LENGTH;
  const directoryByteLength = REQUIRED_STATIC_SECTIONS.length * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH;
  let sectionOffset = align(directoryByteOffset + directoryByteLength, PVOX_SECTION_ALIGNMENT_BYTES);
  const sections: BuiltSectionV1[] = [];
  for (const definition of REQUIRED_STATIC_SECTIONS) {
    const bytes = payloads.get(definition.name);
    if (!bytes) throw new Error(`Required section ${definition.name} was not compiled.`);
    const recordCount = sectionRecordCount(definition.name, voxelization, octree);
    const hash = await sha256(encodePvoxSectionHashPreimageV1(definition.type, definition.version, bytes));
    sections.push({ ...definition, bytes, recordCount, hash, byteOffset: sectionOffset });
    sectionOffset = align(sectionOffset + bytes.byteLength, PVOX_SECTION_ALIGNMENT_BYTES);
  }
  const directory = await createDirectoryBytes(sections);
  const artifactByteLength = align(sectionOffset, PVOX_PAGE_SIZE_BYTES);
  const pageCount = artifactByteLength / PVOX_PAGE_SIZE_BYTES;
  if (artifactByteLength > PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1 || pageCount > PVOX_STATIC_MAXIMUM_PAGES_V1) {
    throw new Error("Compiled PVOX artifact exceeds the static-preview artifact ceiling.");
  }
  const resolvedHashOptions = resolveCompileHashOptions(options);
  const compilationInputHash = await hashCompilationInput(voxelization, resolvedHashOptions);
  const runtimeRequestProfileHash = await hashRuntimeProfile();
  const header = encodePvoxRootHeaderV1({
    sectionCount: sections.length,
    artifactByteLength,
    directoryByteOffset,
    directoryByteLength,
    pageCount,
    maximumHierarchyDepth: octree.maximumDepth,
    geometryMode: "shell",
    fixedPointFractionBits: PVOX_FIXED_POINT_FRACTION_BITS_V1,
    quantizedBounds: spatial.bounds,
    directoryStartPage: 0,
    compilationInputHash,
    runtimeRequestProfileHash,
    directoryHash: directory.hash,
  });
  const bytes = new Uint8Array(artifactByteLength);
  writeBytes(bytes, 0, header);
  writeBytes(bytes, directoryByteOffset, directory.bytes);
  for (const section of sections) writeBytes(bytes, section.byteOffset, section.bytes);
  const artifactSha256 = await sha256(bytes);
  const pages = await pageEvidence(bytes);
  const pageSetHash = await hashPageSet(pages);
  const rootHash = await sha256(encodePvoxRootHashPreimageV1(header, sections.map((section) => ({
    sectionType: section.type,
    sectionVersion: section.version,
    sectionHash: section.hash,
  }))));
  const binaryClosureHash = await sha256(encodePvoxBinaryClosureHashPreimageV1({
    sourceContentHash: voxelization.sourceContentHash,
    canonicalDocumentHash: voxelization.canonicalDocumentHash,
    compilationInputHash,
    runtimeRequestProfileHash,
    artifactSha256,
    rootHash,
    directoryHash: directory.hash,
    pageSetHash,
  }));
  const sectionEvidence: readonly PvoxSectionEvidenceV1[] = Object.freeze(sections.map((section) => Object.freeze({
    type: section.type,
    version: section.version,
    byteOffset: section.byteOffset,
    byteLength: section.bytes.byteLength,
    recordBytes: section.recordBytes,
    recordCount: section.recordCount,
    sha256: section.hash,
  })));
  const evidence: PvoxCompilationEvidenceV1 = Object.freeze({
    format: "PVOX",
    formatVersion: "1.0",
    geometryMode: "shell",
    runtimeProfileId: "static-render-v1",
    artifactSha256,
    rootHash,
    directoryHash: directory.hash,
    pageSetHash,
    binaryClosureHash,
    compilationInputHash,
    runtimeRequestProfileHash,
    canonicalDocumentHash: voxelization.canonicalDocumentHash,
    sourceContentHash: voxelization.sourceContentHash,
    sectionEvidence,
    pageEvidence: pages,
    triangleCount: voxelization.triangleCount,
    occupiedVoxelCount: voxelization.voxels.length,
    brickCount: voxelization.bricks.length,
    gridDimensions: voxelization.gridDimensions,
    cellSizeMetres: dequantizeCoordinate(spatial.cellSize),
    fidelityWarnings: voxelization.fidelityWarnings,
  });
  await validatePvoxV1(bytes, {
    artifactSha256,
    sourceContentHash: voxelization.sourceContentHash,
    canonicalDocumentHash: voxelization.canonicalDocumentHash,
    binaryClosureHash,
  });
  return Object.freeze({ bytes, evidence });
}

function parseDirectory(bytes: Uint8Array, header: Uint8Array): readonly DirectoryRecordV1[] {
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const sectionCount = headerView.getUint16(PVOX_ROOT_HEADER_LAYOUT_V1.sectionCount.offset, true);
  const directoryByteOffset = Number(headerView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteOffset.offset, true));
  const directoryByteLength = Number(headerView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteLength.offset, true));
  if (!Number.isSafeInteger(directoryByteOffset) || !Number.isSafeInteger(directoryByteLength)
    || directoryByteOffset !== PVOX_HEADER_BYTE_LENGTH
    || directoryByteLength !== sectionCount * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH
    || directoryByteOffset + directoryByteLength > bytes.byteLength) {
    throw new Error("PVOX directory range is invalid.");
  }
  const directory = bytes.subarray(directoryByteOffset, directoryByteOffset + directoryByteLength);
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const records: DirectoryRecordV1[] = [];
  let previousKey = -1n;
  let previousEnd = directoryByteOffset + directoryByteLength;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = index * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH;
    const type = view.getUint32(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionType.offset, true);
    const version = view.getUint16(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionVersion.offset, true);
    const flags = view.getUint16(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.flags.offset, true);
    const key = (BigInt(type) << 16n) | BigInt(version);
    if (key <= previousKey) throw new Error("PVOX directory entries must be unique and strictly ordered.");
    previousKey = key;
    if (flags !== 0 || !isZeroRange(directory, offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.reserved.offset, offset + PVOX_DIRECTORY_ENTRY_BYTE_LENGTH)) {
      throw new Error("PVOX directory flags and reserved bytes must be zero.");
    }
    const definition = REQUIRED_STATIC_SECTIONS.find((candidate) => candidate.type === type && candidate.version === version);
    if (!definition) throw new Error("PVOX directory contains an unknown or unsupported section.");
    const byteOffset = Number(view.getBigUint64(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteOffset.offset, true));
    const byteLength = Number(view.getBigUint64(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteLength.offset, true));
    const recordBytes = view.getUint32(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.recordBytes.offset, true);
    const recordCount = view.getUint32(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.recordCount.offset, true);
    const minimumAlignedOffset = align(previousEnd, PVOX_SECTION_ALIGNMENT_BYTES);
    if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) || byteLength < 1
      || byteOffset % PVOX_SECTION_ALIGNMENT_BYTES !== 0 || byteOffset < minimumAlignedOffset
      || byteOffset + byteLength > bytes.byteLength || recordBytes !== definition.recordBytes
      || (recordBytes > 0 && byteLength !== recordBytes * recordCount)
      || (recordBytes === 0 && recordCount < 1)) {
      throw new Error(`PVOX ${definition.name} directory layout is invalid.`);
    }
    if (!isZeroRange(bytes, previousEnd, byteOffset)) throw new Error("PVOX inter-section padding must be zero.");
    const sha = Array.from(directory.subarray(offset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionHash.offset, offset + 64))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    records.push({ name: definition.name, type, version, byteOffset, byteLength, recordBytes, recordCount, sha256: sha });
    previousEnd = byteOffset + byteLength;
  }
  if (records.length !== REQUIRED_STATIC_SECTIONS.length
    || records.some((record) => !REQUIRED_SECTION_KEYS.has(`${record.type}:${record.version}`))) {
    throw new Error("PVOX required static section closure is incomplete.");
  }
  const finalSectionEnd = Math.max(...records.map((record) => record.byteOffset + record.byteLength));
  if (bytes.byteLength !== align(finalSectionEnd, PVOX_PAGE_SIZE_BYTES)) {
    throw new Error("PVOX artifact must use the minimal complete-page length for its section closure.");
  }
  if (!isZeroRange(bytes, finalSectionEnd, bytes.byteLength)) throw new Error("PVOX trailing bytes must be zero padding.");
  return Object.freeze(records);
}

function sectionBytes(bytes: Uint8Array, record: DirectoryRecordV1): Uint8Array {
  return bytes.subarray(record.byteOffset, record.byteOffset + record.byteLength);
}

function requireSection(records: readonly DirectoryRecordV1[], name: keyof typeof PVOX_SECTION_REGISTRY): DirectoryRecordV1 {
  const record = records.find((candidate) => candidate.name === name);
  if (!record) throw new Error(`PVOX section ${name} is missing.`);
  return record;
}

async function verifyDirectoryAndSections(
  bytes: Uint8Array,
  header: Uint8Array,
  records: readonly DirectoryRecordV1[],
): Promise<string> {
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const directoryOffset = Number(headerView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteOffset.offset, true));
  const directoryLength = Number(headerView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteLength.offset, true));
  const directoryBytes = bytes.subarray(directoryOffset, directoryOffset + directoryLength);
  const directoryHash = await sha256(encodePvoxDirectoryHashPreimageV1(records.length, directoryBytes));
  const declaredDirectoryHash = bytesToHex(header.subarray(
    PVOX_ROOT_HEADER_LAYOUT_V1.directoryHash.offset,
    PVOX_ROOT_HEADER_LAYOUT_V1.directoryHash.offset + PVOX_ROOT_HEADER_LAYOUT_V1.directoryHash.byteLength,
  ));
  if (directoryHash !== declaredDirectoryHash) throw new Error("PVOX directory hash is invalid.");
  for (const record of records) {
    const actual = await sha256(encodePvoxSectionHashPreimageV1(record.type, record.version, sectionBytes(bytes, record)));
    if (actual !== record.sha256) throw new Error(`PVOX ${record.name} section hash is invalid.`);
  }
  return directoryHash;
}

function parsePart(
  bytes: Uint8Array,
  record: DirectoryRecordV1,
  header: Uint8Array,
): {
  readonly origin: Vec3;
  readonly cellSizeMetres: number;
  readonly gridDimensions: readonly [number, number, number];
  readonly brickCount: number;
  readonly occupiedVoxelCount: number;
  readonly surfaceCount: number;
  readonly gridVoxelCapacity: number;
  readonly brickGridDimensions: readonly [number, number, number];
  readonly quantizedBounds: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
} {
  if (record.recordCount !== 1) throw new Error("PVOX PART must contain one record.");
  const part = sectionBytes(bytes, record);
  const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
  if (view.getUint32(0, true) !== 0 || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) {
    throw new Error("PVOX PART identity is invalid.");
  }
  const gridDimensions = [view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)] as const;
  if (gridDimensions.some((value) => value < 1 || value > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumLongestAxisCells)) {
    throw new Error("PVOX PART grid dimensions are invalid.");
  }
  const gridVoxelCapacity = gridDimensions[0] * gridDimensions[1] * gridDimensions[2];
  if (!Number.isSafeInteger(gridVoxelCapacity) || gridVoxelCapacity < 1 || gridVoxelCapacity > STATIC_MAXIMUM_GRID_VOXELS) {
    throw new Error("PVOX PART grid capacity exceeds the static-preview profile.");
  }
  const brickGridDimensions = gridDimensions.map((value) => Math.ceil(value / 8)) as [number, number, number];
  const gridBrickCapacity = brickGridDimensions[0] * brickGridDimensions[1] * brickGridDimensions[2];
  const brickCount = view.getUint32(20, true);
  const occupiedVoxelCount = view.getUint32(24, true);
  const surfaceCount = view.getUint32(28, true);
  if (brickCount < 1 || brickCount > STATIC_MAXIMUM_BRICKS || brickCount > gridBrickCapacity
    || occupiedVoxelCount < 1 || occupiedVoxelCount > STATIC_MAXIMUM_GRID_VOXELS
    || occupiedVoxelCount > gridVoxelCapacity
    || surfaceCount < 1 || surfaceCount > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials) {
    throw new Error("PVOX PART counts are invalid.");
  }
  const cellQuantized = view.getBigInt64(32, true);
  if (cellQuantized <= 0n || cellQuantized > QUANTIZED_COORDINATE_LIMIT * 2n) {
    throw new Error("PVOX PART cell size is invalid.");
  }
  const quantizedOrigin = [
    view.getBigInt64(40, true),
    view.getBigInt64(48, true),
    view.getBigInt64(56, true),
  ] as const;
  const quantizedBounds = [
    view.getBigInt64(64, true), view.getBigInt64(72, true), view.getBigInt64(80, true),
    view.getBigInt64(88, true), view.getBigInt64(96, true), view.getBigInt64(104, true),
  ] as const;
  for (let axis = 0; axis < 3; axis += 1) {
    requireQuantizedCoordinate(quantizedOrigin[axis]!, `PVOX PART origin[${axis}]`);
    requireQuantizedCoordinate(quantizedBounds[axis]!, `PVOX PART minimum[${axis}]`);
    requireQuantizedCoordinate(quantizedBounds[axis + 3]!, `PVOX PART maximum[${axis}]`);
    if (quantizedOrigin[axis] !== quantizedBounds[axis]
      || quantizedBounds[axis + 3] !== quantizedOrigin[axis]! + cellQuantized * BigInt(gridDimensions[axis]!)
      || quantizedBounds[axis + 3]! <= quantizedBounds[axis]!) {
      throw new Error("PVOX PART origin, grid, cell size and bounds are inconsistent.");
    }
  }
  if (!isZeroRange(part, 112, part.byteLength)) throw new Error("PVOX PART reserved bytes must be zero.");
  const headerBounds = Array.from({ length: 6 }, (_, index) => new DataView(header.buffer, header.byteOffset, header.byteLength)
    .getBigInt64(PVOX_ROOT_HEADER_LAYOUT_V1.quantizedBounds.offset + index * 8, true));
  if (headerBounds.some((value, index) => value !== quantizedBounds[index])) throw new Error("PVOX PART bounds do not match the root header.");
  const origin = quantizedOrigin.map(dequantizeCoordinate) as unknown as Vec3;
  return {
    origin,
    cellSizeMetres: dequantizeCoordinate(cellQuantized),
    gridDimensions,
    brickCount,
    occupiedVoxelCount,
    surfaceCount,
    gridVoxelCapacity,
    brickGridDimensions,
    quantizedBounds,
  };
}

function parseSurfaces(bytes: Uint8Array, record: DirectoryRecordV1, expectedCount: number): readonly PvoxDecodedSurfaceV1[] {
  if (record.recordCount !== expectedCount) throw new Error("PVOX SURF count does not match PART.");
  const section = sectionBytes(bytes, record);
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const output: PvoxDecodedSurfaceV1[] = [];
  for (let index = 0; index < record.recordCount; index += 1) {
    const offset = index * record.recordBytes;
    if (view.getUint32(offset, true) !== index || view.getUint16(offset + 22, true) !== 1
      || !isZeroRange(section, offset + 24, offset + record.recordBytes)) {
      throw new Error("PVOX SURF record is malformed.");
    }
    output.push(Object.freeze({
      surfaceIndex: index,
      baseColor: Object.freeze([
        section[offset + 4]! / 255,
        section[offset + 5]! / 255,
        section[offset + 6]! / 255,
        section[offset + 7]! / 255,
      ] as const),
      roughness: view.getUint16(offset + 8, true) / 65535,
      metallic: view.getUint16(offset + 10, true) / 65535,
      specular: view.getUint16(offset + 12, true) / 65535,
      emission: Object.freeze([
        view.getUint16(offset + 16, true) / 65535,
        view.getUint16(offset + 18, true) / 65535,
        view.getUint16(offset + 20, true) / 65535,
      ] as const),
    }));
  }
  return Object.freeze(output);
}

function validatePhysicalSections(bytes: Uint8Array, records: readonly DirectoryRecordV1[], surfaceCount: number): void {
  for (const name of ["PHYS", "PEVI", "REGN", "LAYR"] as const) {
    const record = requireSection(records, name);
    if (record.recordCount !== surfaceCount) throw new Error(`PVOX ${name} count does not match SURF.`);
    const section = sectionBytes(bytes, record);
    const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
    for (let index = 0; index < surfaceCount; index += 1) {
      const offset = index * record.recordBytes;
      if (view.getUint32(offset, true) !== index) throw new Error(`PVOX ${name} indexes are invalid.`);
      if ((name === "PHYS" || name === "PEVI")
        && (view.getUint16(offset + 4, true) !== 4 || view.getUint16(offset + 6, true) !== 0
          || !isZeroRange(section, offset + 8, offset + record.recordBytes))) {
        throw new Error(`PVOX ${name} demo evidence must remain explicit default/zero confidence.`);
      }
      if (name === "REGN" && (view.getUint32(offset + 4, true) !== index || view.getUint32(offset + 8, true) !== index
        || view.getUint32(offset + 12, true) !== index || view.getUint16(offset + 16, true) !== 1
        || view.getUint16(offset + 18, true) !== 1
        || !isZeroRange(section, offset + 20, offset + record.recordBytes))) {
        throw new Error("PVOX REGN linkage is invalid.");
      }
      if (name === "LAYR" && (view.getUint32(offset, true) !== index || view.getUint32(offset + 4, true) !== 0
        || view.getUint32(offset + 8, true) !== index || view.getUint32(offset + 12, true) !== index
        || view.getUint16(offset + 16, true) !== 4 || view.getUint16(offset + 18, true) !== 0
        || !isZeroRange(section, offset + 20, offset + record.recordBytes))) {
        throw new Error("PVOX LAYR demo evidence is invalid.");
      }
    }
  }
  const massRecord = requireSection(records, "MASS");
  const mass = sectionBytes(bytes, massRecord);
  const massView = new DataView(mass.buffer, mass.byteOffset, mass.byteLength);
  if (massRecord.recordCount !== 1 || massView.getUint32(0, true) !== 0
    || massView.getUint16(4, true) !== 4 || massView.getUint16(6, true) !== 0
    || !isZeroRange(mass, 8, mass.byteLength)) {
    throw new Error("PVOX MASS demo evidence is invalid.");
  }
}

function parseBrickPayload(
  payload: Uint8Array,
  occupiedCount: number,
  surfaces: readonly PvoxDecodedSurfaceV1[],
  brickCoordinates: readonly [number, number, number],
  origin: Vec3,
  cellSizeMetres: number,
  gridDimensions: readonly [number, number, number],
): readonly PvoxDecodedVoxelV1[] {
  if (payload.byteLength !== 128 + occupiedCount * PVOX_SURFACE_SAMPLE_BYTES_V1) {
    throw new Error("PVOX brick payload length is invalid.");
  }
  const occupancy = payload.subarray(0, 64);
  const active = payload.subarray(64, 128);
  if (!bytesEqual(occupancy, active) || popcountMask(occupancy) !== occupiedCount) {
    throw new Error("PVOX brick masks are inconsistent.");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const output: PvoxDecodedVoxelV1[] = [];
  let sampleIndex = 0;
  for (let localMorton = 0; localMorton < 512; localMorton += 1) {
    if ((occupancy[localMorton >>> 3]! & (1 << (localMorton & 7))) === 0) continue;
    const offset = 128 + sampleIndex * PVOX_SURFACE_SAMPLE_BYTES_V1;
    const surfaceIndex = view.getUint16(offset, true);
    if (surfaceIndex >= surfaces.length || view.getUint16(offset + 2, true) !== surfaceIndex
      || view.getUint16(offset + 14, true) !== 1) {
      throw new Error("PVOX surface sample linkage is invalid.");
    }
    const local = decodeMorton3(BigInt(localMorton), 3);
    const grid = [
      brickCoordinates[0] * 8 + local[0],
      brickCoordinates[1] * 8 + local[1],
      brickCoordinates[2] * 8 + local[2],
    ] as const;
    if (grid.some((coordinate, axis) => coordinate < 0 || coordinate >= gridDimensions[axis]!)) {
      throw new Error("PVOX surface sample lies outside the declared grid.");
    }
    const normal = [
      dequantizeSnorm16(view.getInt16(offset + 4, true)),
      dequantizeSnorm16(view.getInt16(offset + 6, true)),
      dequantizeSnorm16(view.getInt16(offset + 8, true)),
    ] as const;
    const normalLength = Math.hypot(...normal);
    if (normalLength < 0.9 || normalLength > 1.1) throw new Error("PVOX surface sample normal is invalid.");
    const coverage = view.getUint8(offset + 10);
    if (coverage === 0) throw new Error("PVOX occupied surface samples must have nonzero coverage.");
    output.push(Object.freeze({
      grid,
      centre: Object.freeze([
        origin[0] + (grid[0] + 0.5) * cellSizeMetres,
        origin[1] + (grid[1] + 0.5) * cellSizeMetres,
        origin[2] + (grid[2] + 0.5) * cellSizeMetres,
      ] as const),
      normal: Object.freeze(normal),
      surfaceIndex,
      coverage: coverage / 255,
    }));
    sampleIndex += 1;
  }
  if (sampleIndex !== occupiedCount) throw new Error("PVOX brick sample count is incomplete.");
  return Object.freeze(output);
}

interface ParsedBrickIdentityV1 {
  readonly brickIndex: number;
  readonly morton: bigint;
  readonly coordinates: readonly [number, number, number];
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly occupiedCount: number;
  readonly minimumSurface: number;
  readonly maximumSurface: number;
  readonly localMinimum: readonly [number, number, number];
  readonly localMaximum: readonly [number, number, number];
  readonly payloadHash: string;
}

async function parseBricks(
  bytes: Uint8Array,
  records: readonly DirectoryRecordV1[],
  part: ReturnType<typeof parsePart>,
  surfaces: readonly PvoxDecodedSurfaceV1[],
  maximumDepth: number,
): Promise<{
  readonly voxels: readonly PvoxDecodedVoxelV1[];
  readonly bricks: readonly ParsedBrickIdentityV1[];
}> {
  const brickRecord = requireSection(records, "BRIK");
  const dataRecord = requireSection(records, "DATA");
  if (brickRecord.recordCount !== part.brickCount || dataRecord.recordCount !== part.brickCount) {
    throw new Error("PVOX brick counts do not match PART.");
  }
  const bricks = sectionBytes(bytes, brickRecord);
  const data = sectionBytes(bytes, dataRecord);
  const exactDataLength = part.brickCount * 128 + part.occupiedVoxelCount * PVOX_SURFACE_SAMPLE_BYTES_V1;
  if (data.byteLength !== exactDataLength) throw new Error("PVOX DATA length is outside the static-preview profile.");
  const view = new DataView(bricks.buffer, bricks.byteOffset, bricks.byteLength);
  let previousMorton = -1n;
  let expectedDataOffset = 0;
  let occupiedTotal = 0;
  const descriptors: ParsedBrickIdentityV1[] = [];
  for (let index = 0; index < brickRecord.recordCount; index += 1) {
    const offset = index * brickRecord.recordBytes;
    const morton = view.getBigUint64(offset, true);
    const coordinates = [view.getInt32(offset + 8, true), view.getInt32(offset + 12, true), view.getInt32(offset + 16, true)] as const;
    if (morton <= previousMorton || morton !== morton3(...coordinates)
      || coordinates.some((coordinate, axis) => coordinate < 0 || coordinate >= part.brickGridDimensions[axis]!)
      || view.getUint16(offset + 20, true) !== 0 || view.getUint16(offset + 22, true) !== 1) {
      throw new Error("PVOX BRIK order or address is invalid.");
    }
    previousMorton = morton;
    const encodedDataOffset = view.getBigUint64(offset + 24, true);
    if (encodedDataOffset !== BigInt(expectedDataOffset)) throw new Error("PVOX BRIK data range is not canonical.");
    const dataOffset = Number(encodedDataOffset);
    const dataLength = view.getUint32(offset + 32, true);
    const occupiedCount = view.getUint16(offset + 36, true);
    const sampleCount = view.getUint16(offset + 38, true);
    const minimumSurface = view.getUint16(offset + 40, true);
    const maximumSurface = view.getUint16(offset + 42, true);
    const expectedPayloadLength = 128 + occupiedCount * PVOX_SURFACE_SAMPLE_BYTES_V1;
    const localMinimum = [bricks[offset + 80]!, bricks[offset + 81]!, bricks[offset + 82]!] as const;
    const localMaximum = [bricks[offset + 83]!, bricks[offset + 84]!, bricks[offset + 85]!] as const;
    if (dataLength !== expectedPayloadLength || dataLength > PVOX_MAX_ENCODED_BRICK_PAYLOAD_BYTES
      || dataOffset + dataLength > data.byteLength || occupiedCount < 1 || occupiedCount > 512
      || sampleCount !== occupiedCount || minimumSurface > maximumSurface || maximumSurface >= surfaces.length
      || localMinimum.some((value, axis) => value > 7 || value > localMaximum[axis]!)
      || localMaximum.some((value) => value > 7)
      || view.getUint16(offset + 44, true) !== PVOX_BRICK_PAYLOAD_CODEC_FIXED_V1
      || view.getUint16(offset + 46, true) !== 0 || !isZeroRange(bricks, offset + 86, offset + brickRecord.recordBytes)) {
      throw new Error("PVOX BRIK descriptor is invalid.");
    }
    occupiedTotal += occupiedCount;
    if (occupiedTotal > part.occupiedVoxelCount || occupiedTotal > STATIC_MAXIMUM_GRID_VOXELS) {
      throw new Error("PVOX BRIK samples exceed the static-preview voxel budget.");
    }
    descriptors.push(Object.freeze({
      brickIndex: index,
      morton,
      coordinates,
      dataOffset,
      dataLength,
      occupiedCount,
      minimumSurface,
      maximumSurface,
      localMinimum,
      localMaximum,
      payloadHash: bytesToHex(bricks.subarray(offset + 48, offset + 80)),
    }));
    expectedDataOffset += dataLength;
  }
  if (expectedDataOffset !== data.byteLength || occupiedTotal !== part.occupiedVoxelCount) {
    throw new Error("PVOX DATA closure does not match PART.");
  }
  validateHierarchy(bytes, records, descriptors, maximumDepth);
  const output: PvoxDecodedVoxelV1[] = [];
  for (const descriptor of descriptors) {
    const payload = data.subarray(descriptor.dataOffset, descriptor.dataOffset + descriptor.dataLength);
    if (await sha256(payload) !== descriptor.payloadHash) throw new Error("PVOX brick payload hash is invalid.");
    const voxels = parseBrickPayload(
      payload,
      descriptor.occupiedCount,
      surfaces,
      descriptor.coordinates,
      part.origin,
      part.cellSizeMetres,
      part.gridDimensions,
    );
    const actualMinimum = [8, 8, 8];
    const actualMaximum = [-1, -1, -1];
    let actualMinimumSurface = surfaces.length;
    let actualMaximumSurface = -1;
    for (const voxel of voxels) {
      for (let axis = 0; axis < 3; axis += 1) {
        const local = voxel.grid[axis]! & 7;
        actualMinimum[axis] = Math.min(actualMinimum[axis]!, local);
        actualMaximum[axis] = Math.max(actualMaximum[axis]!, local);
      }
      actualMinimumSurface = Math.min(actualMinimumSurface, voxel.surfaceIndex);
      actualMaximumSurface = Math.max(actualMaximumSurface, voxel.surfaceIndex);
      output.push(voxel);
    }
    if (actualMinimumSurface !== descriptor.minimumSurface || actualMaximumSurface !== descriptor.maximumSurface
      || actualMinimum.some((value, axis) => value !== descriptor.localMinimum[axis])
      || actualMaximum.some((value, axis) => value !== descriptor.localMaximum[axis])) {
      throw new Error("PVOX BRIK sample bounds or surface range are invalid.");
    }
  }
  if (output.length !== part.occupiedVoxelCount) throw new Error("PVOX decoded voxel count does not match PART.");
  return Object.freeze({ voxels: Object.freeze(output), bricks: Object.freeze(descriptors) });
}

function validateHierarchy(
  bytes: Uint8Array,
  records: readonly DirectoryRecordV1[],
  bricks: readonly ParsedBrickIdentityV1[],
  maximumDepth: number,
): void {
  const rootRecord = requireSection(records, "ROOT");
  const levelRecord = requireSection(records, "LEVL");
  const nodeRecord = requireSection(records, "NODE");
  const brickCount = bricks.length;
  const maximumBrickCoordinate = bricks.reduce((maximum, brick) => Math.max(
    maximum,
    brick.coordinates[0],
    brick.coordinates[1],
    brick.coordinates[2],
  ), 0);
  const expectedMaximumDepth = maximumBrickCoordinate === 0 ? 0 : Math.ceil(Math.log2(maximumBrickCoordinate + 1));
  let maximumNodeCount = 0;
  for (let depth = 0; depth <= maximumDepth; depth += 1) maximumNodeCount += Math.min(brickCount, 8 ** depth);
  if (maximumDepth !== expectedMaximumDepth || maximumDepth > STATIC_MAXIMUM_HIERARCHY_DEPTH
    || rootRecord.recordCount !== 1 || levelRecord.recordCount !== maximumDepth + 1
    || nodeRecord.recordCount < 1 || nodeRecord.recordCount > maximumNodeCount) {
    throw new Error("PVOX hierarchy counts are invalid.");
  }
  const root = sectionBytes(bytes, rootRecord);
  const rootView = new DataView(root.buffer, root.byteOffset, root.byteLength);
  if (rootView.getUint32(0, true) !== 0 || rootView.getUint16(4, true) !== 0
    || rootView.getUint8(6) !== maximumDepth || rootView.getUint8(7) !== 0
    || rootView.getUint32(8, true) !== 0
    || rootView.getUint32(12, true) !== nodeRecord.recordCount || rootView.getUint32(16, true) !== 0
    || rootView.getUint32(20, true) !== brickCount
    || !isZeroRange(root, 48, root.byteLength)) {
    throw new Error("PVOX ROOT record is invalid.");
  }
  for (let axis = 0; axis < 3; axis += 1) {
    let expectedMaximum = 0;
    for (const brick of bricks) expectedMaximum = Math.max(expectedMaximum, brick.coordinates[axis]! + 1);
    if (rootView.getInt32(24 + axis * 4, true) !== 0
      || rootView.getInt32(36 + axis * 4, true) !== expectedMaximum) {
      throw new Error("PVOX ROOT brick bounds are invalid.");
    }
  }
  const levels = sectionBytes(bytes, levelRecord);
  const levelView = new DataView(levels.buffer, levels.byteOffset, levels.byteLength);
  const levelSpans: Array<{ readonly nodeStart: number; readonly nodeCount: number }> = [];
  let expectedNodeStart = 0;
  for (let depth = 0; depth <= maximumDepth; depth += 1) {
    const offset = depth * levelRecord.recordBytes;
    const nodeStart = levelView.getUint32(offset + 8, true);
    const nodeCount = levelView.getUint32(offset + 12, true);
    const expectedBrickStart = depth === maximumDepth ? 0 : U32_MAX;
    const expectedBrickCount = depth === maximumDepth ? brickCount : 0;
    if (levelView.getUint32(offset, true) !== 0 || levelView.getUint16(offset + 4, true) !== 0
      || levelView.getUint8(offset + 6) !== depth || levelView.getUint8(offset + 7) !== 0
      || nodeStart !== expectedNodeStart || nodeCount < 1 || nodeCount > Math.min(brickCount, 8 ** depth)
      || levelView.getUint32(offset + 16, true) !== expectedBrickStart
      || levelView.getUint32(offset + 20, true) !== expectedBrickCount
      || !isZeroRange(levels, offset + 24, offset + levelRecord.recordBytes)) {
      throw new Error("PVOX LEVL record is invalid.");
    }
    levelSpans.push(Object.freeze({ nodeStart, nodeCount }));
    expectedNodeStart += nodeCount;
  }
  if (expectedNodeStart !== nodeRecord.recordCount) throw new Error("PVOX LEVL spans do not cover NODE.");
  const nodes = sectionBytes(bytes, nodeRecord);
  const nodeView = new DataView(nodes.buffer, nodes.byteOffset, nodes.byteLength);
  const parsedNodes: Array<{
    readonly index: number;
    readonly depth: number;
    readonly morton: bigint;
    readonly firstChild: number;
    readonly childCount: number;
    readonly brickIndex: number;
    readonly minimum: readonly [number, number, number];
    readonly maximum: readonly [number, number, number];
  }> = [];
  const leafBricks = new Set<number>();
  for (let depth = 0; depth <= maximumDepth; depth += 1) {
    const span = levelSpans[depth]!;
    let previousMorton = -1n;
    for (let relativeIndex = 0; relativeIndex < span.nodeCount; relativeIndex += 1) {
      const index = span.nodeStart + relativeIndex;
      const offset = index * nodeRecord.recordBytes;
      const morton = nodeView.getBigUint64(offset, true);
      const firstChild = nodeView.getUint32(offset + 8, true);
      const childCount = nodeView.getUint16(offset + 12, true);
      const encodedDepth = nodeView.getUint8(offset + 14);
      const flags = nodeView.getUint8(offset + 15);
      const brickIndex = nodeView.getUint32(offset + 16, true);
      const minimum = [
        nodeView.getUint16(offset + 20, true),
        nodeView.getUint16(offset + 22, true),
        nodeView.getUint16(offset + 24, true),
      ] as const;
      const maximum = [
        nodeView.getUint16(offset + 26, true),
        nodeView.getUint16(offset + 28, true),
        nodeView.getUint16(offset + 30, true),
      ] as const;
      const mortonLimit = 1n << BigInt(depth * 3);
      const decoded = decodeMorton3(morton, depth);
      const nodeSpan = 2 ** (maximumDepth - depth);
      const expectedMinimum = decoded.map((coordinate) => coordinate * nodeSpan);
      if (encodedDepth !== depth || morton <= previousMorton || morton >= mortonLimit || childCount > 8
        || minimum.some((value, axis) => value !== expectedMinimum[axis])
        || maximum.some((value, axis) => value !== expectedMinimum[axis]! + nodeSpan)
        || !isZeroRange(nodes, offset + 32, offset + nodeRecord.recordBytes)) {
        throw new Error("PVOX NODE Morton address, depth or bounds are invalid.");
      }
      previousMorton = morton;
      const leaf = depth === maximumDepth;
      if (leaf) {
        const brick = bricks[brickIndex];
        if (flags !== 1 || childCount !== 0 || firstChild !== U32_MAX || !brick || leafBricks.has(brickIndex)
          || morton !== brick.morton
          || minimum.some((value, axis) => value !== brick.coordinates[axis]!)
          || maximum.some((value, axis) => value !== brick.coordinates[axis]! + 1)) {
          throw new Error("PVOX NODE leaf does not identify its BRIK record.");
        }
        leafBricks.add(brickIndex);
      } else if (flags !== 0 || childCount < 1 || brickIndex !== U32_MAX) {
        throw new Error("PVOX NODE branch is invalid.");
      }
      parsedNodes.push(Object.freeze({ index, depth, morton, firstChild, childCount, brickIndex, minimum, maximum }));
    }
  }
  if (parsedNodes[0]?.depth !== 0 || parsedNodes[0].morton !== 0n || levelSpans[0]?.nodeCount !== 1
    || leafBricks.size !== brickCount) {
    throw new Error("PVOX NODE root or leaf closure is incomplete.");
  }
  const parentCounts = new Uint8Array(parsedNodes.length);
  for (const node of parsedNodes) {
    if (node.depth === maximumDepth) continue;
    const nextSpan = levelSpans[node.depth + 1]!;
    const children: typeof parsedNodes = [];
    for (let index = nextSpan.nodeStart; index < nextSpan.nodeStart + nextSpan.nodeCount; index += 1) {
      const candidate = parsedNodes[index]!;
      if ((candidate.morton >> 3n) === node.morton) children.push(candidate);
    }
    if (children.length !== node.childCount || children.length < 1 || node.firstChild !== children[0]!.index
      || children.some((child, childIndex) => child.index !== node.firstChild + childIndex
        || child.depth !== node.depth + 1
        || child.minimum.some((value, axis) => value < node.minimum[axis]! || child.maximum[axis]! > node.maximum[axis]!))) {
      throw new Error("PVOX NODE ancestry or child containment is invalid.");
    }
    for (const child of children) parentCounts[child.index] = parentCounts[child.index]! + 1;
  }
  if (parentCounts[0] !== 0 || parentCounts.some((count, index) => index > 0 && count !== 1)) {
    throw new Error("PVOX NODE parent closure is invalid.");
  }
}

function validateLods(bytes: Uint8Array, records: readonly DirectoryRecordV1[], part: ReturnType<typeof parsePart>): void {
  const record = requireSection(records, "LODS");
  const section = sectionBytes(bytes, record);
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  if (record.recordCount !== 1 || view.getUint32(0, true) !== 0 || view.getUint16(4, true) !== 0
    || view.getUint16(6, true) !== 1 || view.getUint32(8, true) !== part.gridDimensions[0]
    || view.getUint32(12, true) !== part.gridDimensions[1] || view.getUint32(16, true) !== part.gridDimensions[2]
    || view.getUint32(20, true) !== part.brickCount || view.getUint32(24, true) !== part.occupiedVoxelCount
    || view.getBigInt64(32, true) !== quantizeCoordinate(part.cellSizeMetres)
    || !isZeroRange(section, 40, section.byteLength)) {
    throw new Error("PVOX LODS record is invalid.");
  }
}

export async function validatePvoxV1(
  inputBytes: Uint8Array,
  expectations: PvoxValidationExpectationsV1 = {},
): Promise<PvoxDecodedV1> {
  if (!(inputBytes instanceof Uint8Array)) throw new Error("PVOX artifact must be a Uint8Array.");
  if (inputBytes.byteLength < PVOX_PAGE_SIZE_BYTES || inputBytes.byteLength % PVOX_PAGE_SIZE_BYTES !== 0
    || inputBytes.byteLength > PVOX_STATIC_MAXIMUM_ARTIFACT_BYTES_V1) {
    throw new Error("PVOX artifact byte length is invalid.");
  }
  const bytes = new Uint8Array(inputBytes.byteLength);
  bytes.set(inputBytes);
  const header = normalizePvoxRootHeaderForHashV1(bytes.subarray(0, PVOX_HEADER_BYTE_LENGTH));
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const declaredArtifactLength = Number(headerView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.artifactByteLength.offset, true));
  const pageCount = headerView.getUint32(PVOX_ROOT_HEADER_LAYOUT_V1.pageCount.offset, true);
  const maximumDepth = headerView.getUint8(PVOX_ROOT_HEADER_LAYOUT_V1.maximumHierarchyDepth.offset);
  if (declaredArtifactLength !== bytes.byteLength || pageCount !== bytes.byteLength / PVOX_PAGE_SIZE_BYTES
    || pageCount > PVOX_STATIC_MAXIMUM_PAGES_V1
    || maximumDepth > STATIC_MAXIMUM_HIERARCHY_DEPTH
    || headerView.getUint16(PVOX_ROOT_HEADER_LAYOUT_V1.sectionCount.offset, true) !== REQUIRED_STATIC_SECTIONS.length
    || headerView.getUint8(PVOX_ROOT_HEADER_LAYOUT_V1.geometryMode.offset) !== 2
    || headerView.getUint16(PVOX_ROOT_HEADER_LAYOUT_V1.fixedPointFractionBits.offset, true) !== PVOX_FIXED_POINT_FRACTION_BITS_V1) {
    throw new Error("PVOX root header is outside the static preview profile.");
  }
  const runtimeRequestProfileHash = bytesToHex(header.subarray(
    PVOX_ROOT_HEADER_LAYOUT_V1.runtimeRequestProfileHash.offset,
    PVOX_ROOT_HEADER_LAYOUT_V1.runtimeRequestProfileHash.offset + 32,
  ));
  if (runtimeRequestProfileHash !== await hashRuntimeProfile()) {
    throw new Error("PVOX runtime request profile hash is outside the static-render-v1 profile.");
  }
  const records = parseDirectory(bytes, header);
  const directoryHash = await verifyDirectoryAndSections(bytes, header, records);
  const part = parsePart(bytes, requireSection(records, "PART"), header);
  const surfaces = parseSurfaces(bytes, requireSection(records, "SURF"), part.surfaceCount);
  validatePhysicalSections(bytes, records, part.surfaceCount);
  validateLods(bytes, records, part);
  const parsedBricks = await parseBricks(bytes, records, part, surfaces, maximumDepth);
  const pages = await pageEvidence(bytes);
  const pageSetHash = await hashPageSet(pages);
  const rootHash = await sha256(encodePvoxRootHashPreimageV1(header, records.map((record) => ({
    sectionType: record.type,
    sectionVersion: record.version,
    sectionHash: record.sha256,
  }))));
  const artifactSha256 = await sha256(bytes);
  if (expectations.artifactSha256 !== undefined && artifactSha256 !== expectations.artifactSha256) {
    throw new Error("PVOX artifact hash does not match the expected content identity.");
  }
  const compilationInputHash = bytesToHex(header.subarray(
    PVOX_ROOT_HEADER_LAYOUT_V1.compilationInputHash.offset,
    PVOX_ROOT_HEADER_LAYOUT_V1.compilationInputHash.offset + 32,
  ));
  if ((expectations.sourceContentHash === undefined) !== (expectations.canonicalDocumentHash === undefined)) {
    throw new Error("Binary-closure validation requires both source and canonical-document hashes.");
  }
  if (expectations.sourceContentHash !== undefined && expectations.canonicalDocumentHash !== undefined) {
    decodePvoxSha256HexV1(expectations.sourceContentHash, "sourceContentHash");
    decodePvoxSha256HexV1(expectations.canonicalDocumentHash, "canonicalDocumentHash");
    const binaryClosureHash = await sha256(encodePvoxBinaryClosureHashPreimageV1({
      sourceContentHash: expectations.sourceContentHash,
      canonicalDocumentHash: expectations.canonicalDocumentHash,
      compilationInputHash,
      runtimeRequestProfileHash,
      artifactSha256,
      rootHash,
      directoryHash,
      pageSetHash,
    }));
    if (expectations.binaryClosureHash !== undefined && binaryClosureHash !== expectations.binaryClosureHash) {
      throw new Error("PVOX binary closure hash does not match.");
    }
  } else if (expectations.binaryClosureHash !== undefined) {
    throw new Error("Binary-closure expectation requires its source identities.");
  }
  return Object.freeze({
    artifactSha256,
    rootHash,
    directoryHash,
    pageSetHash,
    compilationInputHash,
    runtimeRequestProfileHash,
    geometryMode: "shell",
    fixedPointFractionBits: PVOX_FIXED_POINT_FRACTION_BITS_V1,
    quantizedBounds: part.quantizedBounds,
    origin: Object.freeze(part.origin),
    cellSizeMetres: part.cellSizeMetres,
    gridDimensions: Object.freeze(part.gridDimensions),
    surfaces,
    voxels: parsedBricks.voxels,
    sections: Object.freeze(records.map(({ name: _name, ...record }) => Object.freeze(record))),
    pages,
  });
}

export const decodePvoxV1 = validatePvoxV1;
