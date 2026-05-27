# YourBright CI Policy

YourBright org の GitHub Actions 規約を reusable workflow として管理するリポジトリです。**Guardrails 層** — 各 repo の CI から `uses:` で呼ばれ、required status check として merge を強制ブロックする。

## 思想 / 設計原則

YourBright の org-wide harness は **2 レイヤ構成**。それぞれ役割が違い、可視性も違う。

| レイヤ | 役割 | 強制度 | visibility | CI から呼ぶ |
|---|---|---|---|---|
| **Guardrails** (this repo) | 検査と強制 | required check で merge block | public | はい (`uses:` で reusable workflow) |
| **Golden Path** (別の private repo) | 推奨と雛形 | 推奨、各 repo が opt-in | private | いいえ (CI から checkout しない) |

### なぜ 2 repo に分けるか

Platform Engineering の業界標準は **「強制が必要なもの (Guardrails)」と「推奨でいいもの (Golden Path)」をレイヤとして分離**することにある。Backstage の software template と OPA policy、Cruft / Copier と CI checks、Renovate centralized preset と required checks、いずれも同じ構造。両者を混在させると、強制側に推奨内容が紛れ込んで運用が硬直化し、推奨側に強制要素が混じって採用率が落ちる。

### なぜ ci-policy は public か

caller (各 repo) の CI は `actions/checkout` で reusable workflow を取得する。**private repo を別 private repo から checkout すると `GITHUB_TOKEN` ではアクセスできず、GitHub App / PAT が必要**になる。Guardrails 層は全 caller から CI runtime に呼ばれるため、認証コストを払わず public で配布するのが業界の標準解。代償として **機密はここに置けない** (下記「例外」と「Public Repo Hygiene」を参照)。

機密性のあるテンプレや社内固有情報は Golden Path 側 (別の private repo) に置く。

### なぜ強制レイヤをここに置くか

Guardrails の本質は「壊れたものが main に入らない」という merge block の機能。required status check として動かないと意味がない。**強制力を担保するために public で配布 + caller の CI から `uses:` で呼ばれる**、この設計は妥協ではなく機能要件から導かれる。

### 推奨レイヤ (Golden Path) は別の private repo へ

AGENTS.md テンプレ、lefthook.yml、`.mise.toml`、scaffolds、内部ドキュメント、社内固有の規約 — これらは **CI 強制から外し**、各 repo が opt-in で取り込む形にする。配布手段は手動 copy / Cruft / Copier / Renovate preset / 自前 sync action のいずれか。runtime fetch せず **commit して使う**。詳細は org 内部の Golden Path repo を参照 (private)。

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

GitHub の ruleset では、各 repo の `policy / policy` check を required status check にします。

注意: private repo で required status check を強制するには GitHub Team/Pro 以上、または対象 repo の public 化が必要です。GitHub Free の private repo では policy check は実行できますが、merge button の強制ブロックは GitHub 側で有効化できません。

## 標準 ruleset

production branch は repo ruleset 2 本で保護します。classic branch protection は新規 repo では使いません。

### main-integrity-required

CI と履歴保護の土台です。bypass は設定しません。

- Target: default branch
- Enforcement: active
- Required pull request: on
- Required status checks: strict
  - `policy / policy`
  - repo 固有の verify check
  - repo 固有の package manager check
  - repo 固有の PR policy check
- Restrict deletions: on
- Block force pushes: on

### main-review-gate

通常レビューのための gate です。solo admin 運用で詰まらないよう、repository admin は pull request 上だけ bypass 可能にします。

- Target: default branch
- Enforcement: active
- Required pull request approvals: 1
- Require approval of the most recent reviewable push: on
- Require conversation resolution: on
- Bypass actor: Repository admin
- Bypass mode: Pull requests only

この分割により、admin は緊急時に review gate だけ bypass できますが、`main-integrity-required` の PR 経由、required status checks、force push 禁止、branch deletion 禁止は bypass できません。

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
