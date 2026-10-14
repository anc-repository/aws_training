---
step: before-lockout
---

before を記録します。1 つのテストアカウントに誤ったパスワードを 30 回続けて送信し、レスポンスコードの並びを記録します。管理者アカウントに対しては**実行しないでください**（ロックされます。スクリプトも拒否します）。

```bash {runsOn=workstation}
npm run exp -- auth --label before --scenario brute-force --param email=atl-test-3@example.com --upload
```

::experiment{module=auth id=brute-force label=before}

:::expected
レポートの並びは `401×5, 423×…` のようになるか、`429` が現れます。ローカルドライバーはアカウントごとに回数を数えてロックし、さらに Nginx が送信元ごとにレートを制限します。
:::

:::why
**ローカルでロックする代償**：回数をどこかに保存しなければなりません。単一インスタンスならそのホストのデータベースで済みますが、複数インスタンスに増やすと状態を共有する必要があり、そうしないと攻撃者はリクエストを別々のインスタンスに分散するだけで回避できます。
Cognito の一時的なロックは全体で一元管理されているため、アプリが気にする必要はありません。
:::

::checks
