export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

export interface PvoxStaticMaterialInputV1 {
  readonly sourceMaterialId: string | null;
  readonly sourceMaterialName?: string;
  readonly sourceWorkflow: "metallic-roughness" | "unlit";
  readonly baseColorFactor: Vec4;
  readonly roughnessFactor: number;
  readonly metallicFactor: number;
  readonly emissiveFactor: Vec3;
  readonly doubleSided: boolean;
}

export interface PvoxStaticTriangleInputV1 {
  readonly positions: readonly [Vec3, Vec3, Vec3];
  readonly normals: readonly [Vec3, Vec3, Vec3];
  readonly materialIndex: number;
  readonly sourceNodeId: string;
  readonly sourceMeshId: string;
  readonly sourcePrimitiveId: string;
  readonly sourceTriangleIndex: number;
  readonly bounds?: {
    readonly min: Vec3;
    readonly max: Vec3;
  };
}

/** Structural form returned by gpu-model-core's verified static-demo extractor. */
export interface PvoxStaticCompilerInputV1 {
  readonly profileVersion: "plasius.gpu-model-static-demo/1";
  readonly canonicalDocumentHash: string;
  readonly sourceEvidence: {
    readonly sourceFormat: string;
    readonly sourceContentHash: string;
    readonly converterId: string;
    readonly converterVersion: string;
    readonly provider?: string;
  };
  readonly coordinateSystem: {
    readonly unit: "metre";
    readonly upAxis: "y";
    readonly forwardAxis: "-z";
    readonly handedness: "right";
    readonly winding: "counter-clockwise";
    readonly origin: "floor-centred";
  };
  readonly bounds: {
    readonly min: Vec3;
    readonly max: Vec3;
  };
  readonly materials: readonly PvoxStaticMaterialInputV1[];
  readonly worldTriangles: readonly PvoxStaticTriangleInputV1[];
}

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
