---
step: headers
---

前のステップで届いた「パスワードの再設定」のメールをメールボックスで開き、元のメールを表示します（Gmail：その他 → メッセージのソースを表示、Outlook：表示 → メッセージのソースを表示）。
次の行を探します。

- `DKIM-Signature:`：SES が付けた署名です。`d=` が署名ドメインです。
- `Authentication-Results:`：受信側のチェック結果です（`dkim=`、`spf=`、`dmarc=`）。
- `X-CloudAlbum-Transport: ses`：outbox の `.eml` と同じ MIME で、SES が付けた署名とヘッダーが増えているだけです。

:::why
**メールアドレス ID** で送信すると、SES は自分のドメイン（amazonses.com）で署名し、SPF の MAIL FROM も SES のドメインになります。どちらもあなたの送信元ドメインとそろわず、
DMARC はこのそろい具合（アライメント）に依存します。**ドメイン ID** + Easy DKIM で初めて DKIM の署名ドメインが送信元ドメインと一致し、さらにカスタム MAIL FROM で SPF もそろえれば、到達率が上がります。
:::

:::expected
`dkim=pass` です。メールアドレス ID の場合、署名ドメインは amazonses.com です。
:::

::checks
