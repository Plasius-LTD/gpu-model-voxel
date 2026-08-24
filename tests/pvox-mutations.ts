import {
  PVOX_DIRECTORY_ENTRY_BYTE_LENGTH,
  PVOX_HEADER_BYTE_LENGTH,
  PVOX_ROOT_HEADER_LAYOUT_V1,
  PVOX_SECTION_REGISTRY,
  encodePvoxDirectoryHashPreimageV1,
  encodePvoxSectionHashPreimageV1,
} from "@plasius/asset-contracts";

import {
  PVOX_DIRECTORY_ENTRY_LAYOUT_V1,
} from "../src/index.js";
import {
  hexToBytes,
  sha256,
  writeBytes,
} from "../src/binary.js";

export type RequiredStaticSectionName = Exclude<keyof typeof PVOX_SECTION_REGISTRY, "BOND" | "CROT" | "CLEV" | "CNOD" | "CBRK" | "CDAT">;

export interface MutableSectionLocation {
  readonly directoryEntryOffset: number;
  readonly sectionOffset: number;
  readonly sectionLength: number;
  readonly type: number;
  readonly version: number;
}

export function locateSection(bytes: Uint8Array, name: RequiredStaticSectionName): MutableSectionLocation {
  const definition = PVOX_SECTION_REGISTRY[name];
  const rootView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = rootView.getUint16(PVOX_ROOT_HEADER_LAYOUT_V1.sectionCount.offset, true);
  const directoryOffset = Number(rootView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteOffset.offset, true));
  for (let index = 0; index < sectionCount; index += 1) {
    const entryOffset = directoryOffset + index * PVOX_DIRECTORY_ENTRY_BYTE_LENGTH;
    if (rootView.getUint32(entryOffset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionType.offset, true) !== definition.type
      || rootView.getUint16(entryOffset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionVersion.offset, true) !== definition.version) {
      continue;
    }
    return {
      directoryEntryOffset: entryOffset,
      sectionOffset: Number(rootView.getBigUint64(entryOffset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteOffset.offset, true)),
      sectionLength: Number(rootView.getBigUint64(entryOffset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.byteLength.offset, true)),
      type: definition.type,
      version: definition.version,
    };
  }
  throw new Error(`Missing fixture section ${name}.`);
}

export async function rehashDirectory(bytes: Uint8Array): Promise<void> {
  const rootView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = rootView.getUint16(PVOX_ROOT_HEADER_LAYOUT_V1.sectionCount.offset, true);
  const directoryOffset = Number(rootView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteOffset.offset, true));
  const directoryLength = Number(rootView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteLength.offset, true));
  const directory = bytes.subarray(directoryOffset, directoryOffset + directoryLength);
  const digest = await sha256(encodePvoxDirectoryHashPreimageV1(sectionCount, directory));
  writeBytes(bytes, PVOX_ROOT_HEADER_LAYOUT_V1.directoryHash.offset, hexToBytes(digest));
}

export async function rehashSection(bytes: Uint8Array, name: RequiredStaticSectionName): Promise<void> {
  const location = locateSection(bytes, name);
  const section = bytes.subarray(location.sectionOffset, location.sectionOffset + location.sectionLength);
  const digest = await sha256(encodePvoxSectionHashPreimageV1(location.type, location.version, section));
  writeBytes(
    bytes,
    location.directoryEntryOffset + PVOX_DIRECTORY_ENTRY_LAYOUT_V1.sectionHash.offset,
    hexToBytes(digest),
  );
  await rehashDirectory(bytes);
}

export async function mutateSection(
  original: Uint8Array,
  name: RequiredStaticSectionName,
  mutation: (section: Uint8Array, location: MutableSectionLocation) => void,
): Promise<Uint8Array> {
  const bytes = original.slice();
  const location = locateSection(bytes, name);
  mutation(bytes.subarray(location.sectionOffset, location.sectionOffset + location.sectionLength), location);
  await rehashSection(bytes, name);
  return bytes;
}

export function firstSectionPaddingOffset(bytes: Uint8Array): number {
  const rootView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directoryLength = Number(rootView.getBigUint64(PVOX_ROOT_HEADER_LAYOUT_V1.directoryByteLength.offset, true));
  return PVOX_HEADER_BYTE_LENGTH + directoryLength;
}
