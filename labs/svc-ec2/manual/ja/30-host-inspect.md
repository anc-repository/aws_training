---
step: host-inspect
---

**ラボ用インスタンスのターミナル**で点検します。データと機密情報はどこにあり、どのポートが外部に開いているでしょうか。

```bash {runsOn=lab}
findmnt /var/lib/cloudalbum
readlink -f /etc/cloudalbum
sudo stat -c "%a %U:%G %n" /etc/cloudalbum/secrets.env
ss -ltn
systemctl list-timers "cloudalbum-*"
```

:::expected
`/var/lib/cloudalbum` は単独でマウントされた xfs ボリューム（ルートボリュームとは別のデバイス）です。`/etc/cloudalbum` は `/var/lib/cloudalbum/etc` を指しています。
`secrets.env` の権限は `640`、所有者は `root:cloudalbum` です。api は `127.0.0.1:3000` だけで待ち受けており、外部に開いているのは Nginx の 80 / 443 だけです。
:::

:::why
**インスタンスはなぜ「交換できる」のでしょうか？** 機密情報（セッション署名キー、ローカルのマスターキー）とデータはデータボリュームにあるため、インスタンスを交換するときはデータボリュームをアタッチし直すだけで済みます。
鍵は作り直されず、暗号化済みのフィールドもそのまま復号できます。ルートボリュームに置くのは OS とリリースパッケージだけなので、いつでも作り直せます。
:::

::checks
