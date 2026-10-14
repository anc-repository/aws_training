---
step: enable
---

storage を有効にします。モジュールは元画像バケットと表示用バケットをデプロイし、読み取り専用の時間帯に既存の写真を S3 に移行してから、ドライバーを切り替え、再起動して詳細プローブを実行します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable storage --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable storage
```
:::

:::wait{typical=3 max=15}
移行中、アプリは読み取り専用です（閲覧はできますが、アップロードはできません）。移行が終わったら、アプリのプレビューで写真を 1 枚アップロードし、実際の署名付きアップロードをプラットフォームに 1 回見せてください。
:::

:::expected
storage の状態が「正常」です。メディア URL のホストは `cloudalbum-{{ session.env }}-storage-（raw または media）-<アカウント>-<リージョン>.s3.{{ session.region }}.amazonaws.com` で、署名パラメーターが付いています。
アップロードリクエストの経路ヘッダーに `storage=s3:presign` が現れます。
:::

::checks
