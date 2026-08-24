const HEX = "0123456789abcdef";

export function align(value: number, alignment: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(alignment) || alignment < 1) {
    throw new Error("Alignment operands must be non-negative safe integers.");
  }
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

export function assertRange(
  value: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${fieldName} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function assertFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) throw new Error(`${fieldName} must be finite.`);
  return value;
}

export function writeBytes(target: Uint8Array, offset: number, value: Uint8Array): void {
  if (offset < 0 || offset + value.byteLength > target.byteLength) throw new Error("Byte write is out of bounds.");
  target.set(value, offset);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function isZeroRange(bytes: Uint8Array, start: number, end: number): boolean {
  if (start < 0 || end < start || end > bytes.byteLength) return false;
  for (let index = start; index < end; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

export function hexToBytes(value: string, fieldName = "sha256"): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${fieldName} must be a lowercase SHA-256 digest.`);
  const output = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

export function bytesToHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += HEX[byte >>> 4]! + HEX[byte & 15]!;
  return result;
}

export async function sha256(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return bytesToHex(new Uint8Array(digest));
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function setU64(view: DataView, offset: number, value: number | bigint): void {
  const bigint = typeof value === "bigint" ? value : BigInt(assertRange(value, 0, Number.MAX_SAFE_INTEGER, "u64"));
  if (bigint < 0n || bigint > 0xffff_ffff_ffff_ffffn) throw new Error("u64 value is out of range.");
  view.setBigUint64(offset, bigint, true);
}

export function setI64(view: DataView, offset: number, value: bigint): void {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) throw new Error("i64 value is out of range.");
  view.setBigInt64(offset, value, true);
}

export function popcountByte(value: number): number {
  let current = value & 0xff;
  current -= (current >>> 1) & 0x55;
  current = (current & 0x33) + ((current >>> 2) & 0x33);
  return (current + (current >>> 4)) & 0x0f;
}

export function popcountMask(mask: Uint8Array): number {
  let count = 0;
  for (const byte of mask) count += popcountByte(byte);
  return count;
}

export function morton3(x: number, y: number, z: number): bigint {
  assertRange(x, 0, 0x1f_ffff, "morton x");
  assertRange(y, 0, 0x1f_ffff, "morton y");
  assertRange(z, 0, 0x1f_ffff, "morton z");
  let result = 0n;
  for (let bit = 0; bit < 21; bit += 1) {
    result |= BigInt((x >>> bit) & 1) << BigInt(bit * 3);
    result |= BigInt((y >>> bit) & 1) << BigInt(bit * 3 + 1);
    result |= BigInt((z >>> bit) & 1) << BigInt(bit * 3 + 2);
  }
  return result;
}

export function decodeMorton3(value: bigint, bitCount: number): readonly [number, number, number] {
  assertRange(bitCount, 0, 21, "Morton bit count");
  let x = 0;
  let y = 0;
  let z = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    x |= Number((value >> BigInt(bit * 3)) & 1n) << bit;
    y |= Number((value >> BigInt(bit * 3 + 1)) & 1n) << bit;
    z |= Number((value >> BigInt(bit * 3 + 2)) & 1n) << bit;
  }
  return [x, y, z];
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Normalized value must be finite.");
  return Math.min(1, Math.max(0, value));
}

export function quantizeUnorm8(value: number): number {
  return Math.round(clamp01(value) * 255);
}

export function quantizeUnorm16(value: number): number {
  return Math.round(clamp01(value) * 65535);
}

export function quantizeSnorm16(value: number): number {
  const clamped = Math.min(1, Math.max(-1, assertFinite(value, "snorm")));
  return clamped <= -1 ? -32768 : Math.round(clamped * 32767);
}

export function dequantizeSnorm16(value: number): number {
  return value === -32768 ? -1 : Math.max(-1, value / 32767);
}
