---
step: enable-tls
---

:::method{kind=script default}
まず変更内容をプレビューします（リソースを変更する API は一切呼び出しません）。

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --dry-run
```

内容を確認したら実行します（このアカウントにそのドメインの Route 53 ホストゾーンがある場合は `--zone-id <ID>` を付けると、検証レコードが自動で作成されます）。

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }}
```
:::

### ACME の分岐（バリアント `default`）

スクリプトは次の順に処理します。tls スタック（ACME エンドポイント、事前承認されたドメイン検証、発行ロール `cloudalbum-{{ session.env }}-acme-issuer`）をデプロイ → **ドメイン検証の CNAME** を表示 →
それが `VALID` になるのを待つ → 有効期間 1 日の EAB を作成 → 配信チャネル経由でラボ用インスタンスで certbot を実行し、登録と発行を完了（クライアントのタイムアウト 120 秒）→ EAB を削除 →
`tls.env` を配信し、hostSetup が `/etc/cloudalbum/tls/server.*` を新しい証明書に切り替えて Nginx を reload します。

:::wait{typical=5 max=30}
スクリプトが表示した CNAME をあなたの DNS に追加し、**ずっと残しておいてください**。これは永続的な事前承認の検証で、削除すると新しい発行も更新も失敗します。
**なぜ 80 番ポートをインターネットに開けなくてよいのでしょうか？** `PRE_APPROVED` のドメイン検証は証明書を申請する前に完了しているため、certbot の申請時にオンラインのチャレンジがありません。
Let's Encrypt の HTTP-01 では 80 番ポートに到達できる必要があります。
:::

Nginx の証明書が替わったことを確認します。

```bash {runsOn=lab}
openssl s_client -connect 127.0.0.1:443 </dev/null 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName -dates
```

:::expected
発行者は Amazon、SAN は `DNS:{{ learner.inputs.domain }}`、有効期間は約 45 日です。ブラウザーで `https://{{ learner.inputs.domain }}/` を開くと鍵マークが表示されます。
:::

### フォールバックの分岐（バリアント `acme-off`）

スクリプトは **us-east-1** に tls-edge スタックをデプロイして統合証明書を申請し（DNS 検証）、証明書と代替ドメイン名を cdn スタックに注入します。ホストゾーンがない場合、CloudFormation は検証を待ちます。
ACM コンソール（米国東部（バージニア北部）に切り替え）で検証用の CNAME を確認し、あなたの DNS に追加してください。完了したら `{{ learner.inputs.domain }}` を A レコードから
ディストリビューションのデフォルトのドメイン名への CNAME に変更します。

::console-link[このセッションの CloudFront ディストリビューションを開く]{link=cloudfront.distribution distributionId="{{ envfile.cdn.CDN_DISTRIBUTION_ID }}"}

:::expected
ディストリビューションの「代替ドメイン名」はあなたのドメインで、「カスタム SSL 証明書」は us-east-1 のものです。`https://{{ learner.inputs.domain }}/` に鍵マークが表示され、経路ヘッダーは `entry=cloudfront>nginx` です。
ラボ用インスタンスへの直接アクセスの 443 は自己署名証明書のままです。ACM 証明書は CloudFront にしか付けられないからです（試験の結論）。
:::

::checks
