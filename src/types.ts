import type {
  GpuModelStaticDemoCompilerInput,
  GpuModelStaticDemoMaterial,
  GpuModelStaticDemoWorldTriangle,
  GpuModelVec3,
  GpuModelVec4,
} from "@plasius/gpu-model-core";

export type Vec3 = GpuModelVec3;
export type Vec4 = GpuModelVec4;

/** Exact texture-free surface projection emitted by the verified model core. */
export type PvoxStaticMaterialInputV1 = GpuModelStaticDemoMaterial;

/** Exact byte-verified canonical triangle projection emitted by model core. */
export type PvoxStaticTriangleInputV1 = GpuModelStaticDemoWorldTriangle;

/** The only structural form accepted from gpu-model-core's verified extractor. */
export type PvoxStaticCompilerInputV1 = GpuModelStaticDemoCompilerInput;

export interface PvoxCompileOptionsV1 {
  readonly longestAxisCells?: number;
  readonly maximumOccupiedVoxels?: number;
  readonly maximumTriangleCellTests?: number;
  readonly runtimeProfileId?: "static-render-v1";
}

export interface PvoxSectionEvidenceV1 {
  readonly type: number;
  readonly version: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly recordBytes: number;
  readonly recordCount: number;
  readonly sha256: string;
}

export interface PvoxPageEvidenceV1 {
  readonly pageIndex: number;
  readonly byteOffset: number;
  readonly byteLength: 65536;
  readonly sha256: string;
}

export interface PvoxCompilationEvidenceV1 {
  readonly format: "PVOX";
  readonly formatVersion: "1.0";
  readonly geometryMode: "shell";
  readonly runtimeProfileId: "static-render-v1";
  readonly artifactSha256: string;
  readonly rootHash: string;
  readonly directoryHash: string;
  readonly pageSetHash: string;
  readonly binaryClosureHash: string;
  readonly compilationInputHash: string;
  readonly runtimeRequestProfileHash: string;
  readonly canonicalDocumentHash: string;
  readonly sourceContentHash: string;
  readonly sectionEvidence: readonly PvoxSectionEvidenceV1[];
  readonly pageEvidence: readonly PvoxPageEvidenceV1[];
  readonly triangleCount: number;
  readonly occupiedVoxelCount: number;
  readonly brickCount: number;
  readonly gridDimensions: Vec3;
  readonly cellSizeMetres: number;
  readonly fidelityWarnings: readonly string[];
}

export interface PvoxCompileResultV1 {
  readonly bytes: Uint8Array;
  readonly evidence: PvoxCompilationEvidenceV1;
}

export interface PvoxDecodedSurfaceV1 {
  readonly surfaceIndex: number;
  readonly baseColor: Vec4;
  readonly roughness: number;
  readonly metallic: number;
  readonly specular: number;
  readonly emission: Vec3;
}

export interface PvoxDecodedVoxelV1 {
  readonly grid: readonly [number, number, number];
  readonly centre: Vec3;
  readonly normal: Vec3;
  readonly surfaceIndex: number;
  readonly coverage: number;
}

export interface PvoxDecodedV1 {
  readonly artifactSha256: string;
  readonly rootHash: string;
  readonly directoryHash: string;
  readonly pageSetHash: string;
  readonly compilationInputHash: string;
  readonly runtimeRequestProfileHash: string;
  readonly geometryMode: "shell";
  readonly fixedPointFractionBits: number;
  readonly quantizedBounds: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  readonly origin: Vec3;
  readonly cellSizeMetres: number;
  readonly gridDimensions: readonly [number, number, number];
  readonly surfaces: readonly PvoxDecodedSurfaceV1[];
  readonly voxels: readonly PvoxDecodedVoxelV1[];
  readonly sections: readonly PvoxSectionEvidenceV1[];
  readonly pages: readonly PvoxPageEvidenceV1[];
}

export interface PvoxValidationExpectationsV1 {
  readonly artifactSha256?: string;
  readonly sourceContentHash?: string;
  readonly canonicalDocumentHash?: string;
  readonly binaryClosureHash?: string;
}

export interface PvoxSurfaceMeshV1 {
  readonly representation: "pvox-derived-surface-cache";
  readonly sourceArtifactSha256: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  /** Surface palette index for every emitted vertex in the disposable cache. */
  readonly surfaceIndices: Uint32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  readonly bounds: {
    readonly minimum: Vec3;
    readonly maximum: Vec3;
  };
}

export type PvoxReviewViewNameV1 = "front" | "left" | "top" | "isometric";

export interface PvoxReviewViewV1 {
  readonly name: PvoxReviewViewNameV1;
  readonly width: number;
  readonly height: number;
  readonly contentType: "image/png";
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PvoxReviewOptionsV1 {
  readonly width?: number;
  readonly height?: number;
  readonly background?: readonly [number, number, number, number];
}
