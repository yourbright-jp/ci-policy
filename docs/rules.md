# CI Policy Rules

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
- `oven-sh/setup-bun@v2`
- `github/codeql-action/*@v*`
- `yourbright-jp/ci-policy/.github/workflows/required-policy.yml@v3`

## public repo にプロジェクト固有情報を置かない

`yourbright-jp/ci-policy` は public repo です。中央 policy は組織共通の抽象ルールだけを持ち、個別プロジェクトの事情は対象 repo 側に置きます。

- 中央 `policies/exceptions.yaml`: public にできる global exception のみ
- 対象 repo `.github/ci-policy-exceptions.yaml`: プロジェクト固有の期限付き例外

中央 repo に private repo 名、Cloudflare account ID、Worker service 名、build URL、AWS account ID、Infisical path、secret value、内部 incident 詳細を入れてはいけません。
