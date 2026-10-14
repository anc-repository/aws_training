---
step: ip-after
---

同じ IP 変更の訓練をもう一度行います。今回はスクリプトが一時的な EIP を関連付けた後にレコードを新しいアドレスに UPSERT し、その後パブリックリゾルバーへの問い合わせとドメイン名のリンクへのアクセスを続けます。

```bash {runsOn=workstation}
npm run exp -- dns --label after --scenario ip-change-drill --fault-via local --param env={{ session.env }} --upload
```

::experiment{module=dns id=ip-change-drill label=after}

:::expected
古い IP のリンクは相変わらず失敗します（`oldLinkFailures` > 0）が、ドメイン名のリンクは TTL 程度の時間で復旧します。`resolverSwitchSec` と `domainRecoverySec`
は 1～2 分以内です。レポートでは before と after が比較可能なペアとして示されます。終了時にレコードは `{{ target.publicIp }}` に戻され、一時的な EIP は解放されています。
:::

:::saa{domain=resilient}
DNS の切り替えは一瞬では終わりません。リゾルバーは TTL に従って回答をキャッシュし、クライアントによってはさらに長くキャッシュします。移行前に TTL を下げ、古い TTL が切れてから切り替えます。
秒単位の切り替えが必要なら、ALB / CloudFront の層で行います（それらへの Alias にしておけば、宛先が変わっても DNS を変更する必要はありません）。
:::

::checks
