---
section: overview
---

## Background

In the start state, every CloudAlbum email — sign-up verification, password reset, comment notifications, daily digest — is only written to the outbox on EC2 (`.eml` files + the `outbox_emails` table);
the user previews it at `/me/outbox`, and the page says "本地实现，未真正发信" (local implementation, not really sent). That lets one person walk through sign-up, but the user's real mailbox receives nothing,
and the outbox tier's "email verified" proves nothing about who owns the address (anyone can sign up with someone else's address and then see the verification link at `/me/outbox`).

This card sends the same MIME for real through Amazon SES. Delivery, bounce and complaint events go from the configuration set's event destination to the module's own SNS topic and then into the SQS feedback queue,
where the worker picks them up and updates the delivery status in `/admin/outbox` and `users.email_status` — EC2 does not need any inbound port.

:::why
Why not run postfix on EC2 and deliver directly? EC2 restricts outbound port 25 by default (you can ask to lift it), and mail sent straight from an Elastic IP has a poor reputation and will most likely land in spam.
SES provides reputable sending IPs, DKIM signing, bounce and complaint handling, and protection through sending quotas and rates.
:::

## Comparison experiments

### Send matrix (email/send-matrix, required)

- **Without SES (outbox)**: trigger one "reset password" email each to the three SES mailbox simulator addresses and to your own address; all of them are written to the local outbox and never really sent.
- **With SES**: the same four emails go out through SES; success → delivered, bounce → bounced, complaint → complained, flowing back to `/admin/outbox` within seconds to minutes.
- **Where you will see it**: each address's `deliveryStatus` in the report; the `X-CloudAlbum-Path` response header changes from `email=outbox:stored` to `email=ses:sent`;
  your mailbox receives an email with a `DKIM-Signature`.
- **If the results are not what you expect**: first check that the sender identity is verified; while in the sandbox, your own address must be that verified identity.

### Sandbox limits (email/sandbox, required)

Send to an address you have not verified: the server records `failed` with the error `MessageRejected` (shown in red in `/admin/outbox`), and the path segment is `email=ses:rejected`;
the sign-up itself still completes, and the app never quietly rewrites a failed email as "sent".

## Before you start

- SES sender identity: an email address you can receive mail at (entered before you start). After deployment, click the link in "Amazon Web Services – Email Address Verification Request" in that mailbox.
- Prefer a mailbox whose DMARC policy is not `reject`: when you send with an email address identity, neither SPF nor DKIM aligns with the sending domain, so if that domain publishes `p=reject`,
  mail to yourself may be rejected by the receiving side (check the official docs and your own tests).
- Optional: your own domain (for the last optional step; a domain identity + Easy DKIM needs 3 CNAME records).
- The card is done entirely inside the SES sandbox: while in the sandbox you can only send to verified addresses and the SES mailbox simulator.

## Platform mode notes

You can choose to keep the sender identity when you end the lab; the next time email is deployed, `scripts/module` finds the existing identity and adopts it read-only (`AdoptExistingIdentity=true`),
so it does not fail because an identity with that name already exists, and disabling the module does not delete it.
