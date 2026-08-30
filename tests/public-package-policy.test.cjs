const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizePackagePath,
  verifyPackagePathInventory,
} = require("../scripts/verify-public-package.cjs");

test("normalizes sealed tar members without exposing source paths", () => {
  assert.equal(
    normalizePackagePath("package\\dist\\index.js"),
    "dist/index.js"
  );
  assert.equal(
    normalizePackagePath("package/legal/ＣＬＡ－ＲＥＧＩＳＴＲＹ．ｃｓｖ"),
    "legal/cla-registry.csv"
  );
});

test("rejects private package metadata and normalization collisions", () => {
  assert.throws(
    () => verifyPackagePathInventory(["package/legal/CLA-REGISTRY.csv"]),
    /Forbidden publish path metadata/u
  );
  assert.throws(
    () =>
      verifyPackagePathInventory([
        "package/dist/index.js",
        "package/ｄｉｓｔ/index.js",
      ]),
    /normalization-collision/u
  );
});

test("accepts the bounded public runtime inventory", () => {
  assert.doesNotThrow(() =>
    verifyPackagePathInventory([
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.js",
      "package/assets/brigantine.gltf",
    ])
  );
});
