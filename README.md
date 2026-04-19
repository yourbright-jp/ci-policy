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
    uses: yourbright-jp/ci-policy/.github/workflows/required-policy.yml@v1
    with:
      repository: yourbright-jp/example-repo
```

GitHub の branch protection / ruleset では、各 repo の `policy / policy` check を required status check にします。

## ローカル検証

```bash
bun install --frozen-lockfile
bun run check -- --repo /path/to/repo --repository yourbright-jp/example-repo
```

## 例外

例外は `policies/exceptions.yaml` に期限付きで追加します。期限切れの例外は無視されます。

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

