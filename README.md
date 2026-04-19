# YourBright CI Policy

YourBright org の GitHub Actions 規約を reusable workflow として管理するリポジトリです。

## 使い方

各リポジトリに `.github/workflows/policy.yml` を追加します。

```yaml
name: policy

on:
  push:
    branches:
      - main
  pull_request:

permissions:
  contents: read

jobs:
  policy:
    permissions:
      contents: read
    uses: yourbright-jp/ci-policy/.github/workflows/required-policy.yml@v3
    with:
      repository: yourbright-jp/example-repo
```

GitHub の branch protection / ruleset では、各 repo の `policy / policy` check を required status check にします。

注意: private repo で required status check を強制するには GitHub Team/Pro 以上、または対象 repo の public 化が必要です。GitHub Free の private repo では policy check は実行できますが、merge button の強制ブロックは GitHub 側で有効化できません。

## ローカル検証

```bash
bun install --frozen-lockfile
bun run check -- --repo /path/to/repo --repository yourbright-jp/example-repo
```

## 例外

このリポジトリは public です。プロジェクト固有の repo 名、内部 service 名、account ID、build URL、secret 名の利用事情が分かる例外理由をここに置かないでください。

中央の `policies/exceptions.yaml` は public にしてよい global exception だけに限定します。通常のプロジェクト固有例外は、対象 repo 側の `.github/ci-policy-exceptions.yaml` に期限付きで追加します。対象 repo が private なら、その例外内容も private repo 内に留まります。

```yaml
exceptions:
  - repo: yourbright-jp/example-repo
    rule: github-actions-uses-allowlist
    path: .github/workflows/test.yml
    reason: 移行期間中だけ既存 action を許可する
    owner: "@yourbright-jp/platform"
    expires: "2026-05-31"
```

## 管理している規約

詳細は [docs/rules.md](docs/rules.md) を参照してください。

## Public Repo Hygiene

この repo に入れてよいもの:

- 組織共通の抽象ルール
- public にして問題ない action allowlist
- placeholder の repo 名、例: `yourbright-jp/example-repo`

入れてはいけないもの:

- private project の実 repo 名を伴う例外
- Cloudflare account ID、Worker service 名、build URL
- AWS account ID、SSO URL、resource ARN
- Infisical path、secret value、credential value
- 顧客名、個別 campaign 名、内部 incident の詳細
