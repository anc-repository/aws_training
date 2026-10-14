---
step: host-inspect
---

Inspect the **lab instance terminal**: where are the data and secrets, and which ports are open to the outside?

```bash {runsOn=lab}
findmnt /var/lib/cloudalbum
readlink -f /etc/cloudalbum
sudo stat -c "%a %U:%G %n" /etc/cloudalbum/secrets.env
ss -ltn
systemctl list-timers "cloudalbum-*"
```

:::expected
`/var/lib/cloudalbum` is a separately mounted xfs volume (a different device from the root volume); `/etc/cloudalbum` points to `/var/lib/cloudalbum/etc`;
`secrets.env` has mode `640` and owner `root:cloudalbum`; api only listens on `127.0.0.1:3000`, and the only ports open to the outside are Nginx's 80 / 443.
:::

:::why
**Why is the instance replaceable?** The secrets (the session signing key, the local master key) and the data are on the data volume, so replacing the instance just means attaching the data volume to the new one;
the keys are not regenerated and encrypted fields still decrypt. The root volume only holds the OS and the release package, so it can be rebuilt at any time.
:::

::checks
