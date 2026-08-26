import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REQUIRED_PR_SECTIONS = ["## 概要", "## テスト"] as const;

export type PrBodyValidation = {
  ok: boolean;
  missing: string[];
  empty: boolean;
};

export function validatePrBody(body: string, author: string): PrBodyValidation {
  if (body.trim().length === 0) {
    return { ok: false, missing: [...REQUIRED_PR_SECTIONS], empty: true };
  }

  if (author === "dependabot[bot]") {
    return { ok: true, missing: [], empty: false };
  }

  const missing = REQUIRED_PR_SECTIONS.filter((section) => !body.includes(section));
  return { ok: missing.length === 0, missing, empty: false };
}

function main() {
  const result = validatePrBody(process.env.PR_BODY ?? "", process.env.PR_AUTHOR ?? "");
  if (result.ok) return;

  if (result.empty) {
    console.error("PR body が空です。'## 概要' と '## テスト' セクションを追加してください。");
  } else {
    console.error("PR body に以下の必須セクションがありません:");
    for (const section of result.missing) console.error(`  - '${section}'`);
  }
  process.exit(1);
}

const entrypoint = process.argv[1];
if (entrypoint && path.resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  main();
}
