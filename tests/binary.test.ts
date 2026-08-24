import {
  align,
  assertFinite,
  assertRange,
  bytesEqual,
  bytesToHex,
  clamp01,
  concatenate,
  decodeMorton3,
  dequantizeSnorm16,
  hexToBytes,
  isZeroRange,
  morton3,
  popcountMask,
  quantizeSnorm16,
  quantizeUnorm16,
  quantizeUnorm8,
  setI64,
  setU64,
  sha256,
  utf8,
  writeBytes,
} from "../src/binary.js";

describe("bounded binary helpers", () => {
  it("aligns, encodes hashes and compares without changing inputs", async () => {
    expect(align(0, 256)).toBe(0);
    expect(align(257, 256)).toBe(512);
    const digest = await sha256(utf8("PVOX"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(bytesToHex(hexToBytes(digest))).toBe(digest);
    expect(bytesEqual(hexToBytes(digest), hexToBytes(digest))).toBe(true);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(concatenate([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("round-trips Morton coordinates and fixed normalized values", () => {
    const morton = morton3(7, 5, 3);
    expect(decodeMorton3(morton, 3)).toEqual([7, 5, 3]);
    expect(quantizeUnorm8(0.5)).toBe(128);
    expect(quantizeUnorm16(1)).toBe(65535);
    expect(quantizeSnorm16(-1)).toBe(-32768);
    expect(dequantizeSnorm16(-32768)).toBe(-1);
    expect(dequantizeSnorm16(32767)).toBe(1);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(popcountMask(new Uint8Array([0xff, 0x0f]))).toBe(12);
  });

  it("writes bounded integer and byte fields", () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    setU64(view, 0, 12);
    setI64(view, 8, -4n);
    writeBytes(bytes, 16, new Uint8Array([1, 2, 3]));
    expect(view.getBigUint64(0, true)).toBe(12n);
    expect(view.getBigInt64(8, true)).toBe(-4n);
    expect(isZeroRange(bytes, 19, 24)).toBe(true);
    expect(assertRange(2, 1, 3, "value")).toBe(2);
    expect(assertFinite(2.5, "value")).toBe(2.5);
  });

  it.each([
    () => align(-1, 2),
    () => assertRange(4, 0, 3, "value"),
    () => assertFinite(Number.NaN, "value"),
    () => hexToBytes("not-a-hash"),
    () => morton3(-1, 0, 0),
    () => decodeMorton3(0n, 22),
    () => clamp01(Number.NaN),
    () => writeBytes(new Uint8Array(1), 1, new Uint8Array(1)),
    () => setU64(new DataView(new ArrayBuffer(8)), 0, -1n),
    () => setI64(new DataView(new ArrayBuffer(8)), 0, 0x8000_0000_0000_0000n),
  ])("rejects malformed helper input", (invoke) => {
    expect(invoke).toThrow();
  });
});
