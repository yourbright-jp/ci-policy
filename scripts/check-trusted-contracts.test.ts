import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTrustedContractCheck } from "./check-trusted-contracts";

const roots: string[] = [];

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root && existsSync(root)) rmSync(root, { force: true, recursive: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "trusted-contract-"));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function contract() {
  return {
    schema_version: 1,
    immutable_files: ["scripts/verify.mjs"],
    trusted_node_checks: {
      "candidate-data-v1": {
        entrypoint: "scripts/verify.mjs",
        arguments: [{ root: "candidate", path: "data/state.txt", kind: "file" }],
      },
    },
  } as const;
}

function populate(root: string, state = "safe") {
  write(
    root,
    "scripts/verify.mjs",
    `import { readFileSync } from "node:fs";
if (process.env.GITHUB_TOKEN || readFileSync(process.argv[2], "utf8") !== "safe") process.exit(1);
`,
  );
  write(root, "data/state.txt", state);
  write(root, ".github/ci-policy-contract.json", `${JSON.stringify(contract(), null, 2)}\n`);
}

describe("runTrustedContractCheck", () => {
  test("accepts a valid bootstrap without executing candidate code", () => {
    const candidate = makeRepo();
    populate(candidate, "unsafe");

    expect(runTrustedContractCheck({ candidateRepoRoot: candidate })).toEqual([]);
  });

  test("executes only the base check with a stripped environment", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    process.env.GITHUB_TOKEN = "must-not-reach-check";

    expect(runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate })).toEqual([]);
  });

  test("passes only isolated copies of declared candidate inputs", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    const checker = `import { readFileSync } from "node:fs";
const input = process.argv[2].replaceAll("\\\\", "/");
if (!input.includes("/inputs/candidate/data/state.txt") || readFileSync(input, "utf8") !== "safe") process.exit(1);
`;
    write(base, "scripts/verify.mjs", checker);
    write(candidate, "scripts/verify.mjs", checker);

    expect(runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate })).toEqual([]);
  });

  test("keeps staged inputs disjoint from the immutable program tree", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    const collisionContract = {
      schema_version: 1,
      immutable_files: ["inputs/candidate/data/state.mjs"],
      trusted_node_checks: {
        "collision-v1": {
          entrypoint: "inputs/candidate/data/state.mjs",
          arguments: [{ root: "candidate", path: "data/state.mjs", kind: "file" }],
        },
      },
    };
    const checker = `import { readFileSync } from "node:fs";
if (readFileSync(process.argv[2], "utf8") !== "candidate data") process.exit(1);
`;
    for (const root of [base, candidate]) {
      write(root, "inputs/candidate/data/state.mjs", checker);
      write(root, ".github/ci-policy-contract.json", `${JSON.stringify(collisionContract, null, 2)}\n`);
    }
    write(base, "data/state.mjs", "base data");
    write(candidate, "data/state.mjs", "candidate data");

    expect(runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate })).toEqual([]);
  });

  test("rejects duplicate or case-aliased staged arguments", () => {
    for (const duplicatePath of ["data/state.txt", "DATA/state.txt"]) {
      const candidate = makeRepo();
      populate(candidate);
      const invalid = structuredClone(contract()) as any;
      invalid.trusted_node_checks["candidate-data-v1"].arguments.push({
        root: "candidate",
        path: duplicatePath,
        kind: "file",
      });
      write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(invalid, null, 2)}\n`);

      expect(runTrustedContractCheck({ candidateRepoRoot: candidate }).map((item) => item.rule))
        .toEqual(["trusted-contract-config-invalid"]);
    }
  });

  test("rejects candidate data that fails a trusted base check", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate, "unsafe");

    const result = runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toContain("trusted-contract-check-failed");
  });

  test("rejects an immutable checker edit before executing it", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate, "unsafe");
    write(candidate, "scripts/verify.mjs", "process.exit(0);\n");

    const result = runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toContain("trusted-contract-immutable-file-changed");
    expect(result.map((item) => item.rule)).not.toContain("trusted-contract-check-failed");
  });

  test("rejects removal or mutation of an established contract rule", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    write(
      candidate,
      ".github/ci-policy-contract.json",
      `${JSON.stringify({ schema_version: 1, immutable_files: [], trusted_node_checks: {} }, null, 2)}\n`,
    );

    const result = runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate });
    expect(result.filter((item) => item.rule === "trusted-contract-weakened")).toHaveLength(2);
  });

  test("allows staging a new immutable checker without activating it", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    const next = structuredClone(contract()) as any;
    next.immutable_files.push("scripts/future.mjs");
    write(candidate, "scripts/future.mjs", "process.exit(1);\n");
    write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(next, null, 2)}\n`);

    expect(runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate })).toEqual([]);
  });

  test("requires a new checker to be immutable in the base before activation", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    const next = structuredClone(contract()) as any;
    next.immutable_files.push("scripts/future.mjs");
    next.trusted_node_checks["future-v1"] = {
      entrypoint: "scripts/future.mjs",
      arguments: [],
    };
    write(candidate, "scripts/future.mjs", "process.exit(1);\n");
    write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(next, null, 2)}\n`);

    const result = runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toContain("trusted-contract-check-not-staged");
  });

  test("activates a staged checker without executing candidate code in the activation PR", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    const staged = structuredClone(contract()) as any;
    staged.immutable_files.push("scripts/future.mjs");
    write(base, "scripts/future.mjs", "process.exit(1);\n");
    write(candidate, "scripts/future.mjs", "process.exit(1);\n");
    write(base, ".github/ci-policy-contract.json", `${JSON.stringify(staged, null, 2)}\n`);
    const activated = structuredClone(staged);
    activated.trusted_node_checks["future-v1"] = {
      entrypoint: "scripts/future.mjs",
      arguments: [],
    };
    write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(activated, null, 2)}\n`);

    expect(runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate })).toEqual([]);
  });

  test("requires every local dependency to be immutable in the base before activation", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    const staged = structuredClone(contract()) as any;
    staged.immutable_files.push("scripts/future.mjs");
    write(base, "scripts/future.mjs", 'import "./future-helper.mjs";\n');
    write(base, "scripts/future-helper.mjs", "process.exit(1);\n");
    write(base, ".github/ci-policy-contract.json", `${JSON.stringify(staged, null, 2)}\n`);

    const activated = structuredClone(staged);
    activated.immutable_files.push("scripts/future-helper.mjs");
    activated.trusted_node_checks["future-v1"] = {
      entrypoint: "scripts/future.mjs",
      arguments: [],
    };
    write(candidate, "scripts/future.mjs", 'import "./future-helper.mjs";\n');
    write(candidate, "scripts/future-helper.mjs", "process.exit(0);\n");
    write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(activated, null, 2)}\n`);

    const result = runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toContain("trusted-contract-check-not-staged");
  });

  test("requires the full local import closure to be immutable", () => {
    const candidate = makeRepo();
    write(candidate, "scripts/verify.mjs", 'import "./helper.mjs";\n');
    write(candidate, "scripts/helper.mjs", "process.exit(0);\n");
    write(candidate, "data/state.txt", "safe");
    write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(contract(), null, 2)}\n`);

    const result = runTrustedContractCheck({ candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toEqual(["trusted-contract-config-invalid"]);
  });

  test("parses comment-separated imports and rejects dynamic or URL-encoded imports", () => {
    for (const source of [
      'import/*comment*/ "./helper.mjs";\n',
      'await import/*comment*/("./helper.mjs");\n',
      'import "./%2e%2e/helper.mjs";\n',
      'import "./%68elper.mjs";\n',
    ]) {
      const candidate = makeRepo();
      populate(candidate);
      write(candidate, "scripts/verify.mjs", source);

      const result = runTrustedContractCheck({ candidateRepoRoot: candidate });
      expect(result.map((item) => item.rule)).toEqual(["trusted-contract-config-invalid"]);
    }
  });

  test("rejects js entrypoints and code-loading capabilities", () => {
    const jsCandidate = makeRepo();
    populate(jsCandidate);
    const jsContract = structuredClone(contract()) as any;
    jsContract.immutable_files = ["scripts/verify.js"];
    jsContract.trusted_node_checks["candidate-data-v1"].entrypoint = "scripts/verify.js";
    write(jsCandidate, "scripts/verify.js", "process.exit(0);\n");
    write(jsCandidate, ".github/ci-policy-contract.json", `${JSON.stringify(jsContract, null, 2)}\n`);
    expect(runTrustedContractCheck({ candidateRepoRoot: jsCandidate }).map((item) => item.rule))
      .toEqual(["trusted-contract-config-invalid"]);

    for (const source of [
      'import { createRequire } from "node:module"; createRequire(import.meta.url)("./mutable.cjs");\n',
      'const load = process.getBuiltinModule; load("module");\n',
      'eval("process.exit(0)");\n',
      'new Function("process.exit(0)")();\n',
    ]) {
      const candidate = makeRepo();
      populate(candidate);
      write(candidate, "scripts/verify.mjs", source);
      expect(runTrustedContractCheck({ candidateRepoRoot: candidate }).map((item) => item.rule))
        .toEqual(["trusted-contract-config-invalid"]);
    }
  });

  test("executes a trusted checker from an isolated immutable closure", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(base);
    populate(candidate);
    const checker = `import { readFileSync } from "node:fs";
if (readFileSync(new URL("./mutable.txt", import.meta.url), "utf8") !== "safe") process.exit(1);
`;
    write(base, "scripts/verify.mjs", checker);
    write(candidate, "scripts/verify.mjs", checker);
    write(base, "scripts/mutable.txt", "safe");
    write(candidate, "scripts/mutable.txt", "safe");

    const result = runTrustedContractCheck({ baseRepoRoot: base, candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toContain("trusted-contract-check-failed");
  });

  test("required mode fails when the trusted base contract is absent", () => {
    const base = makeRepo();
    const candidate = makeRepo();
    populate(candidate);

    const result = runTrustedContractCheck({
      baseRepoRoot: base,
      candidateRepoRoot: candidate,
      requireTrustedContract: true,
    });
    expect(result.map((item) => item.rule)).toEqual(["trusted-contract-base-missing"]);
  });

  test("rejects directory arguments in trusted contracts", () => {
    const candidate = makeRepo();
    populate(candidate);
    const invalid = structuredClone(contract()) as any;
    invalid.trusted_node_checks["candidate-data-v1"].arguments = [
      { root: "candidate", path: ".", kind: "directory" },
    ];
    write(candidate, ".github/ci-policy-contract.json", `${JSON.stringify(invalid, null, 2)}\n`);

    const result = runTrustedContractCheck({ candidateRepoRoot: candidate });
    expect(result.map((item) => item.rule)).toEqual(["trusted-contract-config-invalid"]);
  });

  test("fails closed on duplicate keys, BOM, and unknown fields", () => {
    for (const invalid of [
      '{"schema_version":1,"schema_version":1,"immutable_files":[],"trusted_node_checks":{}}',
      '\ufeff{"schema_version":1,"immutable_files":[],"trusted_node_checks":{}}',
      '{"schema_version":1,"immutable_files":[],"trusted_node_checks":{},"extra":true}',
      '{"schema_version":1.0000000000000001,"immutable_files":[],"trusted_node_checks":{}}',
      '{"schema_version":9007199254740993,"immutable_files":[],"trusted_node_checks":{}}',
    ]) {
      const candidate = makeRepo();
      write(candidate, ".github/ci-policy-contract.json", invalid);
      const result = runTrustedContractCheck({ candidateRepoRoot: candidate });
      expect(result.map((item) => item.rule)).toEqual(["trusted-contract-config-invalid"]);
    }
  });
});
