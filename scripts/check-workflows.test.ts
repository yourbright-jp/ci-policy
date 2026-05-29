import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPolicyCheck } from "./check-workflows";

const repos: string[] = [];

afterEach(() => {
  while (repos.length > 0) {
    const repo = repos.pop();
    if (repo && existsSync(repo)) {
      rmSync(repo, { force: true, recursive: true });
    }
  }
});

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "ci-policy-"));
  repos.push(root);

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  return root;
}

function check(repoRoot: string) {
  return runPolicyCheck({
    repoRoot,
    repository: "yourbright-jp/example",
    exceptionsPath: path.join(repoRoot, "missing-exceptions.yaml"),
    now: new Date("2026-04-19T00:00:00Z")
  });
}

describe("runPolicyCheck", () => {
  test("passes a Bun workflow that follows the org policy", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ packageManager: "bun@1.3.3" }),
      "bun.lock": "",
      ".github/workflows/test.yml": `
name: test
on:
  pull_request:
permissions:
  contents: read
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run test
`
    });

    expect(check(repo).ok).toBe(true);
  });

  test("allows actions/upload-artifact at allowlisted major versions", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ packageManager: "bun@1.3.3" }),
      "bun.lock": "",
      ".github/workflows/smoke.yml": `
name: smoke
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/upload-artifact@v4
        with:
          name: artifacts-v4
          path: dist
      - uses: actions/upload-artifact@v5
        with:
          name: artifacts-v5
          path: dist
`
    });

    expect(check(repo).ok).toBe(true);
  });

  test("rejects actions/upload-artifact at unsupported major versions", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ packageManager: "bun@1.3.3" }),
      "bun.lock": "",
      ".github/workflows/smoke.yml": `
name: smoke
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/upload-artifact@v3
        with:
          name: artifacts-v3
          path: dist
`
    });

    const result = check(repo);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain("github-actions-uses-allowlist");
  });

  test("allows ci-policy reusable workflows at v4", () => {
    const repo = makeRepo({
      ".github/workflows/policy.yml": `
name: policy
on:
  pull_request:
permissions:
  contents: read
jobs:
  policy:
    permissions:
      contents: read
    uses: yourbright-jp/ci-policy/.github/workflows/required-policy.yml@v4
    with:
      repository: yourbright-jp/example
`
    });

    expect(check(repo).ok).toBe(true);
  });

  test("blocks deploy commands in GitHub Actions", () => {
    const repo = makeRepo({
      ".github/workflows/deploy.yml": `
name: deploy
on:
  push:
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: bunx wrangler deploy
`
    });

    const result = check(repo);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain("no-deploy-command-in-actions");
  });

  test("blocks npm commands in Bun repos", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ packageManager: "bun@1.3.3" }),
      "bun.lock": "",
      ".github/workflows/test.yml": `
name: test
on:
  pull_request:
permissions:
  contents: read
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
`
    });

    const result = check(repo);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain("bun-repo-npm-command-forbidden");
  });

  test("requires top-level workflow permissions", () => {
    const repo = makeRepo({
      ".github/workflows/test.yml": `
name: test
on:
  pull_request:
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`
    });

    const result = check(repo);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain("workflow-permissions-required");
  });

  test("blocks package-lock.json in Bun repos", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ packageManager: "bun@1.3.3" }),
      "bun.lock": "",
      "package-lock.json": "{}",
      ".github/workflows/test.yml": `
name: test
on:
  pull_request:
permissions:
  contents: read
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`
    });

    const result = check(repo);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain("bun-repo-package-lock-forbidden");
  });

  test("loads project-specific exceptions from the target repository", () => {
    const repo = makeRepo({
      ".github/ci-policy-exceptions.yaml": `
exceptions:
  - repo: yourbright-jp/example
    rule: workflow-permissions-required
    path: .github/workflows/test.yml
    reason: migration window
    owner: "@yourbright-jp/platform"
    expires: "2026-05-31"
`,
      ".github/workflows/test.yml": `
name: test
on:
  pull_request:
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`
    });

    expect(check(repo).ok).toBe(true);
  });
});
