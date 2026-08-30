import { PVOX_MAX_ABSOLUTE_COORDINATE_METRES } from "@plasius/asset-contracts";

import type {
  PvoxDecodedV1,
  PvoxSurfaceMeshV1,
  Vec3,
} from "./types.js";
import { PVOX_STATIC_PREVIEW_LIMITS_V1 } from "./voxelize.js";

export interface PvoxSurfaceMeshOptionsV1 {
  readonly maximumFaces?: number;
}

const FACE_DEFINITIONS = Object.freeze([
  { delta: [1, 0, 0] as const, normal: [1, 0, 0] as const, u: [0, 1, 0] as const, v: [0, 0, 1] as const },
  { delta: [-1, 0, 0] as const, normal: [-1, 0, 0] as const, u: [0, 0, 1] as const, v: [0, 1, 0] as const },
  { delta: [0, 1, 0] as const, normal: [0, 1, 0] as const, u: [0, 0, 1] as const, v: [1, 0, 0] as const },
  { delta: [0, -1, 0] as const, normal: [0, -1, 0] as const, u: [1, 0, 0] as const, v: [0, 0, 1] as const },
  { delta: [0, 0, 1] as const, normal: [0, 0, 1] as const, u: [1, 0, 0] as const, v: [0, 1, 0] as const },
  { delta: [0, 0, -1] as const, normal: [0, 0, -1] as const, u: [0, 1, 0] as const, v: [1, 0, 0] as const },
] as const);

function key(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

function corner(centre: Vec3, normal: Vec3, u: Vec3, v: Vec3, uSign: number, vSign: number, half: number): Vec3 {
  return [
    centre[0] + (normal[0] + u[0] * uSign + v[0] * vSign) * half,
    centre[1] + (normal[1] + u[1] * uSign + v[1] * vSign) * half,
    centre[2] + (normal[2] + u[2] * uSign + v[2] * vSign) * half,
  ];
}

function preflightDecoded(decoded: PvoxDecodedV1): Set<string> {
  if (!decoded || typeof decoded !== "object" || !/^[0-9a-f]{64}$/u.test(decoded.artifactSha256)
    || !Array.isArray(decoded.gridDimensions) || decoded.gridDimensions.length !== 3
    || decoded.gridDimensions.some((dimension) => !Number.isSafeInteger(dimension)
      || dimension < 1 || dimension > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumLongestAxisCells)
    || !Number.isFinite(decoded.cellSizeMetres) || decoded.cellSizeMetres <= 0
    || decoded.cellSizeMetres > PVOX_MAX_ABSOLUTE_COORDINATE_METRES * 2
    || !Array.isArray(decoded.origin) || decoded.origin.length !== 3
    || decoded.origin.some((coordinate, axis) => !Number.isFinite(coordinate)
      || Math.abs(coordinate) > PVOX_MAX_ABSOLUTE_COORDINATE_METRES
      || Math.abs(coordinate + decoded.gridDimensions[axis]! * decoded.cellSizeMetres) > PVOX_MAX_ABSOLUTE_COORDINATE_METRES)
    || !Array.isArray(decoded.surfaces) || decoded.surfaces.length < 1
    || decoded.surfaces.length > PVOX_STATIC_PREVIEW_LIMITS_V1.maximumMaterials
    || decoded.surfaces.some((surface, surfaceIndex) => !surface || surface.surfaceIndex !== surfaceIndex
      || !Array.isArray(surface.baseColor) || surface.baseColor.length !== 4
      || surface.baseColor.some((component: number) => !Number.isFinite(component) || component < 0 || component > 1))
    || !Array.isArray(decoded.voxels) || decoded.voxels.length < 1
    || decoded.voxels.length > PVOX_STATIC_PREVIEW_LIMITS_V1.absoluteMaximumOccupiedVoxels) {
    throw new Error("Decoded PVOX is outside the bounded static-preview profile.");
  }
  const gridCapacity = decoded.gridDimensions[0] * decoded.gridDimensions[1] * decoded.gridDimensions[2];
  if (decoded.voxels.length > gridCapacity) throw new Error("Decoded PVOX exceeds its declared grid capacity.");
  const occupied = new Set<string>();
  const centreTolerance = Math.max(1e-9, decoded.cellSizeMetres * 1e-9);
  for (const voxel of decoded.voxels) {
    if (!voxel || !Array.isArray(voxel.grid) || voxel.grid.length !== 3
      || voxel.grid.some((coordinate: number, axis: number) => !Number.isSafeInteger(coordinate)
        || coordinate < 0 || coordinate >= decoded.gridDimensions[axis]!)
      || !Array.isArray(voxel.centre) || voxel.centre.length !== 3
      || voxel.centre.some((coordinate: number, axis: number) => !Number.isFinite(coordinate)
        || Math.abs(coordinate - (decoded.origin[axis]! + (voxel.grid[axis]! + 0.5) * decoded.cellSizeMetres)) > centreTolerance)
      || !Number.isSafeInteger(voxel.surfaceIndex) || voxel.surfaceIndex < 0 || voxel.surfaceIndex >= decoded.surfaces.length) {
      throw new Error("Decoded PVOX contains an invalid voxel sample.");
    }
    const voxelKey = key(voxel.grid[0], voxel.grid[1], voxel.grid[2]);
    if (occupied.has(voxelKey)) throw new Error("Decoded PVOX contains a duplicate voxel address.");
    occupied.add(voxelKey);
  }
  return occupied;
}

/** Creates a disposable triangle cache solely from independently decoded PVOX voxels. */
export function createPvoxSurfaceMeshV1(
  decoded: PvoxDecodedV1,
  options: PvoxSurfaceMeshOptionsV1 = {},
): PvoxSurfaceMeshV1 {
  const maximumFaces = options.maximumFaces ?? 500_000;
  if (!Number.isSafeInteger(maximumFaces) || maximumFaces < 1 || maximumFaces > 2_000_000) {
    throw new Error("maximumFaces must be a bounded positive integer.");
  }
  const occupied = preflightDecoded(decoded);
  const half = decoded.cellSizeMetres / 2;
  let faceCount = 0;
  for (const voxel of decoded.voxels) {
    for (const face of FACE_DEFINITIONS) {
      if (!occupied.has(key(
        voxel.grid[0] + face.delta[0],
        voxel.grid[1] + face.delta[1],
        voxel.grid[2] + face.delta[2],
      ))) faceCount += 1;
      if (faceCount > maximumFaces) throw new Error("PVOX-derived surface cache exceeds the face budget.");
    }
  }
  if (faceCount === 0) throw new Error("PVOX-derived surface cache contains no exposed faces.");
  const positions = new Float32Array(faceCount * 4 * 3);
  const normals = new Float32Array(faceCount * 4 * 3);
  const colors = new Float32Array(faceCount * 4 * 4);
  const surfaceIndices = new Uint32Array(faceCount * 4);
  const indices = new Uint32Array(faceCount * 6);
  let emittedFaceCount = 0;
  for (const voxel of decoded.voxels) {
    const surface = decoded.surfaces[voxel.surfaceIndex];
    if (!surface) throw new Error("Decoded voxel references an unknown surface.");
    for (const face of FACE_DEFINITIONS) {
      if (occupied.has(key(
        voxel.grid[0] + face.delta[0],
        voxel.grid[1] + face.delta[1],
        voxel.grid[2] + face.delta[2],
      ))) continue;
      const baseVertex = emittedFaceCount * 4;
      const corners = [
        corner(voxel.centre, face.normal, face.u, face.v, -1, -1, half),
        corner(voxel.centre, face.normal, face.u, face.v, 1, -1, half),
        corner(voxel.centre, face.normal, face.u, face.v, 1, 1, half),
        corner(voxel.centre, face.normal, face.u, face.v, -1, 1, half),
      ];
      for (let cornerIndex = 0; cornerIndex < corners.length; cornerIndex += 1) {
        const position = corners[cornerIndex]!;
        for (let axis = 0; axis < 3; axis += 1) {
          positions[(baseVertex + cornerIndex) * 3 + axis] = position[axis]!;
          normals[(baseVertex + cornerIndex) * 3 + axis] = face.normal[axis]!;
        }
        for (let channel = 0; channel < 4; channel += 1) {
          colors[(baseVertex + cornerIndex) * 4 + channel] = surface.baseColor[channel]!;
        }
        surfaceIndices[baseVertex + cornerIndex] = surface.surfaceIndex;
      }
      const indexOffset = emittedFaceCount * 6;
      indices.set([baseVertex, baseVertex + 1, baseVertex + 2, baseVertex, baseVertex + 2, baseVertex + 3], indexOffset);
      emittedFaceCount += 1;
    }
  }
  if (emittedFaceCount !== faceCount) throw new Error("PVOX-derived surface cache face closure is inconsistent.");
  const mutableMinimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const mutableMaximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const voxel of decoded.voxels) {
    for (let axis = 0; axis < 3; axis += 1) {
      mutableMinimum[axis] = Math.min(mutableMinimum[axis]!, voxel.centre[axis]! - half);
      mutableMaximum[axis] = Math.max(mutableMaximum[axis]!, voxel.centre[axis]! + half);
    }
  }
  const minimum: Vec3 = [mutableMinimum[0]!, mutableMinimum[1]!, mutableMinimum[2]!];
  const maximum: Vec3 = [mutableMaximum[0]!, mutableMaximum[1]!, mutableMaximum[2]!];
  return Object.freeze({
    representation: "pvox-derived-surface-cache",
    sourceArtifactSha256: decoded.artifactSha256,
    positions,
    normals,
    colors,
    surfaceIndices,
    indices,
    triangleCount: indices.length / 3,
    bounds: Object.freeze({ minimum: Object.freeze(minimum), maximum: Object.freeze(maximum) }),
  });
}
