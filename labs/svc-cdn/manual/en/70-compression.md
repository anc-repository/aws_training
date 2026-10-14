---
step: compression
---

(Optional) Compare compression of text assets fetched directly and through CloudFront:

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario compression --upload
```

::experiment{module=cdn id=compression label=after}

:::expected
JS and CSS served through CloudFront carry `Content-Encoding: br` and transfer fewer bytes than the gzip responses served directly. To see the difference between HTTP/2 and HTTP/3, look at the
Protocol column in your browser's developer tools (Node's http module only speaks HTTP/1.1).
:::

::checks
