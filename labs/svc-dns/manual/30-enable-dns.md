---
step: enable-dns
---

一键脚本会部署 dns 栈：托管区域（新建，或你用 `--zone-id` 指定的已有区域）+ 一条 TTL 60 的 A 记录指向实验机弹性 IP，
然后把 `dns.env` 投递到实验机：`APP_BASE_URL` 变为 `http://{{ learner.inputs.domain }}`，邮件与分享链接从此写的是域名。

:::method{kind=script default}
先看变更预览（不调用任何会改变资源的 API）：

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip --dry-run
```

确认后执行。使用已有托管区域时加上 `--zone-id <托管区域 ID>`：

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip
```
:::

新建托管区域时，脚本会打印 4 个名称服务器，并轮询公共解析器直到委派生效（最多 15 分钟；`--param DelegationWaitMin=0` 跳过）：

:::wait{typical=5 max=30}
到注册商（或父域的 DNS）为 `{{ learner.inputs.domain }}` 添加这 4 条 NS 记录。生效时间由注册商与顶级域决定。等待期间可以想一想：
**为什么 A 记录的 TTL 是 60 秒？** 迁移之前把 TTL 调低，旧值过期得快，切换时用户感受到的中断就短。
:::

确认委派与记录：

```bash {runsOn=workstation}
dig +short NS {{ learner.inputs.domain }} @8.8.8.8
dig {{ learner.inputs.domain }} @8.8.8.8 | grep -A1 'ANSWER SECTION'
curl -s http://{{ learner.inputs.domain }}/api/lab/echo | jq '{host, entry}'
```

:::expected
NS 是 4 个 `awsdns` 名称服务器；A 记录是 `{{ target.publicIp }}`，第二列是剩余 TTL（≤ 60）；echo 返回的 `host` 是你的域名——
服务端看到的 Host 头，说明请求确实经域名到达。
:::

:::why
**dns 不在请求路径上。** DNS 只负责“名字 → 地址”，请求本身仍然直达 EC2 的 Nginx，所以这张卡没有新的响应头可看；
感知器改为在实例上解析域名并与实例当前的弹性 IP 比较，同时统计最近 5 分钟有多少请求还在用 IP 访问。
:::

::checks
