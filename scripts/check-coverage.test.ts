import { describe, expect, test } from "bun:test";
import { evaluateCoverage, parseLcov } from "./check-coverage";

const SAMPLE_LCOV = `TN:
SF:src/a.ts
LF:10
LH:9
BRF:4
BRH:3
end_of_record
TN:
SF:src/b.ts
LF:10
LH:7
BRF:6
BRH:3
end_of_record
`;

describe("parseLcov", () => {
  test("sums totals across files", () => {
    const totals = parseLcov(SAMPLE_LCOV);
    expect(totals).toEqual({
      linesFound: 20,
      linesHit: 16,
      branchesFound: 10,
      branchesHit: 6
    });
  });

  test("ignores empty and malformed lines", () => {
    const totals = parseLcov("\n\nnotvalid\nLF:5\nLH:5\nend_of_record\n");
    expect(totals.linesFound).toBe(5);
    expect(totals.linesHit).toBe(5);
  });
});

describe("evaluateCoverage", () => {
  test("passes when both metrics meet thresholds", () => {
    const totals = parseLcov(SAMPLE_LCOV);
    const result = evaluateCoverage(totals, { line: 80, branch: 60 });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.linePct).toBe(80);
    expect(result.branchPct).toBe(60);
  });

  test("fails when line coverage is below threshold", () => {
    const totals = parseLcov(SAMPLE_LCOV);
    const result = evaluateCoverage(totals, { line: 90, branch: 60 });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/line coverage/);
  });

  test("fails when branch coverage is below threshold", () => {
    const totals = parseLcov(SAMPLE_LCOV);
    const result = evaluateCoverage(totals, { line: 80, branch: 70 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => /branch coverage/.test(v))).toBe(true);
  });

  test("skips branch check when no branches recorded", () => {
    const result = evaluateCoverage(
      { linesFound: 10, linesHit: 10, branchesFound: 0, branchesHit: 0 },
      { line: 80, branch: 70 }
    );
    expect(result.ok).toBe(true);
  });

  test("fails when no lines recorded at all", () => {
    const result = evaluateCoverage(
      { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 },
      { line: 80, branch: 70 }
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/no line records/);
  });
});
