import { describe, expect, test } from "bun:test";

import { validatePrBody } from "./check-pr-body";

describe("validatePrBody", () => {
  test("requires both standard sections", () => {
    expect(validatePrBody("## 概要\n\n変更内容", "octocat")).toEqual({
      ok: false,
      missing: ["## テスト"],
      empty: false,
    });
  });

  test("accepts a complete body", () => {
    expect(validatePrBody("## 概要\n\n変更内容\n\n## テスト\n\n- bun test", "octocat")).toEqual({
      ok: true,
      missing: [],
      empty: false,
    });
  });

  test("keeps empty Dependabot bodies invalid", () => {
    expect(validatePrBody("", "dependabot[bot]")).toEqual({
      ok: false,
      missing: ["## 概要", "## テスト"],
      empty: true,
    });
  });

  test("exempts non-empty Dependabot bodies from custom headings", () => {
    expect(validatePrBody("Bumps a dependency.", "dependabot[bot]")).toEqual({
      ok: true,
      missing: [],
      empty: false,
    });
  });
});
