# CI Policy Rules

## PR 本文の最低限の記録を必須にする

`pull_request` では `## 概要` と `## テスト` を `policy / policy` job 内で検証します。
空の本文は bot を含めて失敗し、空でない Dependabot 本文は定型見出しを免除します。
本文編集時にも再検証するため、caller は `pull_request.types` に `edited` を含めます。

## GitHub Actions から deploy しない

GitHub Actions は test / lint / build verification までに限定します。deploy は Cloudflare Workers Builds、Vercel、Railway など各 platform 側の GitHub integration に寄せます。

禁止例:

- `wrangler deploy`
- `wrangler pages deploy`
- `vercel deploy`
- `railway up`
- `railway deploy`
- `aws cloudformation deploy`
- `aws amplify publish`

## CI に deploy token を置かない

GitHub Actions workflow から次の token 名を参照することを禁止します。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_TOKEN_FACTORY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `RAILWAY_TOKEN`
- `VERCEL_TOKEN`

## Bun repo は Bun のみ

`packageManager` が `bun@...`、または `bun.lock` がある repo は Bun repo とみなします。

- `bun.lock` が必要
- `package-lock.json` は禁止
- workflow の `npm ci` / `npm install` / `npm run` は禁止

## GitHub Actions の危険な trigger を禁止

`pull_request_target` は secret exposure と権限昇格の事故が起きやすいため禁止します。

## workflow permissions を明示する

全 workflow に top-level `permissions` を明示します。`write-all` は禁止します。

## action は allowlist または SHA pinning

`uses:` は次のどちらかを満たす必要があります。

- 許可済み action / reusable workflow を version tag で使う
- 40 桁 SHA に pin する

許可済み:

- `actions/checkout@v6`
- `actions/setup-node@v6`
- `actions/upload-artifact@v4` / `@v5`
- `oven-sh/setup-bun@v2`
- `github/codeql-action/*@v*`
- `yourbright-jp/ci-policy/.github/workflows/required-policy.yml@v3` / `@v4` / `@v5` / `@v6`
- `yourbright-jp/ci-policy/.github/workflows/coverage-policy.yml@v3` / `@v4` / `@v5` / `@v6`

## candidate が同じ PR で guardrail を弱めない

v6 は pull request / merge group / main push の base を別 checkout し、対象 repo の
`.github/ci-policy-exceptions.yaml` は base 版だけを信頼します。candidate が追加・延長した
例外は、その PR 自身の検査には適用しません。

`.github/ci-policy-contract.json` を opt-in した repo では、次も例外対象外として検査します。

- base 契約にある immutable file は byte 単位で変更・削除禁止
- base 契約にある trusted check は変更・削除禁止
- trusted check は base の entrypoint のみを、secret を除いた環境で実行
- candidate directoryは渡さず、列挙したregular fileだけを引数にする
- entrypointの静的なlocal import closureはAcornで構文解析し、すべてimmutable fileに含め、package/dynamic loaderとURL型specifierを拒否
- 新checkerは実装と全local dependency closureをimmutable化するPRとcheckを追加するPRの2段階で有効化し、どちらもcandidate codeを実行しない
- config / file / argument は closed schema、fatal UTF-8、BOM・duplicate key・symlink・escape・過大入力拒否

契約を caller workflow から独立して強制する場合は、組織 ruleset の
`Require workflows to pass before merging` で中央の
`.github/workflows/trusted-target-contracts.yml` を source workflow に指定します。
source workflowはbase契約のない対象をfail closedにするため、bootstrapをreview・mergeした後で
rulesetを有効化します。source refには更新・削除をtag rulesetで禁止したrelease tagを使います。

## public repo にプロジェクト固有情報を置かない

`yourbright-jp/ci-policy` は public repo です。中央 policy は組織共通の抽象ルールだけを持ち、個別プロジェクトの事情は対象 repo 側に置きます。

- 中央 `policies/exceptions.yaml`: public にできる global exception のみ
- 対象 repo `.github/ci-policy-exceptions.yaml`: プロジェクト固有の期限付き例外

中央 repo に private repo 名、Cloudflare account ID、Worker service 名、build URL、AWS account ID、Infisical path、secret value、内部 incident 詳細を入れてはいけません。
