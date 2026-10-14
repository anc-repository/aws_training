---
step: headers
---

In your mailbox, open the "reset password" email from the previous step and choose to show the original (Gmail: More → Show original; Outlook: View → View message source).
Look for these lines:

- `DKIM-Signature:` — the signature SES added; `d=` is the signing domain.
- `Authentication-Results:` — the receiving side's checks: `dkim=`, `spf=`, `dmarc=`.
- `X-CloudAlbum-Transport: ses` — the same MIME as the `.eml` in the outbox, plus only the signature and headers SES added.

:::why
When you send with an **email address identity**, SES signs with its own domain (amazonses.com), and SPF's MAIL FROM is also SES's domain: neither aligns with your sending domain,
and DMARC depends on alignment. Only a **domain identity** with Easy DKIM makes the DKIM signing domain match the sending domain; add a custom MAIL FROM to align SPF too, and deliverability improves.
:::

:::expected
`dkim=pass`; with an email address identity, the signing domain is amazonses.com.
:::

::checks
