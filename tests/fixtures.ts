import type {
  PvoxStaticCompilerInputV1,
  PvoxStaticTriangleInputV1,
  Vec3,
} from "../src/index.js";

const vertices = {
  lbf: [-0.5, 0, 0.5] as Vec3,
  rbf: [0.5, 0, 0.5] as Vec3,
  lbb: [-0.5, 0, -0.5] as Vec3,
  rbb: [0.5, 0, -0.5] as Vec3,
  ltf: [-0.5, 1, 0.5] as Vec3,
  rtf: [0.5, 1, 0.5] as Vec3,
  ltb: [-0.5, 1, -0.5] as Vec3,
  rtb: [0.5, 1, -0.5] as Vec3,
};

function triangle(a: Vec3, b: Vec3, c: Vec3, normal: Vec3, index: number): PvoxStaticTriangleInputV1 {
  return Object.freeze({
    positions: Object.freeze([a, b, c] as const),
    normals: Object.freeze([normal, normal, normal] as const),
    materialIndex: 0,
    sourceNodeId: "node-cube",
    sourceMeshId: "mesh-cube",
    sourcePrimitiveId: "primitive-cube",
    sourceTriangleIndex: index,
  });
}

export function cubeCompilerInput(): PvoxStaticCompilerInputV1 {
  const faces: Array<readonly [Vec3, Vec3, Vec3, Vec3]> = [
    [vertices.lbf, vertices.rbf, vertices.rtf, [0, 0, 1]],
    [vertices.lbf, vertices.rtf, vertices.ltf, [0, 0, 1]],
    [vertices.rbb, vertices.lbb, vertices.ltb, [0, 0, -1]],
    [vertices.rbb, vertices.ltb, vertices.rtb, [0, 0, -1]],
    [vertices.rbf, vertices.rbb, vertices.rtb, [1, 0, 0]],
    [vertices.rbf, vertices.rtb, vertices.rtf, [1, 0, 0]],
    [vertices.lbb, vertices.lbf, vertices.ltf, [-1, 0, 0]],
    [vertices.lbb, vertices.ltf, vertices.ltb, [-1, 0, 0]],
    [vertices.ltf, vertices.rtf, vertices.rtb, [0, 1, 0]],
    [vertices.ltf, vertices.rtb, vertices.ltb, [0, 1, 0]],
    [vertices.lbb, vertices.rbb, vertices.rbf, [0, -1, 0]],
    [vertices.lbb, vertices.rbf, vertices.lbf, [0, -1, 0]],
  ];
  return {
    profileVersion: "plasius.gpu-model-static-demo/1",
    canonicalDocumentHash: "b".repeat(64),
    sourceEvidence: {
      sourceFormat: "glb",
      sourceContentHash: "a".repeat(64),
      converterId: "gpu-model-gltf",
      converterVersion: "0.1-test",
    },
    coordinateSystem: {
      unit: "metre",
      upAxis: "y",
      forwardAxis: "-z",
      handedness: "right",
      winding: "counter-clockwise",
      origin: "floor-centred",
    },
    bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
    materials: [{
      sourceMaterialId: "mat-red",
      sourceMaterialName: "Demo red",
      sourceWorkflow: "metallic-roughness",
      baseColorFactor: [0.82, 0.16, 0.09, 1],
      metallicFactor: 0.05,
      roughnessFactor: 0.62,
      emissiveFactor: [0, 0, 0],
      doubleSided: false,
    }],
    worldTriangles: faces.map(([a, b, c, normal], index) => triangle(a, b, c, normal, index)),
  };
}
