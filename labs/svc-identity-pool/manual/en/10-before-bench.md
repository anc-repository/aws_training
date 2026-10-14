---
step: before-bench
---

First record F14 in the start state: test user A uploads 10 JPEGs of 12 MB each (8 MB parts, 2 parts per file) with the app-signed prefix token.

```bash {runsOn=workstation}
npm run exp -- identity-pool --label before --scenario upload-bench --upload
```

::experiment{module=identity-pool id=upload-bench label=before}

Try it once in the app preview too: open "上传照片" (upload photos), select two photos at once (multiple files go through F14), and open the Network panel of the browser's DevTools.

:::expected
The report says `mode=token`, and `backendRequestsPerFile` is about 2 + the number of parts (create, one `parts:sign` per part, complete);
in DevTools every part is preceded by a `POST /api/uploads/parts:sign` to EC2 with the request header `Authorization: CA-Upload …`;
the identity-pool segment of the `X-CloudAlbum-Path` response header is `none:token`.
:::

:::tip
The token travels in a request header rather than the URL, so it stays out of access logs and browser history. It is still only the app's own convention: if it leaks, anyone can write files to that user's prefix until it expires,
and revoking it means the app has to maintain its own blacklist.
:::

::checks
