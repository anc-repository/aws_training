---
step: enable
---

Cognito を有効にします。モジュールは User Pool（`Retain` + 削除保護、ユーザー名はメールアドレス、パスワードポリシー、任意の TOTP）、パブリックなアプリクライアント `cloudalbum-spa`、
ユーザーグループ admin / member をデプロイし、読み取り専用期間中にローカルのアカウントを User Pool に bulk 移行します（`AdminCreateUser` + `MessageAction=SUPPRESS`、招待メールは送りません）。
その後 `auth.env` を書き込んで再起動します。最後にワークベンチであなたの権限でフック `cognito-passwords` を実行し、テストアカウントに既知のパスワードを設定します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable auth --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable auth
```
:::

:::wait{typical=4 max=15}
デプロイ、移行、再起動を行います。移行中もアプリは閲覧できますが、登録とサインインはできません。
:::

フックが実行されなかったと表示された場合（たとえばコマンドが途中で中断された場合）は、単独でもう一度実行できます（冪等です）。

```bash {runsOn=workstation}
scripts/module hooks run --pending
```

:::expected
auth の状態は「低下」で、原因は DEP-013（Cognito が自分で確認コードを送るため、ローカルの outbox には見えない）だけです。ページのサインインバッジには「登录由 Amazon Cognito 提供」（サインインは Amazon Cognito が提供）と表示されます。
:::

::checks
