---
step: inspect-bucket
---

元画像バケットのセキュリティとコストの設定を読み解きます。これらの設定はモジュールのテンプレートが行うもので、**見るだけで変更しません**。

:::method{kind=console default}
::console-link[元画像バケットを開く]{link=s3.bucket bucket="{{ var.rawBucket }}"}

1. 「アクセス許可」：パブリックアクセスのブロックの 4 項目がすべてオンです。オブジェクト所有者は「バケット所有者の強制」（ACL は無効）です。バケットポリシーは HTTPS 以外のリクエストを拒否します（`aws:SecureTransport`）。
2. 「プロパティ」：バージョニングが有効です。デフォルト暗号化は SSE-S3（または SSE-KMS）です。イベント通知は「Amazon EventBridge」だけがオンです。
3. 「管理」：ライフサイクルルールで、元画像は 30 日後に Standard-IA に移行し、最新でないバージョンは 30 日後に失効し、未完了のマルチパートアップロードは中止されます。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws s3api get-public-access-block --bucket {{ var.rawBucket }}
aws s3api get-bucket-versioning --bucket {{ var.rawBucket }}
aws s3api get-bucket-encryption --bucket {{ var.rawBucket }}
aws s3api get-bucket-notification-configuration --bucket {{ var.rawBucket }}
aws s3api get-bucket-lifecycle-configuration --bucket {{ var.rawBucket }}
```
:::

:::why
**なぜ EventBridge への配信だけを有効にするのでしょうか？** 同じイベントタイプで重なるプレフィックスの S3 イベント通知には、送信先を 1 つしか設定できません。EventBridge にまとめて配信すれば、
image-processing や tagging などのモジュールがそれぞれ自分のスタックでルールを作って消費でき、互いに衝突しません（MUTEX-004）。
:::

:::saa{domain=cost confusable="Standard-IA vs Intelligent-Tiering"}
Standard-IA には 30 日の最短保存期間と 128 KB の最小課金サイズがあり、MB 単位でアクセス頻度の低い元画像に向いています。Intelligent-Tiering は 128 KB 未満のオブジェクトを自動で階層化しません。
:::

::checks
