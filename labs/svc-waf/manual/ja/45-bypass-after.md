---
step: bypass-after
---

オリジンをロックした後で、もう一度確認します。`bypass` の after は `originLocked=true` を示すはずです。

前のステップで直接アクセスの入口をワークベンチにだけ開いた（`CDN_ADMIN_CIDR={{ workstation.publicIp }}/32`）ので、ワークベンチから実行すると直接アクセスは**まだ到達できます**。
実験はクライアントだけを見るわけではありません。直接アクセスで `/api/lab/echo` にリクエストし、オリジンが見たクライアントのアドレスを取得して、capabilities の cdn の `adminCidr` と比べます。
許可リストに含まれていれば `directAllowedAsAdmin=true` と記録され、「迂回できる」とはみなされません。正しい `X-Origin-Verify` のない 8080 は、引き続き拒否されなければなりません。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario bypass
```

これで許可リスト以外のアドレスは EC2 に直接リクエストして CloudFront の WAF を迂回することができなくなり、before と after の組で「ロック」が効いたことを示せます。
「他のアドレスが拒否される」ことを自分の目で確かめたい場合は、AWS CloudShell（許可リストに含まれない）で `curl -m 5 http://<ラボ用インスタンスのパブリック IP>/api/health/live` を実行してください。タイムアウトするはずです。
