---
step: host-inspect
---

在**实验机终端**巡检：数据与机密在哪里、哪些端口对外。

```bash {runsOn=lab}
findmnt /var/lib/cloudalbum
readlink -f /etc/cloudalbum
sudo stat -c "%a %U:%G %n" /etc/cloudalbum/secrets.env
ss -ltn
systemctl list-timers "cloudalbum-*"
```

:::expected
`/var/lib/cloudalbum` 是一块单独挂载的 xfs 卷（设备不同于根卷）；`/etc/cloudalbum` 指向 `/var/lib/cloudalbum/etc`；
`secrets.env` 的权限是 `640`、属主 `root:cloudalbum`；api 只监听 `127.0.0.1:3000`，对外只有 Nginx 的 80 / 443。
:::

:::why
**实例为什么“可替换”？** 机密（会话签名密钥、本地主密钥）与数据都在数据卷上，换实例时把数据卷改挂过去即可，
密钥不会重新生成，已加密的字段依然解得开。根卷只放操作系统与发布包，可以随时重建。
:::

::checks
