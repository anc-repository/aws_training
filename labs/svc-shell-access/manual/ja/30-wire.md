---
step: wire
---

shell-access を有効にします。スクリプトは「締め出しを防ぐ」順序で実行します。ポリシーとセッションログのロググループをデプロイ → **先に**ポリシーをアタッチし、エージェントが `Online` であることを確認して Run Command でスモークテスト
→ セッション設定をバックアップして書き込み（runAs `cloudalbum-ops`、ログの書き込み先 `/cloudalbum/{{ session.env }}/ssm-sessions`）→ 最後に基盤スタックのパラメーター
`SshIngressCidr` を空にして 22 番ポートのルールを削除します。配信の際に、ラボ用インスタンスに `cloudalbum-ops` と制限付きの sudoers を作成します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable shell-access --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable shell-access
```
:::

:::wait{typical=3 max=10}
どれかの確認が失敗すると（エージェントがオンラインでない、スモークテストの失敗）、スクリプトは終了コード 5 で中止し、22 番ポートはそのままです。
:::

::console-link[EC2 コンソールでラボ用インスタンスのセキュリティグループを開く]{link=ec2.securityGroup sgId="{{ target.sgId }}"}

:::expected
shell-access のドライバーは `ssm` で状態は正常、detail には「Agent Online（版本 …） · 无管理端口入站 · 会话日志 → /cloudalbum/{{ session.env }}/ssm-sessions」（エージェントがオンライン・管理ポートの受信なし・セッションログの出力先）と表示されます。
セキュリティグループに 22 番ポートのルールはもうありません。
:::

:::saa{domain=secure confusable="AmazonSSMManagedInstanceCore vs 最小权限"}
`AmazonSSMManagedInstanceCore` は手軽ですが、**すべての** Parameter Store パラメーターを読む権限も与えてしまいます。このモジュールのポリシーに含まれるのは、セッションと Run Command
に必要な部分、セッションログの書き込み、検知処理の読み取り専用の呼び出し、そして `/cloudalbum/{{ session.env }}/handoff/*` の使い捨ての受け渡し用パラメーターの読み取りだけです（`scripts/module`
が SSM でシークレットを配信するときは SecureString で受け渡し、使い終わったら削除します）。`--param ManagedCore=true` を指定すると、比較用にマネージドポリシーを残します。
:::

:::tip
スタンドアロンモード（自分のアカウントで、プラットフォームを使わない場合）では、このモジュールを有効にすると `scripts/module` の配信チャネルが SSM になります。シークレットは SecureString の受け渡し用パラメーターを通じて `secrets.env` に**書き込む**だけで、
読み戻すことはありません（Run Command の出力はコマンド履歴に残るためです）。その後、既存のシークレットを引き継ぐ必要があるモジュール（cdn の `ORIGIN_VERIFY`、
database の `DB_PASSWORD`、image-processing の `CALLBACK_HMAC_KEY`）を有効にしようとすると `SECRETS_READBACK_OVER_SSM` で中止され、対処法が示されます。
それらのモジュールを先に有効にしてから shell-access を有効にする、有効にするときに `--param KeepSsh=true` で 22 番ポートを残し、それらのコマンドに `--delivery ssh` を付ける、
あるいは先に `scripts/module disable shell-access --reopen-ssh` を実行する、のいずれかです。
:::

::checks
