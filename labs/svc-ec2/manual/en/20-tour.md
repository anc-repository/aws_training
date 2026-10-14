---
step: tour
---

Use the album in the app preview with the Network panel of your browser's developer tools open:

1. Sign up for an account, open the verification email in "我的邮件" (my mail, `/me/outbox`) and complete the verification (L0 does not really send email).
2. Upload a few photos, wait for the thumbnails, then like and comment.
3. Pick any `/api/` request in the Network panel and look at the `X-CloudAlbum-Path` and `Server-Timing` response headers.

:::expected
`X-CloudAlbum-Path` has `entry=nginx`, the storage segment is the local disk and the thumbnail segment is `inline`; `Server-Timing` shows the time spent in each port.
Everything happens on this one machine.
:::

:::tip
`X-CloudAlbum-Path` is the evidence for every card after this one: when you enable a module, its segment changes from the local implementation to an AWS service.
:::

::checks
