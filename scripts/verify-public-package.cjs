#!/usr/bin/env node
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FORBIDDEN_TARBALL_PATH_PATTERNS = Object.freeze([
  { regex: /(?:^|\/)plasius-ltd-site(?:\/|$)/iu },
  { regex: /(?:^|\/)(frontend|backend|dashboard|infra)(?:\/|$)/iu },
  { regex: /(?:^|\/)local\.settings(?:\.[^/]+)?\.json$/iu },
  { regex: /(?:^|\/)host\.json$/iu },
  { regex: /(?:^|\/)tsp-output(?:\/|$)/iu },
  { regex: /(?:^|\/)legal\/cla-registry\.csv$/iu },
]);

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--inventory-stdin") {
    verifyStdinPackageInventory();
    return;
  }
  if (argv.length > 0) {
    throw new Error("Unsupported public package check arguments.");
  }

  const cacheDir = path.resolve(process.cwd(), ".npm-cache-packcheck");
  try {
    const output = execSync(
      `npm pack --dry-run --json --ignore-scripts --cache "${cacheDir}"`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const parsed = parseNpmPackJson(output);
    const files = Array.isArray(parsed) && parsed[0]?.files ? parsed[0].files : [];
    const paths = files.map((entry) => entry.path);
    verifyPackagePathInventory(paths);

    const forbiddenCodeReferencePatterns = [
      {
        label: "private monorepo reference",
        regex: /\bplasius-ltd-site\b/i,
      },
      {
        label: "Plasius Ltd private reference",
        regex: /\bplasius(?:\s+|-)ltd\b/i,
      },
      {
        label: "proprietary PGP artifact reference",
        regex: /\bpgp[-_a-z0-9]*\b/i,
      },
      {
        label: "proprietary Lunari artifact reference",
        regex: /\blunari\b/i,
      },
      {
        label: "proprietary Pixelverse artifact reference",
        regex: /\bpixelverse\b/i,
      },
    ];

    const codeRoots = ["src", "tests", "demo"];
    const codeExtensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".cjs",
      ".json",
    ]);
    const violations = scanCodeReferences(
      codeRoots,
      codeExtensions,
      forbiddenCodeReferencePatterns
    );

    if (violations.length > 0) {
      const labels = [...new Set(violations.map(({ label }) => label))].sort();
      throw new Error(
        `Forbidden private/product code references were found (${violations.length}; ${labels.join(", ")}); values were not logged.`
      );
    }

    console.log("Public package check passed.");
  } finally {
    fs.rmSync(cacheDir, { force: true, recursive: true });
  }
}

function verifyStdinPackageInventory() {
  const input = fs.readFileSync(0);
  if (input.byteLength > 16 * 1024 * 1024) {
    throw new Error("Packed path inventory exceeds the 16 MiB limit.");
  }

  const paths = input.toString("utf8").split(/\r?\n/u).filter(Boolean);
  verifyPackagePathInventory(paths);
  console.log("Sealed package inventory check passed.");
}

function verifyPackagePathInventory(paths) {
  const rawPaths = new Set();
  const normalizedPaths = new Set();
  let forbiddenCount = 0;

  for (const candidate of paths) {
    if (typeof candidate !== "string") {
      throw new TypeError("Packed paths must be strings.");
    }
    const rawPath = candidate.startsWith("package/")
      ? candidate.slice("package/".length)
      : candidate;
    const normalizedPath = normalizePackagePath(candidate);
    if (rawPaths.has(rawPath) || normalizedPaths.has(normalizedPath)) {
      throw new Error(
        "Packed paths failed raw member identity or normalization-collision checks; values were not logged."
      );
    }
    rawPaths.add(rawPath);
    normalizedPaths.add(normalizedPath);
    if (
      FORBIDDEN_TARBALL_PATH_PATTERNS.some(({ regex }) =>
        regex.test(normalizedPath)
      )
    ) {
      forbiddenCount += 1;
    }
  }

  if (forbiddenCount > 0) {
    throw new Error(
      `Forbidden publish path metadata was found (${forbiddenCount}); values were not logged.`
    );
  }
}

function normalizePackagePath(candidate) {
  const normalized = path.posix
    .normalize(candidate.replaceAll("\\", "/"))
    .replace(/^(?:\.\/)+/u, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  return normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
}

function parseNpmPackJson(rawOutput) {
  const start = rawOutput.indexOf("[");
  const end = rawOutput.lastIndexOf("]");

  if (start < 0 || end < start) {
    throw new Error("Could not find npm pack JSON payload in command output.");
  }

  const jsonSlice = rawOutput.slice(start, end + 1);
  return JSON.parse(jsonSlice);
}

function scanCodeReferences(roots, extensions, patterns) {
  const allFiles = [];
  for (const root of roots) {
    allFiles.push(...collectFiles(path.resolve(process.cwd(), root), extensions));
  }

  const violations = [];
  for (const file of allFiles) {
    const contents = fs.readFileSync(file, "utf8");

    for (const pattern of patterns) {
      const matchIndex = contents.search(pattern.regex);
      if (matchIndex < 0) {
        continue;
      }

      const beforeMatch = contents.slice(0, matchIndex);
      const line = beforeMatch.split(/\r?\n/u).length;
      violations.push({
        file: path.relative(process.cwd(), file),
        line,
        label: pattern.label,
      });
      break;
    }
  }

  return violations;
}

function collectFiles(root, extensions) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-cjs") {
        continue;
      }
      files.push(...collectFiles(fullPath, extensions));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Public package check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  normalizePackagePath,
  verifyPackagePathInventory,
};
