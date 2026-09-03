import { spawnSync } from "node:child_process";
import { parse } from "acorn";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export type TrustedContractViolation = {
  rule: string;
  path: string;
  message: string;
};

type ContractArgument = {
  root: "base" | "candidate";
  path: string;
  kind: "file";
};

type TrustedNodeCheck = {
  entrypoint: string;
  arguments: ContractArgument[];
};

type TrustedContract = {
  schema_version: 1;
  immutable_files: string[];
  trusted_node_checks: Record<string, TrustedNodeCheck>;
};

type CheckOptions = {
  baseRepoRoot?: string;
  candidateRepoRoot: string;
  requireTrustedContract?: boolean;
};

type AstNode = {
  type: string;
  [key: string]: unknown;
};

const CONTRACT_PATH = ".github/ci-policy-contract.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_IMMUTABLE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMMUTABLE_FILES = 64;
const MAX_TRUSTED_CHECKS = 8;
const MAX_CHECK_ARGUMENTS = 16;
const CHECK_TIMEOUT_MS = 30_000;
const CHECK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function runTrustedContractCheck(options: CheckOptions): TrustedContractViolation[] {
  const candidateRoot = canonicalDirectory(options.candidateRepoRoot);
  if (!candidateRoot) {
    return [violation("trusted-contract-candidate-invalid", CONTRACT_PATH, "Candidate checkout is unavailable.")];
  }

  const candidateConfigPath = resolveInside(candidateRoot, CONTRACT_PATH, "file", MAX_CONFIG_BYTES);
  const baseRoot = options.baseRepoRoot ? canonicalDirectory(options.baseRepoRoot) : undefined;
  const baseConfigPath = baseRoot
    ? resolveInside(baseRoot, CONTRACT_PATH, "file", MAX_CONFIG_BYTES)
    : undefined;

  if (!baseConfigPath) {
    if (options.requireTrustedContract) {
      return [violation("trusted-contract-base-missing", CONTRACT_PATH, "Trusted base contract is required.")];
    }
    if (!candidateConfigPath) return [];
    try {
      const candidateContract = loadContract(candidateConfigPath);
      validateContractFiles(candidateContract, candidateRoot);
      return [];
    } catch {
      return [violation("trusted-contract-config-invalid", CONTRACT_PATH, "Bootstrap contract is invalid.")];
    }
  }

  if (!candidateConfigPath) {
    return [violation("trusted-contract-config-removed", CONTRACT_PATH, "Trusted contract was removed.")];
  }

  try {
    const baseContract = loadContract(baseConfigPath);
    const candidateContract = loadContract(candidateConfigPath);
    validateContractFiles(baseContract, baseRoot!);
    validateContractFiles(candidateContract, candidateRoot);

    const violations: TrustedContractViolation[] = [];
    validateContractEvolution(baseContract, candidateContract, candidateRoot, violations);
    compareImmutableFiles(baseContract, baseRoot!, candidateRoot, violations);

    if (violations.length === 0) {
      runBaseChecks(baseContract, baseRoot!, candidateRoot, violations);
    }
    return violations;
  } catch {
    return [violation("trusted-contract-config-invalid", CONTRACT_PATH, "Trusted contract input is invalid.")];
  }
}

function loadContract(filePath: string): TrustedContract {
  const bytes = readFileSync(filePath);
  if (bytes.length === 0 || bytes.length > MAX_CONFIG_BYTES || hasUtf8Bom(bytes)) {
    throw new Error("invalid contract bytes");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseJsonRejectingDuplicateKeys(text);
  validateContractSchema(value);
  return value;
}

function validateContractSchema(value: unknown): asserts value is TrustedContract {
  if (!isPlainObject(value) || !hasExactKeys(value, ["schema_version", "immutable_files", "trusted_node_checks"])) {
    throw new Error("invalid contract object");
  }
  if (value.schema_version !== 1) throw new Error("unsupported contract schema");
  if (!Array.isArray(value.immutable_files) || value.immutable_files.length > MAX_IMMUTABLE_FILES) {
    throw new Error("invalid immutable file list");
  }
  const immutableFiles = value.immutable_files;
  if (new Set(immutableFiles).size !== immutableFiles.length) {
    throw new Error("duplicate immutable file");
  }
  for (const filePath of immutableFiles) assertSafeRelativePath(filePath, false);

  if (!isPlainObject(value.trusted_node_checks)) throw new Error("invalid trusted checks");
  const checkEntries = Object.entries(value.trusted_node_checks);
  if (checkEntries.length > MAX_TRUSTED_CHECKS) throw new Error("too many trusted checks");
  for (const [checkId, checkValue] of checkEntries) {
    if (!CHECK_ID.test(checkId) || !isPlainObject(checkValue) || !hasExactKeys(checkValue, ["entrypoint", "arguments"])) {
      throw new Error("invalid trusted check");
    }
    assertSafeRelativePath(checkValue.entrypoint, false);
    if (!checkValue.entrypoint.endsWith(".mjs") && !checkValue.entrypoint.endsWith(".js")) {
      throw new Error("invalid trusted check entrypoint");
    }
    if (!immutableFiles.includes(checkValue.entrypoint)) {
      throw new Error("trusted entrypoint must be immutable");
    }
    if (!Array.isArray(checkValue.arguments) || checkValue.arguments.length > MAX_CHECK_ARGUMENTS) {
      throw new Error("invalid trusted check arguments");
    }
    for (const argument of checkValue.arguments) {
      if (!isPlainObject(argument) || !hasExactKeys(argument, ["root", "path", "kind"])) {
        throw new Error("invalid trusted check argument");
      }
      if (argument.root !== "base" && argument.root !== "candidate") {
        throw new Error("invalid trusted check argument root");
      }
      if (argument.kind !== "file") {
        throw new Error("invalid trusted check argument kind");
      }
      assertSafeRelativePath(argument.path, false);
    }
  }
}

function validateContractFiles(contract: TrustedContract, repoRoot: string) {
  for (const filePath of contract.immutable_files) {
    if (!resolveInside(repoRoot, filePath, "file", MAX_IMMUTABLE_FILE_BYTES)) {
      throw new Error("immutable file unavailable");
    }
  }
  for (const check of Object.values(contract.trusted_node_checks)) {
    if (!resolveInside(repoRoot, check.entrypoint, "file", MAX_IMMUTABLE_FILE_BYTES)) {
      throw new Error("trusted entrypoint unavailable");
    }
    for (const argument of check.arguments) {
      if (!resolveInside(repoRoot, argument.path, argument.kind, MAX_IMMUTABLE_FILE_BYTES)) {
        throw new Error("trusted argument unavailable");
      }
    }
    collectImmutableModuleClosure(contract, repoRoot, check.entrypoint);
  }
}

function collectImmutableModuleClosure(
  contract: TrustedContract,
  repoRoot: string,
  entrypoint: string,
): Set<string> {
  const immutableFiles = new Set(contract.immutable_files);
  const visited = new Set<string>();
  const visit = (modulePath: string) => {
    if (visited.has(modulePath)) return;
    if (!immutableFiles.has(modulePath)) throw new Error("trusted module dependency is not immutable");
    visited.add(modulePath);
    const absolutePath = resolveInside(repoRoot, modulePath, "file", MAX_IMMUTABLE_FILE_BYTES);
    if (!absolutePath) throw new Error("trusted module dependency is unavailable");
    const bytes = readFileSync(absolutePath);
    if (hasUtf8Bom(bytes)) throw new Error("trusted module BOM is forbidden");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const specifier of parseStaticModuleSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error("trusted module package imports are forbidden");
      }
      if (specifier.includes("%") || specifier.includes("?") || specifier.includes("#") || specifier.includes("\\")) {
        throw new Error("trusted module import URL syntax is forbidden");
      }
      const dependencyPath = path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), specifier));
      assertSafeRelativePath(dependencyPath, false);
      if (!dependencyPath.endsWith(".mjs") && !dependencyPath.endsWith(".js")) {
        throw new Error("trusted module imports must include an extension");
      }
      visit(dependencyPath);
    }
  };
  visit(entrypoint);
  return visited;
}

function parseStaticModuleSpecifiers(source: string): string[] {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as AstNode;
  const specifiers: string[] = [];

  const readSource = (value: unknown): string => {
    if (!isAstNode(value) || value.type !== "Literal" || typeof value.value !== "string") {
      throw new Error("trusted module import is invalid");
    }
    return value.value;
  };

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isAstNode(value)) return;

    if (value.type === "ImportExpression") {
      throw new Error("dynamic trusted module loading is forbidden");
    }
    if (value.type === "CallExpression"
      && isAstNode(value.callee)
      && value.callee.type === "Identifier"
      && value.callee.name === "require") {
      throw new Error("dynamic trusted module loading is forbidden");
    }
    if (value.type === "ImportDeclaration"
      || value.type === "ExportNamedDeclaration"
      || value.type === "ExportAllDeclaration") {
      if (value.source !== null && value.source !== undefined) {
        specifiers.push(readSource(value.source));
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "start" && key !== "end" && key !== "loc" && key !== "range") visit(child);
    }
  };

  visit(program);
  return specifiers;
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string";
}

function validateContractEvolution(
  baseContract: TrustedContract,
  candidateContract: TrustedContract,
  candidateRoot: string,
  violations: TrustedContractViolation[],
) {
  const candidateFiles = new Set(candidateContract.immutable_files);
  for (const filePath of baseContract.immutable_files) {
    if (!candidateFiles.has(filePath)) {
      violations.push(violation("trusted-contract-weakened", CONTRACT_PATH, "An immutable file rule was removed."));
    }
  }
  for (const [checkId, baseCheck] of Object.entries(baseContract.trusted_node_checks)) {
    const candidateCheck = candidateContract.trusted_node_checks[checkId];
    if (!candidateCheck || stableJson(candidateCheck) !== stableJson(baseCheck)) {
      violations.push(violation("trusted-contract-weakened", CONTRACT_PATH, "A trusted check was removed or changed."));
    }
  }
  for (const [checkId, candidateCheck] of Object.entries(candidateContract.trusted_node_checks)) {
    if (!Object.hasOwn(baseContract.trusted_node_checks, checkId)) {
      const candidateClosure = collectImmutableModuleClosure(
        candidateContract,
        candidateRoot,
        candidateCheck.entrypoint,
      );
      const baseImmutableFiles = new Set(baseContract.immutable_files);
      if ([...candidateClosure].every((filePath) => baseImmutableFiles.has(filePath))) continue;
      violations.push(
        violation(
          "trusted-contract-check-not-staged",
          CONTRACT_PATH,
          "A new trusted check and its local dependency closure must be immutable in the base before activation.",
        ),
      );
    }
  }
}

function compareImmutableFiles(
  contract: TrustedContract,
  baseRoot: string,
  candidateRoot: string,
  violations: TrustedContractViolation[],
) {
  for (const filePath of contract.immutable_files) {
    const basePath = resolveInside(baseRoot, filePath, "file", MAX_IMMUTABLE_FILE_BYTES);
    const candidatePath = resolveInside(candidateRoot, filePath, "file", MAX_IMMUTABLE_FILE_BYTES);
    if (!basePath || !candidatePath || !readFileSync(basePath).equals(readFileSync(candidatePath))) {
      violations.push(
        violation("trusted-contract-immutable-file-changed", filePath, "An immutable file was removed or changed."),
      );
    }
  }
}

function runBaseChecks(
  contract: TrustedContract,
  baseRoot: string,
  candidateRoot: string,
  violations: TrustedContractViolation[],
) {
  for (const [checkId, check] of Object.entries(contract.trusted_node_checks)) {
    const entrypoint = resolveInside(baseRoot, check.entrypoint, "file", MAX_IMMUTABLE_FILE_BYTES);
    if (!entrypoint) {
      violations.push(violation("trusted-contract-check-unavailable", CONTRACT_PATH, "A trusted check is unavailable."));
      continue;
    }
    const args: string[] = [];
    let valid = true;
    for (const argument of check.arguments) {
      const argumentRoot = argument.root === "base" ? baseRoot : candidateRoot;
      const resolved = resolveInside(argumentRoot, argument.path, argument.kind, MAX_IMMUTABLE_FILE_BYTES);
      if (!resolved) {
        valid = false;
        break;
      }
      args.push(resolved);
    }
    if (!valid) {
      violations.push(violation("trusted-contract-check-input-invalid", CONTRACT_PATH, "A trusted check input is unavailable."));
      continue;
    }

    const result = spawnSync(process.execPath, [entrypoint, ...args], {
      cwd: baseRoot,
      encoding: "utf8",
      env: restrictedEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: "ignore",
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      violations.push(
        violation("trusted-contract-check-failed", CONTRACT_PATH, `Trusted check ${checkId} failed.`),
      );
    }
  }
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
  const permitted = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = { CI: "true" };
  for (const key of permitted) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function canonicalDirectory(root: string): string | undefined {
  try {
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    return realpathSync(root);
  } catch {
    return undefined;
  }
}

function resolveInside(
  root: string,
  relativePath: string,
  kind: "file" | "directory",
  maxBytes: number,
): string | undefined {
  try {
    assertSafeRelativePath(relativePath, kind === "directory");
    const lexicalPath = relativePath === "." ? root : path.join(root, ...relativePath.split("/"));
    if (hasSymlinkComponent(root, relativePath)) return undefined;
    const metadata = lstatSync(lexicalPath);
    if (metadata.isSymbolicLink()) return undefined;
    if (kind === "file" && (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes)) return undefined;
    if (kind === "directory" && !metadata.isDirectory()) return undefined;
    const canonicalPath = realpathSync(lexicalPath);
    const relative = path.relative(root, canonicalPath);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return undefined;
    return canonicalPath;
  } catch {
    return undefined;
  }
}

function hasSymlinkComponent(root: string, relativePath: string): boolean {
  if (relativePath === ".") return false;
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function assertSafeRelativePath(value: unknown, allowDot: boolean): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\\")) {
    throw new Error("invalid relative path");
  }
  if (allowDot && value === ".") return;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    throw new Error("invalid relative path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    throw new Error("invalid relative path");
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return stableJson(Object.keys(value).sort()) === stableJson([...expected].sort());
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function violation(rule: string, violationPath: string, message: string): TrustedContractViolation {
  return { rule, path: violationPath, message };
}

function parseJsonRejectingDuplicateKeys(raw: string): unknown {
  let index = 0;
  const fail = () => {
    throw new SyntaxError("invalid JSON");
  };
  const skipWhitespace = () => {
    while (index < raw.length && /[\t\n\r ]/.test(raw[index])) index += 1;
  };
  const readStringToken = () => {
    const start = index;
    if (raw[index] !== '"') fail();
    index += 1;
    while (index < raw.length) {
      const code = raw.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return raw.slice(start, index);
      }
      if (code === 0x5c) {
        index += 1;
        if (index >= raw.length) fail();
        const escape = raw[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(index + 1, index + 5))) fail();
          index += 5;
        } else if ('"\\/bfnrt'.includes(escape)) {
          index += 1;
        } else {
          fail();
        }
        continue;
      }
      if (code < 0x20) fail();
      index += 1;
    }
    fail();
  };
  const readLiteral = (literal: string) => {
    if (raw.slice(index, index + literal.length) !== literal) fail();
    index += literal.length;
  };
  const readNumber = () => {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = index;
    const result = match.exec(raw);
    if (!result) fail();
    const parsed = Number(result[0]);
    if (!Number.isSafeInteger(parsed) || String(parsed) !== result[0]) fail();
    index = match.lastIndex;
  };
  const readValue = () => {
    skipWhitespace();
    if (index >= raw.length) fail();
    const token = raw[index];
    if (token === '"') return void readStringToken();
    if (token === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      while (index < raw.length) {
        skipWhitespace();
        const key = JSON.parse(readStringToken()) as string;
        if (keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ":") fail();
        index += 1;
        readValue();
        skipWhitespace();
        if (raw[index] === "}") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      while (index < raw.length) {
        readValue();
        skipWhitespace();
        if (raw[index] === "]") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (token === "t") return readLiteral("true");
    if (token === "f") return readLiteral("false");
    if (token === "n") return readLiteral("null");
    if (token === "-" || /[0-9]/.test(token)) return readNumber();
    fail();
  };

  readValue();
  skipWhitespace();
  if (index !== raw.length) fail();
  return JSON.parse(raw);
}
