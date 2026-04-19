import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import yaml from "js-yaml";

export type Violation = {
  rule: string;
  path: string;
  message: string;
};

type ExceptionEntry = {
  repo?: string | string[];
  repository?: string | string[];
  rule: string;
  path?: string;
  pattern?: string;
  reason?: string;
  owner?: string;
  expires?: string | Date;
};

type CheckOptions = {
  repoRoot: string;
  repository: string;
  exceptionsPath?: string;
  now?: Date;
};

type CheckResult = {
  ok: boolean;
  violations: Violation[];
};

const WORKFLOW_DIR = ".github/workflows";

const ALLOWED_USES = [
  /^actions\/checkout@v6$/,
  /^actions\/setup-node@v6$/,
  /^oven-sh\/setup-bun@v2$/,
  /^github\/codeql-action\/[^@\s]+@v\d+$/,
  /^yourbright-jp\/ci-policy\/\.github\/workflows\/required-policy\.yml@v2$/
];

const DEPLOY_COMMANDS = [
  /\bwrangler\s+(?:deploy|pages\s+deploy)\b/i,
  /\bvercel\s+(?:deploy|--prod)\b/i,
  /\brailway\s+(?:up|deploy)\b/i,
  /\baws\s+cloudformation\s+deploy\b/i,
  /\baws\s+amplify\s+publish\b/i
];

const TOKEN_REFERENCES =
  /\b(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_TOKEN_FACTORY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|RAILWAY_TOKEN|VERCEL_TOKEN)\b/;

const NPM_COMMAND = /\bnpm\s+(?:ci|install|run)\b/;
const SHA_PIN = /@[a-f0-9]{40}$/i;

export function runPolicyCheck(options: CheckOptions): CheckResult {
  const repoRoot = path.resolve(options.repoRoot);
  const now = options.now ?? new Date();
  const exceptions = loadExceptions(options.exceptionsPath ?? path.join(process.cwd(), "policies", "exceptions.yaml"));
  const violations: Violation[] = [];

  const bunRepo = isBunRepo(repoRoot);
  if (bunRepo && !existsSync(path.join(repoRoot, "bun.lock"))) {
    violations.push({
      rule: "bun-repo-lockfile-required",
      path: "bun.lock",
      message: "Bun repo must commit bun.lock."
    });
  }

  if (bunRepo && existsSync(path.join(repoRoot, "package-lock.json"))) {
    violations.push({
      rule: "bun-repo-package-lock-forbidden",
      path: "package-lock.json",
      message: "Bun repo must not commit package-lock.json."
    });
  }

  for (const workflowPath of listWorkflowFiles(repoRoot)) {
    const absolutePath = path.join(repoRoot, workflowPath);
    const workflow = readWorkflow(absolutePath);

    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      violations.push({
        rule: "workflow-yaml-invalid",
        path: workflowPath,
        message: "Workflow YAML must be a mapping."
      });
      continue;
    }

    checkWorkflow(workflow as Record<string, unknown>, workflowPath, bunRepo, violations);
  }

  const activeViolations = violations.filter(
    (violation) => !isExcepted(violation, exceptions, options.repository, now)
  );

  return {
    ok: activeViolations.length === 0,
    violations: activeViolations
  };
}

function checkWorkflow(
  workflow: Record<string, unknown>,
  workflowPath: string,
  bunRepo: boolean,
  violations: Violation[]
) {
  if (workflow.permissions === undefined) {
    violations.push({
      rule: "workflow-permissions-required",
      path: workflowPath,
      message: "Workflow must declare top-level permissions."
    });
  } else if (workflow.permissions === "write-all") {
    violations.push({
      rule: "workflow-permissions-write-all-forbidden",
      path: workflowPath,
      message: "Workflow permissions must not be write-all."
    });
  }

  if (hasPullRequestTarget(workflow.on)) {
    violations.push({
      rule: "pull-request-target-forbidden",
      path: workflowPath,
      message: "pull_request_target is forbidden for org repositories."
    });
  }

  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    return;
  }

  for (const [jobId, jobValue] of Object.entries(jobs)) {
    if (!jobValue || typeof jobValue !== "object" || Array.isArray(jobValue)) {
      continue;
    }

    const job = jobValue as Record<string, unknown>;
    if (typeof job.uses === "string") {
      checkUses(job.uses, `${workflowPath}:jobs.${jobId}.uses`, violations);
    }

    if (!Array.isArray(job.steps)) {
      continue;
    }

    job.steps.forEach((stepValue, stepIndex) => {
      if (!stepValue || typeof stepValue !== "object" || Array.isArray(stepValue)) {
        return;
      }

      const step = stepValue as Record<string, unknown>;
      const stepPath = `${workflowPath}:jobs.${jobId}.steps[${stepIndex}]`;

      if (typeof step.uses === "string") {
        checkUses(step.uses, `${stepPath}.uses`, violations);
      }

      if (typeof step.run === "string") {
        checkRun(step.run, stepPath, bunRepo, violations);
      }
    });
  }
}

function checkUses(uses: string, location: string, violations: Violation[]) {
  if (uses.startsWith("./") || uses.startsWith("docker://") || SHA_PIN.test(uses)) {
    return;
  }

  if (ALLOWED_USES.some((allowed) => allowed.test(uses))) {
    return;
  }

  violations.push({
    rule: "github-actions-uses-allowlist",
    path: location,
    message: `uses '${uses}' must be on the allowlist or pinned to a 40-character commit SHA.`
  });
}

function checkRun(run: string, location: string, bunRepo: boolean, violations: Violation[]) {
  if (DEPLOY_COMMANDS.some((command) => command.test(run))) {
    violations.push({
      rule: "no-deploy-command-in-actions",
      path: location,
      message: "Deploy commands must not run in GitHub Actions."
    });
  }

  if (TOKEN_REFERENCES.test(run)) {
    violations.push({
      rule: "no-deploy-token-reference-in-actions",
      path: location,
      message: "Deploy token references must not appear in GitHub Actions."
    });
  }

  if (bunRepo && NPM_COMMAND.test(run)) {
    violations.push({
      rule: "bun-repo-npm-command-forbidden",
      path: location,
      message: "Bun repos must use bun commands instead of npm commands in workflows."
    });
  }
}

function hasPullRequestTarget(onValue: unknown): boolean {
  if (typeof onValue === "string") {
    return onValue === "pull_request_target";
  }

  if (Array.isArray(onValue)) {
    return onValue.includes("pull_request_target");
  }

  if (onValue && typeof onValue === "object") {
    return Object.prototype.hasOwnProperty.call(onValue, "pull_request_target");
  }

  return false;
}

function isBunRepo(repoRoot: string): boolean {
  if (existsSync(path.join(repoRoot, "bun.lock"))) {
    return true;
  }

  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { packageManager?: unknown };
    return typeof packageJson.packageManager === "string" && packageJson.packageManager.startsWith("bun@");
  } catch {
    return false;
  }
}

function listWorkflowFiles(repoRoot: string): string[] {
  const workflowDir = path.join(repoRoot, WORKFLOW_DIR);
  if (!existsSync(workflowDir)) {
    return [];
  }

  return readdirSync(workflowDir)
    .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"))
    .sort()
    .map((fileName) => path.join(WORKFLOW_DIR, fileName).replaceAll(path.sep, "/"));
}

function readWorkflow(filePath: string): unknown {
  return yaml.load(readFileSync(filePath, "utf8"));
}

function loadExceptions(exceptionsPath: string): ExceptionEntry[] {
  if (!existsSync(exceptionsPath)) {
    return [];
  }

  const parsed = yaml.load(readFileSync(exceptionsPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const exceptions = (parsed as { exceptions?: unknown }).exceptions;
  return Array.isArray(exceptions) ? (exceptions as ExceptionEntry[]) : [];
}

function isExcepted(violation: Violation, exceptions: ExceptionEntry[], repository: string, now: Date): boolean {
  return exceptions.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    if (!matchesRepository(entry.repo ?? entry.repository, repository)) {
      return false;
    }

    if (entry.rule !== violation.rule && entry.rule !== "*") {
      return false;
    }

    if (entry.path && entry.path !== violation.path) {
      return false;
    }

    if (entry.pattern && !new RegExp(entry.pattern).test(violation.message)) {
      return false;
    }

    if (!entry.expires) {
      return false;
    }

    const expires = entry.expires instanceof Date ? entry.expires : new Date(entry.expires);
    if (Number.isNaN(expires.getTime())) {
      return false;
    }

    return expires >= now;
  });
}

function matchesRepository(value: string | string[] | undefined, repository: string): boolean {
  if (value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.includes(repository) || value.includes("*");
  }

  return value === repository || value === "*";
}

function parseArgs(argv: string[]): CheckOptions {
  let repoRoot = process.cwd();
  let repository = process.env.TARGET_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "unknown/unknown";
  let exceptionsPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") {
      repoRoot = argv[++index] ?? repoRoot;
    } else if (value === "--repository") {
      repository = argv[++index] ?? repository;
    } else if (value === "--exceptions") {
      exceptionsPath = argv[++index];
    }
  }

  return { repoRoot, repository, exceptionsPath };
}

if (import.meta.main) {
  const result = runPolicyCheck(parseArgs(process.argv.slice(2)));

  if (result.ok) {
    console.log("CI policy passed.");
  } else {
    console.error("CI policy failed:");
    for (const violation of result.violations) {
      console.error(`- [${violation.rule}] ${violation.path}: ${violation.message}`);
    }
    process.exit(1);
  }
}
