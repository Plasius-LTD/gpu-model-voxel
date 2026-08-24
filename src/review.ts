import { zlibSync } from "fflate";

import { concatenate, sha256 } from "./binary.js";
import { validatePvoxV1 } from "./pvox.js";
import { createPvoxSurfaceMeshV1 } from "./surface-mesh.js";
import type {
  PvoxDecodedV1,
  PvoxReviewOptionsV1,
  PvoxReviewViewNameV1,
  PvoxReviewViewV1,
  Vec3,
} from "./types.js";

export const PVOX_REVIEW_VIEW_ORDER_V1 = Object.freeze([
  "front",
  "left",
  "top",
  "isometric",
] as const satisfies readonly PvoxReviewViewNameV1[]);

interface ViewBasis {
  readonly horizontal: Vec3;
  readonly vertical: Vec3;
  readonly depth: Vec3;
}

const BASES: Readonly<Record<PvoxReviewViewNameV1, ViewBasis>> = Object.freeze({
  front: Object.freeze({ horizontal: [1, 0, 0] as Vec3, vertical: [0, 1, 0] as Vec3, depth: [0, 0, 1] as Vec3 }),
  left: Object.freeze({ horizontal: [0, 0, -1] as Vec3, vertical: [0, 1, 0] as Vec3, depth: [-1, 0, 0] as Vec3 }),
  top: Object.freeze({ horizontal: [1, 0, 0] as Vec3, vertical: [0, 0, -1] as Vec3, depth: [0, 1, 0] as Vec3 }),
  isometric: Object.freeze({
    horizontal: [Math.SQRT1_2, 0, -Math.SQRT1_2] as Vec3,
    vertical: [-0.3481553119113957, 0.8703882797784892, -0.3481553119113957] as Vec3,
    depth: [0.6154574548966637, 0.49236596391733095, 0.6154574548966637] as Vec3,
  }),
});

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength, false);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(concatenate([typeBytes, data])), false);
  return output;
}

function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const destination = y * (1 + width * 4);
    scanlines[destination] = 0;
    scanlines.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), destination + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concatenate([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibSync(scanlines, { level: 6 })),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function project(position: Vec3, basis: ViewBasis): readonly [number, number, number] {
  return [dot(position, basis.horizontal), dot(position, basis.vertical), dot(position, basis.depth)];
}

function boundsCorners(minimum: Vec3, maximum: Vec3): readonly Vec3[] {
  const output: Vec3[] = [];
  for (const x of [minimum[0], maximum[0]]) {
    for (const y of [minimum[1], maximum[1]]) {
      for (const z of [minimum[2], maximum[2]]) output.push([x, y, z]);
    }
  }
  return output;
}

function edge(a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): number {
  return (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
}

function renderView(
  decoded: PvoxDecodedV1,
  name: PvoxReviewViewNameV1,
  width: number,
  height: number,
  background: readonly [number, number, number, number],
): Uint8Array {
  const mesh = createPvoxSurfaceMeshV1(decoded);
  const basis = BASES[name];
  const projectedBounds = boundsCorners(mesh.bounds.minimum, mesh.bounds.maximum).map((corner) => project(corner, basis));
  const minimumU = Math.min(...projectedBounds.map((value) => value[0]));
  const maximumU = Math.max(...projectedBounds.map((value) => value[0]));
  const minimumV = Math.min(...projectedBounds.map((value) => value[1]));
  const maximumV = Math.max(...projectedBounds.map((value) => value[1]));
  const spanU = Math.max(1e-9, maximumU - minimumU);
  const spanV = Math.max(1e-9, maximumV - minimumV);
  const margin = Math.max(4, Math.floor(Math.min(width, height) * 0.07));
  const scale = Math.min((width - 2 * margin) / spanU, (height - 2 * margin) / spanV);
  const centreU = (minimumU + maximumU) / 2;
  const centreV = (minimumV + maximumV) / 2;
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) pixels.set(background, index * 4);
  const depthBuffer = new Float64Array(width * height);
  depthBuffer.fill(Number.NEGATIVE_INFINITY);
  const light = name === "top" ? [0.25, 0.85, 0.45] as const : [-0.35, 0.75, 0.55] as const;
  const toScreen = (position: Vec3): readonly [number, number, number] => {
    const value = project(position, basis);
    return [
      width / 2 + (value[0] - centreU) * scale,
      height / 2 - (value[1] - centreV) * scale,
      value[2],
    ];
  };
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const vertexIndices = [mesh.indices[triangle]!, mesh.indices[triangle + 1]!, mesh.indices[triangle + 2]!] as const;
    const positions = vertexIndices.map((vertexIndex) => [
      mesh.positions[vertexIndex * 3]!,
      mesh.positions[vertexIndex * 3 + 1]!,
      mesh.positions[vertexIndex * 3 + 2]!,
    ] as Vec3);
    const screen = positions.map(toScreen) as unknown as readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
    const a = [screen[0][0], screen[0][1]] as const;
    const b = [screen[1][0], screen[1][1]] as const;
    const c = [screen[2][0], screen[2][1]] as const;
    const area = edge(a, b, c);
    if (Math.abs(area) < 1e-12) continue;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const normal: Vec3 = [mesh.normals[vertexIndices[0] * 3]!, mesh.normals[vertexIndices[0] * 3 + 1]!, mesh.normals[vertexIndices[0] * 3 + 2]!];
    const lightAmount = Math.max(0, dot(normal, light));
    const shade = 0.48 + lightAmount * 0.52;
    const color = [
      mesh.colors[vertexIndices[0] * 4]!,
      mesh.colors[vertexIndices[0] * 4 + 1]!,
      mesh.colors[vertexIndices[0] * 4 + 2]!,
      mesh.colors[vertexIndices[0] * 4 + 3]!,
    ];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const point = [x + 0.5, y + 0.5] as const;
        const weightA = edge(b, c, point) / area;
        const weightB = edge(c, a, point) / area;
        const weightC = 1 - weightA - weightB;
        if (weightA < -1e-8 || weightB < -1e-8 || weightC < -1e-8) continue;
        const depth = weightA * screen[0][2] + weightB * screen[1][2] + weightC * screen[2][2];
        const pixelIndex = y * width + x;
        if (depth <= depthBuffer[pixelIndex]!) continue;
        depthBuffer[pixelIndex] = depth;
        const offset = pixelIndex * 4;
        const alpha = Math.min(1, Math.max(0.08, color[3]!));
        for (let channel = 0; channel < 3; channel += 1) {
          const shaded = Math.round(Math.min(1, color[channel]! * shade) * 255);
          pixels[offset + channel] = Math.round(shaded * alpha + background[channel]! * (1 - alpha));
        }
        pixels[offset + 3] = 255;
      }
    }
  }
  return encodePng(width, height, pixels);
}

export async function renderPvoxReviewViewsV1(
  input: Uint8Array | PvoxDecodedV1,
  options: PvoxReviewOptionsV1 = {},
): Promise<readonly PvoxReviewViewV1[]> {
  const width = options.width ?? 512;
  const height = options.height ?? 512;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width > 1024 || height > 1024) {
    throw new Error("PVOX review dimensions must be safe integers from 64 through 1024.");
  }
  const background = options.background ?? [238, 241, 246, 255];
  if (!Array.isArray(background) || background.length !== 4 || background.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 255)) {
    throw new Error("PVOX review background must contain four byte values.");
  }
  const decoded = input instanceof Uint8Array ? await validatePvoxV1(input) : input;
  const views: PvoxReviewViewV1[] = [];
  for (const name of PVOX_REVIEW_VIEW_ORDER_V1) {
    const bytes = renderView(decoded, name, width, height, background);
    views.push(Object.freeze({ name, width, height, contentType: "image/png", bytes, sha256: await sha256(bytes) }));
  }
  return Object.freeze(views);
}
