import {
  GPU_MODEL_STATIC_DEMO_MAX_ABSOLUTE_COORDINATE_METRES,
  GPU_MODEL_STATIC_DEMO_PROFILE_VERSION,
} from "@plasius/gpu-model-core";

import {
  assertFinite,
  assertRange,
  clamp01,
  morton3,
  quantizeSnorm16,
  quantizeUnorm8,
} from "./binary.js";
import type {
  PvoxCompileOptionsV1,
  PvoxStaticCompilerInputV1,
  PvoxStaticMaterialInputV1,
  PvoxStaticTriangleInputV1,
  Vec3,
} from "./types.js";

export const PVOX_STATIC_PREVIEW_LIMITS_V1 = Object.freeze({
  maximumTriangles: 200_000,
  maximumMaterials: 256,
  minimumLongestAxisCells: 8,
  defaultLongestAxisCells: 48,
  maximumLongestAxisCells: 64,
  defaultMaximumOccupiedVoxels: 262_144,
  absoluteMaximumOccupiedVoxels: 64 ** 3,
  maximumBricks: 8 ** 3,
  maximumHierarchyDepth: 3,
  defaultMaximumTriangleCellTests: 12_000_000,
  absoluteMaximumTriangleCellTests: 32_000_000,
} as const);

/** The only verified gpu-model-core projection accepted by this compiler. */
export const PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1 = GPU_MODEL_STATIC_DEMO_PROFILE_VERSION;

export interface NormalizedSurfaceV1 {
  readonly sourceMaterialIndex: number;
  readonly surfaceIndex: number;
  readonly baseColor: readonly [number, number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly specular: number;
  readonly emission: Vec3;
}

export interface VoxelSampleV1 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly normal: Vec3;
  readonly surfaceIndex: number;
  readonly coverage: number;
}

export interface BrickSampleV1 {
  readonly localMorton: number;
  readonly normal: Vec3;
  readonly surfaceIndex: number;
  readonly coverage: number;
}

export interface VoxelBrickV1 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly morton: bigint;
  readonly samples: readonly BrickSampleV1[];
}

export interface VoxelizationResultV1 {
  readonly profileVersion: typeof PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1;
  readonly sourceContentHash: string;
  readonly canonicalDocumentHash: string;
  readonly triangleCount: number;
  readonly surfaces: readonly NormalizedSurfaceV1[];
  readonly voxels: readonly VoxelSampleV1[];
  readonly bricks: readonly VoxelBrickV1[];
  readonly origin: Vec3;
  readonly cellSizeMetres: number;
  readonly gridDimensions: readonly [number, number, number];
  readonly bounds: {
    readonly minimum: Vec3;
    readonly maximum: Vec3;
  };
  readonly triangleCellTests: number;
  readonly fidelityWarnings: readonly string[];
}

interface MutableVoxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  surfaceIndex: number;
  hits: number;
}

interface PreparedTriangle {
  readonly source: PvoxStaticTriangleInputV1;
  readonly positions: readonly [Vec3, Vec3, Vec3];
  readonly normal: Vec3;
  readonly surfaceIndex: number;
  readonly sortValues: readonly number[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COORDINATE_TOLERANCE = 1e-6;

function requireDigest(value: string, fieldName: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${fieldName} must be a lowercase SHA-256 digest.`);
  return value;
}

function requireBoundedId(value: string, fieldName: string): string {
  const hasControl = typeof value === "string" && [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || codePoint === 127;
  });
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || hasControl) {
    throw new Error(`${fieldName} must be a bounded printable identifier.`);
  }
  return value;
}

function finiteVec3(value: Vec3, fieldName: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${fieldName} must contain three components.`);
  return [
    assertFinite(value[0], `${fieldName}[0]`),
    assertFinite(value[1], `${fieldName}[1]`),
    assertFinite(value[2], `${fieldName}[2]`),
  ];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function length(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value: Vec3, fieldName: string): Vec3 {
  const magnitude = length(value);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) throw new Error(`${fieldName} must be non-degenerate.`);
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude];
}

function validateCoordinate(value: number, fieldName: string): number {
  assertFinite(value, fieldName);
  if (Math.abs(value) > GPU_MODEL_STATIC_DEMO_MAX_ABSOLUTE_COORDINATE_METRES) {
    throw new Error(`${fieldName} exceeds the PVOX coordinate ceiling.`);
  }
  return value;
}

function normalizeSurfaces(materials: readonly PvoxStaticMaterialInputV1[]): {
  readonly surfaces: readonly NormalizedSurfaceV1[];
  readonly sourceToSurface: ReadonlyMap<number, number>;
} {
  if (!Array.isArray(materials) || materials.length < 1 || materials.length > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials) {
    throw new Error(`materials must contain from 1 through ${PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials} entries.`);
  }
  const sourceToSurface = new Map<number, number>();
  const surfaces = materials.map((material, surfaceIndex): NormalizedSurfaceV1 => {
    const materialIndex = surfaceIndex;
    sourceToSurface.set(materialIndex, surfaceIndex);
    if (material.sourceMaterialId !== null) requireBoundedId(material.sourceMaterialId, `materials[${surfaceIndex}].sourceMaterialId`);
    if (material.sourceMaterialName !== undefined) requireBoundedId(material.sourceMaterialName, `materials[${surfaceIndex}].sourceMaterialName`);
    if (material.sourceWorkflow !== "metallic-roughness" && material.sourceWorkflow !== "unlit") {
      throw new Error(`materials[${surfaceIndex}].sourceWorkflow is unsupported.`);
    }
    if (!Array.isArray(material.baseColorFactor) || material.baseColorFactor.length !== 4) {
      throw new Error(`materials[${surfaceIndex}].baseColorFactor must contain four components.`);
    }
    const baseColor = material.baseColorFactor.map((component: number) => clamp01(component)) as unknown as readonly [number, number, number, number];
    const emission = finiteVec3(material.emissiveFactor ?? [0, 0, 0], `materials[${surfaceIndex}].emissiveFactor`).map(clamp01) as unknown as Vec3;
    return Object.freeze({
      sourceMaterialIndex: materialIndex,
      surfaceIndex,
      baseColor,
      roughness: clamp01(material.roughnessFactor),
      metallic: clamp01(material.metallicFactor),
      specular: 0.5,
      emission,
    });
  });
  return { surfaces: Object.freeze(surfaces), sourceToSurface };
}

function prepareTriangles(
  triangles: readonly PvoxStaticTriangleInputV1[],
  sourceToSurface: ReadonlyMap<number, number>,
): readonly PreparedTriangle[] {
  if (!Array.isArray(triangles) || triangles.length < 1 || triangles.length > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumTriangles) {
    throw new Error(`worldTriangles must contain from 1 through ${PVOX_STATIC_PREVIEW_LIMITS_V1.maximumTriangles} entries.`);
  }
  const prepared = triangles.map((triangle, triangleIndex): PreparedTriangle => {
    if (!Array.isArray(triangle.positions) || triangle.positions.length !== 3
      || !Array.isArray(triangle.normals) || triangle.normals.length !== 3) {
      throw new Error(`worldTriangles[${triangleIndex}] must contain exactly three positions and normals.`);
    }
    const positions = triangle.positions.map((position: Vec3, vertexIndex: number) => {
      const result = finiteVec3(position, `worldTriangles[${triangleIndex}].positions[${vertexIndex}]`);
      result.forEach((component, axis) => validateCoordinate(component, `worldTriangles[${triangleIndex}].positions[${vertexIndex}][${axis}]`));
      return result;
    }) as unknown as readonly [Vec3, Vec3, Vec3];
    const edgeA = subtract(positions[1], positions[0]);
    const edgeB = subtract(positions[2], positions[0]);
    const faceNormal = normalize(cross(edgeA, edgeB), `worldTriangles[${triangleIndex}] geometry`);
    const vertexNormals = triangle.normals.map((normal: Vec3, vertexIndex: number) => {
      const checked = finiteVec3(normal, `worldTriangles[${triangleIndex}].normals[${vertexIndex}]`);
      return length(checked) <= 1e-12 ? faceNormal : normalize(checked, `worldTriangles[${triangleIndex}].normals[${vertexIndex}]`);
    });
    const averageNormal = normalize([
      vertexNormals[0]![0] + vertexNormals[1]![0] + vertexNormals[2]![0],
      vertexNormals[0]![1] + vertexNormals[1]![1] + vertexNormals[2]![1],
      vertexNormals[0]![2] + vertexNormals[1]![2] + vertexNormals[2]![2],
    ], `worldTriangles[${triangleIndex}] average normal`);
    const surfaceIndex = sourceToSurface.get(triangle.materialIndex);
    if (surfaceIndex === undefined) throw new Error(`worldTriangles[${triangleIndex}] references an unknown material index.`);
    const sortValues = [surfaceIndex, ...positions.flat(), ...averageNormal];
    return { source: triangle, positions, normal: averageNormal, surfaceIndex, sortValues };
  });
  prepared.sort((left, right) => {
    for (let index = 0; index < left.sortValues.length; index += 1) {
      const difference = left.sortValues[index]! - right.sortValues[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return prepared;
}

function calculateBounds(triangles: readonly PreparedTriangle[]): { minimum: Vec3; maximum: Vec3 } {
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const triangle of triangles) {
    for (const position of triangle.positions) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis]!, position[axis]!);
        maximum[axis] = Math.max(maximum[axis]!, position[axis]!);
      }
    }
  }
  return { minimum: minimum as unknown as Vec3, maximum: maximum as unknown as Vec3 };
}

function assertCanonicalBasis(input: PvoxStaticCompilerInputV1, calculatedBounds: { minimum: Vec3; maximum: Vec3 }): void {
  const expected = input.coordinateSystem;
  if (expected?.unit !== "metre" || expected.upAxis !== "y" || expected.forwardAxis !== "-z"
    || expected.handedness !== "right"
    || expected.winding !== "counter-clockwise" || expected.origin !== "floor-centred") {
    throw new Error("Compiler input must use metres, Y-up, -Z-forward, counter-clockwise, floor-centred coordinates.");
  }
  const suppliedMinimum = finiteVec3(input.bounds.min, "bounds.min");
  const suppliedMaximum = finiteVec3(input.bounds.max, "bounds.max");
  const diagonal = Math.max(1, Math.hypot(
    calculatedBounds.maximum[0] - calculatedBounds.minimum[0],
    calculatedBounds.maximum[1] - calculatedBounds.minimum[1],
    calculatedBounds.maximum[2] - calculatedBounds.minimum[2],
  ));
  const tolerance = diagonal * COORDINATE_TOLERANCE;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(suppliedMinimum[axis]! - calculatedBounds.minimum[axis]!) > tolerance
      || Math.abs(suppliedMaximum[axis]! - calculatedBounds.maximum[axis]!) > tolerance) {
      throw new Error("Supplied bounds do not match verified world triangles.");
    }
  }
  if (Math.abs(calculatedBounds.minimum[1]) > tolerance
    || Math.abs(calculatedBounds.minimum[0] + calculatedBounds.maximum[0]) > tolerance
    || Math.abs(calculatedBounds.minimum[2] + calculatedBounds.maximum[2]) > tolerance) {
    throw new Error("Compiler input is not floor-centred at the canonical origin.");
  }
}

function overlapsAxis(axis: Vec3, vertices: readonly [Vec3, Vec3, Vec3], half: Vec3): boolean {
  const axisLength = Math.abs(axis[0]) + Math.abs(axis[1]) + Math.abs(axis[2]);
  if (axisLength <= 1e-15) return true;
  const first = dot(vertices[0], axis);
  const second = dot(vertices[1], axis);
  const third = dot(vertices[2], axis);
  const minimum = Math.min(first, second, third);
  const maximum = Math.max(first, second, third);
  const radius = half[0] * Math.abs(axis[0]) + half[1] * Math.abs(axis[1]) + half[2] * Math.abs(axis[2]);
  return minimum <= radius && maximum >= -radius;
}

/** Conservative triangle/AABB SAT test used by the bounded shell voxeliser. */
export function triangleIntersectsBox(
  positions: readonly [Vec3, Vec3, Vec3],
  centre: Vec3,
  halfExtent: Vec3,
): boolean {
  const vertices = positions.map((position) => subtract(position, centre)) as unknown as readonly [Vec3, Vec3, Vec3];
  const edges = [
    subtract(vertices[1], vertices[0]),
    subtract(vertices[2], vertices[1]),
    subtract(vertices[0], vertices[2]),
  ] as const;
  const boxAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
  for (const axis of boxAxes) if (!overlapsAxis(axis, vertices, halfExtent)) return false;
  const triangleNormal = cross(edges[0], edges[1]);
  if (!overlapsAxis(triangleNormal, vertices, halfExtent)) return false;
  for (const edge of edges) {
    for (const boxAxis of boxAxes) if (!overlapsAxis(cross(edge, boxAxis), vertices, halfExtent)) return false;
  }
  return true;
}

function resolveOptions(options: PvoxCompileOptionsV1): {
  readonly longestAxisCells: number;
  readonly maximumOccupiedVoxels: number;
  readonly maximumTriangleCellTests: number;
  readonly runtimeProfileId: "static-render-v1";
} {
  const longestAxisCells = assertRange(
    options.longestAxisCells ?? PVOX_STATIC_PREVIEW_LIMITS_V1.defaultLongestAxisCells,
    PVOX_STATIC_PREVIEW_LIMITS_V1.minimumLongestAxisCells,
    PVOX_STATIC_PREVIEW_LIMITS_V1.maximumLongestAxisCells,
    "longestAxisCells",
  );
  const maximumOccupiedVoxels = assertRange(
    options.maximumOccupiedVoxels ?? PVOX_STATIC_PREVIEW_LIMITS_V1.defaultMaximumOccupiedVoxels,
    1,
    PVOX_STATIC_PREVIEW_LIMITS_V1.absoluteMaximumOccupiedVoxels,
    "maximumOccupiedVoxels",
  );
  const maximumTriangleCellTests = assertRange(
    options.maximumTriangleCellTests ?? PVOX_STATIC_PREVIEW_LIMITS_V1.defaultMaximumTriangleCellTests,
    1,
    PVOX_STATIC_PREVIEW_LIMITS_V1.absoluteMaximumTriangleCellTests,
    "maximumTriangleCellTests",
  );
  if ((options.runtimeProfileId ?? "static-render-v1") !== "static-render-v1") {
    throw new Error("The bounded compiler supports only static-render-v1.");
  }
  return { longestAxisCells, maximumOccupiedVoxels, maximumTriangleCellTests, runtimeProfileId: "static-render-v1" };
}

function addVoxel(
  voxels: Map<number, MutableVoxel>,
  x: number,
  y: number,
  z: number,
  grid: readonly [number, number, number],
  triangle: PreparedTriangle,
  maximumOccupiedVoxels: number,
): void {
  const index = x + grid[0] * (y + grid[1] * z);
  const existing = voxels.get(index);
  if (existing) {
    existing.normalX += triangle.normal[0];
    existing.normalY += triangle.normal[1];
    existing.normalZ += triangle.normal[2];
    existing.surfaceIndex = Math.min(existing.surfaceIndex, triangle.surfaceIndex);
    existing.hits += 1;
    return;
  }
  if (voxels.size >= maximumOccupiedVoxels) throw new Error("Voxelisation exceeds the occupied-voxel budget.");
  voxels.set(index, {
    x,
    y,
    z,
    normalX: triangle.normal[0],
    normalY: triangle.normal[1],
    normalZ: triangle.normal[2],
    surfaceIndex: triangle.surfaceIndex,
    hits: 1,
  });
}

function buildBricks(voxels: readonly VoxelSampleV1[]): readonly VoxelBrickV1[] {
  const bricks = new Map<string, { x: number; y: number; z: number; samples: BrickSampleV1[] }>();
  for (const voxel of voxels) {
    const brickX = Math.floor(voxel.x / 8);
    const brickY = Math.floor(voxel.y / 8);
    const brickZ = Math.floor(voxel.z / 8);
    const key = `${brickX}:${brickY}:${brickZ}`;
    let brick = bricks.get(key);
    if (!brick) {
      if (bricks.size >= PVOX_STATIC_PREVIEW_LIMITS_V1.maximumBricks) {
        throw new Error("Voxelisation exceeds the static-preview brick budget.");
      }
      brick = { x: brickX, y: brickY, z: brickZ, samples: [] };
      bricks.set(key, brick);
    }
    const localMorton = Number(morton3(voxel.x & 7, voxel.y & 7, voxel.z & 7));
    brick.samples.push({ localMorton, normal: voxel.normal, surfaceIndex: voxel.surfaceIndex, coverage: voxel.coverage });
  }
  const output = [...bricks.values()].map((brick): VoxelBrickV1 => {
    brick.samples.sort((left, right) => left.localMorton - right.localMorton);
    return Object.freeze({
      x: brick.x,
      y: brick.y,
      z: brick.z,
      morton: morton3(brick.x, brick.y, brick.z),
      samples: Object.freeze(brick.samples),
    });
  });
  output.sort((left, right) => left.morton < right.morton ? -1 : left.morton > right.morton ? 1 : 0);
  return Object.freeze(output);
}

export function encodeSurfaceSampleV1(sample: BrickSampleV1, surface: NormalizedSurfaceV1): Uint8Array {
  const output = new Uint8Array(16);
  const view = new DataView(output.buffer);
  view.setUint16(0, sample.surfaceIndex, true);
  view.setUint16(2, sample.surfaceIndex, true);
  view.setInt16(4, quantizeSnorm16(sample.normal[0]), true);
  view.setInt16(6, quantizeSnorm16(sample.normal[1]), true);
  view.setInt16(8, quantizeSnorm16(sample.normal[2]), true);
  view.setUint8(10, quantizeUnorm8(sample.coverage));
  view.setUint8(11, quantizeUnorm8(surface.roughness));
  view.setUint8(12, quantizeUnorm8(surface.metallic));
  view.setUint8(13, quantizeUnorm8(surface.specular));
  view.setUint16(14, 1, true);
  return output;
}

export function voxelizeStaticShellV1(
  input: PvoxStaticCompilerInputV1,
  options: PvoxCompileOptionsV1 = {},
): VoxelizationResultV1 {
  if (!input || typeof input !== "object") throw new Error("Compiler input is required.");
  if (input.profileVersion !== PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1) {
    throw new Error(`profileVersion must be ${PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1}.`);
  }
  if (!input.sourceEvidence || typeof input.sourceEvidence !== "object") throw new Error("sourceEvidence is required.");
  requireBoundedId(input.sourceEvidence.sourceFormat, "sourceEvidence.sourceFormat");
  requireBoundedId(input.sourceEvidence.converterId, "sourceEvidence.converterId");
  requireBoundedId(input.sourceEvidence.converterVersion, "sourceEvidence.converterVersion");
  if (input.sourceEvidence.provider !== undefined) requireBoundedId(input.sourceEvidence.provider, "sourceEvidence.provider");
  const sourceContentHash = requireDigest(input.sourceEvidence.sourceContentHash, "sourceEvidence.sourceContentHash");
  const canonicalDocumentHash = requireDigest(input.canonicalDocumentHash, "canonicalDocumentHash");
  const resolvedOptions = resolveOptions(options);
  const { surfaces, sourceToSurface } = normalizeSurfaces(input.materials);
  const triangles = prepareTriangles(input.worldTriangles, sourceToSurface);
  const calculatedBounds = calculateBounds(triangles);
  assertCanonicalBasis(input, calculatedBounds);

  const extents: Vec3 = [
    calculatedBounds.maximum[0] - calculatedBounds.minimum[0],
    calculatedBounds.maximum[1] - calculatedBounds.minimum[1],
    calculatedBounds.maximum[2] - calculatedBounds.minimum[2],
  ];
  const longestExtent = Math.max(extents[0], extents[1], extents[2]);
  if (!Number.isFinite(longestExtent) || longestExtent <= 1e-9) throw new Error("Model bounds are degenerate.");
  const cellSizeMetres = longestExtent / resolvedOptions.longestAxisCells;
  const dimensions = extents.map((extent) => Math.max(1, Math.ceil(extent / cellSizeMetres))) as unknown as [number, number, number];
  if (dimensions.some((dimension) => dimension > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumLongestAxisCells)) {
    throw new Error("Voxel grid exceeds the bounded preview dimensions.");
  }
  const origin = extents.map((extent, axis) => extent < cellSizeMetres
    ? calculatedBounds.minimum[axis]! - (cellSizeMetres - extent) / 2
    : calculatedBounds.minimum[axis]!) as unknown as Vec3;
  const artifactMaximum: Vec3 = [
    origin[0] + dimensions[0] * cellSizeMetres,
    origin[1] + dimensions[1] * cellSizeMetres,
    origin[2] + dimensions[2] * cellSizeMetres,
  ];
  for (let axis = 0; axis < 3; axis += 1) {
    validateCoordinate(origin[axis]!, `PVOX origin[${axis}]`);
    validateCoordinate(artifactMaximum[axis]!, `PVOX maximum[${axis}]`);
  }

  const voxels = new Map<number, MutableVoxel>();
  let triangleCellTests = 0;
  const halfExtent: Vec3 = [cellSizeMetres / 2, cellSizeMetres / 2, cellSizeMetres / 2];
  for (const triangle of triangles) {
    const triangleMinimum = [0, 1, 2].map((axis) => Math.min(...triangle.positions.map((position) => position[axis]!)));
    const triangleMaximum = [0, 1, 2].map((axis) => Math.max(...triangle.positions.map((position) => position[axis]!)));
    const minimumCell = triangleMinimum.map((value, axis) => Math.max(0, Math.floor((value - origin[axis]!) / cellSizeMetres) - 1));
    const maximumCell = triangleMaximum.map((value, axis) => Math.min(dimensions[axis]! - 1, Math.floor((value - origin[axis]!) / cellSizeMetres) + 1));
    for (let z = minimumCell[2]!; z <= maximumCell[2]!; z += 1) {
      for (let y = minimumCell[1]!; y <= maximumCell[1]!; y += 1) {
        for (let x = minimumCell[0]!; x <= maximumCell[0]!; x += 1) {
          triangleCellTests += 1;
          if (triangleCellTests > resolvedOptions.maximumTriangleCellTests) {
            throw new Error("Voxelisation exceeds the triangle/cell test budget.");
          }
          const centre: Vec3 = [
            origin[0] + (x + 0.5) * cellSizeMetres,
            origin[1] + (y + 0.5) * cellSizeMetres,
            origin[2] + (z + 0.5) * cellSizeMetres,
          ];
          if (triangleIntersectsBox(triangle.positions, centre, halfExtent)) {
            addVoxel(voxels, x, y, z, dimensions, triangle, resolvedOptions.maximumOccupiedVoxels);
          }
        }
      }
    }
  }
  if (voxels.size === 0) throw new Error("Voxelisation produced no surface samples.");

  const orderedVoxels = [...voxels.values()].map((voxel): VoxelSampleV1 => {
    const normal = normalize([voxel.normalX, voxel.normalY, voxel.normalZ], "voxel normal");
    return Object.freeze({
      x: voxel.x,
      y: voxel.y,
      z: voxel.z,
      normal,
      surfaceIndex: voxel.surfaceIndex,
      coverage: Math.min(1, 0.5 + Math.log2(voxel.hits + 1) / 8),
    });
  });
  orderedVoxels.sort((left, right) => {
    const leftMorton = morton3(left.x, left.y, left.z);
    const rightMorton = morton3(right.x, right.y, right.z);
    return leftMorton < rightMorton ? -1 : leftMorton > rightMorton ? 1 : 0;
  });
  const bricks = buildBricks(orderedVoxels);
  const fidelityWarnings = [
    "bounded-static-preview-shell",
    "lod0-only",
    "texture-input-unsupported",
    "physical-properties-default-not-world-editable",
    "native-gpu-sparse-traversal-not-qualified",
  ] as const;
  return Object.freeze({
    profileVersion: PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1,
    sourceContentHash,
    canonicalDocumentHash,
    triangleCount: triangles.length,
    surfaces,
    voxels: Object.freeze(orderedVoxels),
    bricks,
    origin,
    cellSizeMetres,
    gridDimensions: Object.freeze(dimensions),
    bounds: Object.freeze({ minimum: origin, maximum: artifactMaximum }),
    triangleCellTests,
    fidelityWarnings,
  });
}
