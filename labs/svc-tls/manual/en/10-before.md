---
step: before
---

First record the starting point: the self-signed certificate on the lab instance's 443.

```bash {runsOn=workstation}
npm run exp -- tls --label before --scenario inspect --upload
```

::experiment{module=tls id=inspect label=before}

:::expected
In `entries`, the direct entry's `issuer` and `subject` are both `cloudalbum-l0`, `trusted` is false and `kind` is `selfsigned`;
the `tls` segment of the path header is `selfsigned@nginx`.
:::

Then open `https://{{ target.publicIp }}/` in a new browser tab: the browser shows a warning page (invalid certificate). This is "encrypted but not trusted".

:::why
A self-signed certificate's issuer is itself, and no trusted root certificate vouches for it. The browser cannot confirm you reached the real album, so it blocks the page;
fetches from other origins fail too, and real users cannot use the Cognito callbacks that rely on HTTPS.
:::

::checks
