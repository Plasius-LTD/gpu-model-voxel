import {
  PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1,
  triangleIntersectsBox,
  voxelizeStaticShellV1,
} from "../src/index.js";
import { cubeCompilerInput } from "./fixtures.js";

describe("static shell voxelisation", () => {
  it("uses a conservative triangle/AABB SAT test", () => {
    const triangle = [[-0.25, 0, -0.25], [0.25, 0, -0.25], [0, 0, 0.25]] as const;
    expect(triangleIntersectsBox(triangle, [0, 0, 0], [0.5, 0.5, 0.5])).toBe(true);
    expect(triangleIntersectsBox(triangle, [4, 4, 4], [0.5, 0.5, 0.5])).toBe(false);
  });

  it("creates Morton-ordered bounded shell bricks", () => {
    const result = voxelizeStaticShellV1(cubeCompilerInput(), { longestAxisCells: 8 });
    expect(result.triangleCount).toBe(12);
    expect(result.gridDimensions).toEqual([8, 8, 8]);
    expect(result.voxels.length).toBeGreaterThan(100);
    expect(result.voxels.length).toBeLessThanOrEqual(512);
    expect(result.bricks).toHaveLength(1);
    expect(result.bricks[0]!.samples.length).toBe(result.voxels.length);
    expect(result.fidelityWarnings).toContain("lod0-only");
    expect(result.profileVersion).toBe(PVOX_STATIC_COMPILER_INPUT_PROFILE_VERSION_V1);
  });

  it.each([
    ["disabled runtime profile", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1(input, { runtimeProfileId: "world-editable-v1" as never })],
    ["unverified compiler profile", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1({ ...input, profileVersion: "plasius.gpu-model-static-demo/2" } as never)],
    ["bad source digest", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1({ ...input, sourceEvidence: { ...input.sourceEvidence, sourceContentHash: "bad" } })],
    ["wrong basis", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1({ ...input, coordinateSystem: { ...input.coordinateSystem, forwardAxis: "+z" as never } })],
    ["wrong bounds", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1({ ...input, bounds: { min: [-2, 0, -0.5], max: input.bounds.max } })],
    ["unknown material", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1({ ...input, worldTriangles: [{ ...input.worldTriangles[0]!, materialIndex: 8 }] })],
    ["cell-test budget", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1(input, { longestAxisCells: 64, maximumTriangleCellTests: 1 })],
    ["occupied budget", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1(input, { longestAxisCells: 8, maximumOccupiedVoxels: 1 })],
    ["occupied option above 64 cubed", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1(input, { maximumOccupiedVoxels: 262_145 })],
    ["degenerate triangle", (input: ReturnType<typeof cubeCompilerInput>) => voxelizeStaticShellV1({ ...input, worldTriangles: [{ ...input.worldTriangles[0]!, positions: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }] })],
  ])("fails closed for %s", (_name, invoke) => {
    expect(() => invoke(cubeCompilerInput())).toThrow();
  });
});
