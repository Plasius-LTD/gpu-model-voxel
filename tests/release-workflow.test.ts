import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/release-prepare.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const cdWorkflow = readFileSync(
  new URL("../.github/workflows/cd.yml", import.meta.url),
  "utf8",
);

describe("release preparation workflow", () => {
  it("does not let checkout credentials override the release-prep app token", () => {
    expect(workflow).toContain("persist-credentials: false");
  });

  it("retries a protected merge while required checks complete", () => {
    expect(workflow).toContain(
      'if gh pr merge "${PR_NUMBER}" --squash --delete-branch >/dev/null 2>&1; then',
    );
    expect(workflow).toContain(
      "merged after required checks completed.",
    );
  });

  it("runs trusted pull-request and exact-main validation on hosted runners", () => {
    expect(ciWorkflow).toContain("name: Trusted head admission");
    expect(ciWorkflow.match(/^ {4}runs-on: ubuntu-latest$/gmu)).toHaveLength(3);
    expect(ciWorkflow).not.toContain("self-hosted");
  });

  it("preserves the Schema release contract with a bounded bootstrap extension", () => {
    expect(cdWorkflow).toContain("Wait for successful exact-SHA main CI");
    expect(cdWorkflow).toContain(
      "node scripts/verify-public-package.cjs --inventory-stdin",
    );
    expect(cdWorkflow).toContain('npm publish "./${TARBALL}"');
    expect(cdWorkflow).toContain("bootstrap_first_publish:");
    expect(cdWorkflow).toContain(
      'if: steps.release.outputs.should_publish_npm == \'true\' && inputs.bootstrap_first_publish != true',
    );
  });

  it("runs Schema privacy and sealed-package checks in CI", () => {
    expect(ciWorkflow.indexOf("Verify private artifact policy")).toBeLessThan(
      ciWorkflow.indexOf("Install deps"),
    );
    expect(ciWorkflow).toContain("Test private artifact policy");
    expect(ciWorkflow).toContain("Verify public package contents");
  });
});
