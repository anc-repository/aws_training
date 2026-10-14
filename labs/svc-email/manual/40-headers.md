---
step: headers
---

在你的邮箱里打开上一步收到的“重置密码”邮件，选择“显示原始邮件”（Gmail：更多 → 显示原始邮件；Outlook：查看 → 查看邮件源）。
找这几行：

- `DKIM-Signature:`——SES 加的签名；`d=` 是签名域。
- `Authentication-Results:`——收件方的检查结果：`dkim=`、`spf=`、`dmarc=`。
- `X-CloudAlbum-Transport: ses`——与 outbox 中 `.eml` 的同一份 MIME，只多了 SES 加的签名与头部。

:::why
以**邮箱身份**发信时，SES 用自己的域（amazonses.com）签名，SPF 的 MAIL FROM 也是 SES 的域：两者都不与你的发件域对齐，
DMARC 依赖对齐。**域名身份** + Easy DKIM 才让 DKIM 签名域与发件域一致，再配自定义 MAIL FROM 让 SPF 对齐，送达率更好。
:::

:::expected
`dkim=pass`；邮箱身份时签名域是 amazonses.com。
:::

::checks
