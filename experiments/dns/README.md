# dns 实验（有 / 无 Route 53）

设计：[docs/modules/01-edge-network-scaling.md#dns](../../docs/modules/01-edge-network-scaling.md) 第 5 节。**人工前置：自有域名**
（本账号已有它或其子域的公有托管区域，或能在注册商 / 父域添加 NS 委派）。没有域名时只能做 before 一侧（旧 IP 链接）。

| 标签 | 前置条件 |
|---|---|
| `before` | `dns.driver=none`（IP / EC2 主机名）或 `external`（外部注册商的 A 记录） |
| `after` | `dns.driver=route53`、`dns.status=ok/degraded` |

域名、EIP 缺省从管理员视图的 capabilities 读取（`dns.data.recordName`、`ec2.data.publicIpv4`），也可以 `--param domain= --param ip=` 指定。
解析一律向显式指定的公共解析器发起（默认 `8.8.8.8`，`--param resolver=`），等价于 `dig +short <域名> @8.8.8.8`；CloudShell 没有 dig 时
不影响实验，手工观察时 `sudo dnf install -y bind-utils`。

## ip-change-drill（换 IP 演练）

```bash
npm run exp -- dns --label before --scenario ip-change-drill --fault-via local --param env=lab
scripts/module enable dns --domain album.example.com --target eip      # 仓库根目录；新建托管区域时到注册商添加 NS 委派
npm run exp -- dns --label after  --scenario ip-change-drill --fault-via local --param env=lab --upload
```

`--fault-via local`：`faults/reassociate-eip.sh` 在运行器所在机器上用部署者身份调用 AWS CLI——第 0 秒 `swap`（分配临时 EIP 并关联到实例；
after 另把记录 UPSERT 到新 IP），结束时 `restore`（关联回原 EIP、改回记录、释放临时 EIP）。**restore 必须成功**，否则基础栈的 EIP 关联与
实际不一致，未关联的临时 EIP 也会计费；中途中断时手工执行 `bash experiments/dns/faults/reassociate-eip.sh restore --env lab`。
cdn 以 EC2 公网 DNS 名为源站时，演练会让 CloudFront 回源失败：先把源站改为 `origin.<域名>`（`--param OriginRecord=true`）或暂时禁用 cdn。

发现：`oldLinkFailures`（旧 IP 链接失败次数）、`domainFailures`、`resolverSwitchSec`（公共解析器返回新 IP 的秒数）、`domainRecoverySec`
（域名链接恢复的秒数，TTL 量级）、`timeline`。服务端证据 `server`：经域名请求 `/api/lab/echo` 时服务端看到的 `Host`，dns 感知器的解析结果
与 `Host` 分布（用 IP 访问的请求占比）。平台模式下演练期间不要点“检测”（平台记录的 `target.publicIp` 暂时失效）。

## failover-drill（故障转移）

```bash
scripts/module enable dns --domain album.example.com --param RoutingPolicy=failover   # 自动开启健康检查（检查 origin.<域名>）
npm run exp -- dns --label after --scenario failover-drill --fault-via ssm --upload    # L0 用 --fault-via ssh --ssh ec2-user@<EIP>
```

第 10 秒停止实例上的 Nginx，结束时恢复。`marks`：`unhealthy`（健康检查变为不健康，需要 AWS CLI 与凭证，指标在 us-east-1）、
`secondaryAnswer`（公共解析器返回备用记录）、`maintenanceOk`（访问成功：S3 维护页，响应带 `x-amz-request-id`）、`primaryBack`。
S3 网站端点只支持 HTTP；站点已强制 HTTPS 时应改用 CloudFront 源站组在 CDN 层故障转移（01#dns 第 2 节）。

## weighted-sample（加权路由）

```bash
scripts/module enable dns --domain album.example.com --param RoutingPolicy=weighted --param WeightedSecondaryIp=<第二个 IP>
npm run exp -- dns --label after --scenario weighted-sample --param queries=200
```

直接向托管区域的权威名称服务器查询（避开解析器缓存）并统计比例（`authoritative`，接近 90/10），再向 8.8.8.8 查询作对照（`publicResolver`）。

## Alias 与 CNAME（手工）

1. 在同一托管区域建 `www.<域名>` → Alias 到 `<域名>`（Alias 可以指向同一托管区域中的记录）：`dig www.<域名> @8.8.8.8` 直接返回 A 记录，没有 CNAME 链。
2. 尝试为区域顶点建 CNAME：Route 53 拒绝（`RRSet of type CNAME with DNS name … is not permitted at apex`，以控制台实际报错为准）。
3. 结束前删掉手工建的记录（回收器只按 CloudTrail 认领，有分钟级延迟）。
