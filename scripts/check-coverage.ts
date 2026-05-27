import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export type CoverageTotals = {
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
};

export type CoverageResult = {
  ok: boolean;
  totals: CoverageTotals;
  linePct: number;
  branchPct: number;
  violations: string[];
};

export type CoverageThresholds = {
  line: number;
  branch: number;
};

export function parseLcov(content: string): CoverageTotals {
  const totals: CoverageTotals = {
    linesFound: 0,
    linesHit: 0,
    branchesFound: 0,
    branchesHit: 0
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);

    switch (key) {
      case "LF": totals.linesFound += toInt(value); break;
      case "LH": totals.linesHit += toInt(value); break;
      case "BRF": totals.branchesFound += toInt(value); break;
      case "BRH": totals.branchesHit += toInt(value); break;
    }
  }

  return totals;
}

export function evaluateCoverage(
  totals: CoverageTotals,
  thresholds: CoverageThresholds
): CoverageResult {
  const linePct = pct(totals.linesHit, totals.linesFound);
  const branchPct = pct(totals.branchesHit, totals.branchesFound);
  const violations: string[] = [];

  if (totals.linesFound === 0) {
    violations.push("lcov.info contains no line records (LF). Coverage cannot be evaluated.");
  } else if (linePct < thresholds.line) {
    violations.push(
      `line coverage ${linePct.toFixed(2)}% is below threshold ${thresholds.line}%`
    );
  }

  if (totals.branchesFound > 0 && branchPct < thresholds.branch) {
    violations.push(
      `branch coverage ${branchPct.toFixed(2)}% is below threshold ${thresholds.branch}%`
    );
  }

  return {
    ok: violations.length === 0,
    totals,
    linePct,
    branchPct,
    violations
  };
}

export function checkCoverageFile(
  lcovPath: string,
  thresholds: CoverageThresholds
): CoverageResult {
  if (!existsSync(lcovPath)) {
    return {
      ok: false,
      totals: { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 },
      linePct: 0,
      branchPct: 0,
      violations: [`coverage report not found at ${lcovPath}`]
    };
  }

  const content = readFileSync(lcovPath, "utf8");
  const totals = parseLcov(content);
  return evaluateCoverage(totals, thresholds);
}

function toInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(hit: number, found: number): number {
  if (found === 0) return 0;
  return (hit / found) * 100;
}

function parseArgs(argv: string[]): {
  lcovPath: string;
  thresholds: CoverageThresholds;
} {
  let lcovPath = "coverage/lcov.info";
  let line = 60;
  let branch = 50;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--lcov": lcovPath = next() ?? lcovPath; break;
      case "--line": line = Number.parseFloat(next() ?? `${line}`); break;
      case "--branch": branch = Number.parseFloat(next() ?? `${branch}`); break;
      case "--repo": {
        const repo = next();
        if (repo) lcovPath = path.join(repo, lcovPath);
        break;
      }
    }
  }

  return { lcovPath, thresholds: { line, branch } };
}

if (import.meta.main) {
  const { lcovPath, thresholds } = parseArgs(process.argv.slice(2));
  const result = checkCoverageFile(lcovPath, thresholds);

  console.log(`lcov: ${lcovPath}`);
  console.log(
    `lines:    ${result.totals.linesHit}/${result.totals.linesFound} (${result.linePct.toFixed(2)}%) >= ${thresholds.line}%`
  );
  console.log(
    `branches: ${result.totals.branchesHit}/${result.totals.branchesFound} (${result.branchPct.toFixed(2)}%) >= ${thresholds.branch}%`
  );

  if (!result.ok) {
    for (const v of result.violations) console.error(`coverage gate failed: ${v}`);
    process.exit(1);
  }

  console.log("coverage gate passed");
}
