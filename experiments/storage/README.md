# storage 实验（有 / 无 S3）

设计：[docs/modules/03-data-storage.md#storage](../../docs/modules/03-data-storage.md) 第 5 节。负载机最好是同区域的另一台 EC2（两次测量的客户端带宽必须一致）。

| 标签 | 前置条件 |
|---|---|
| `before` | `storage.driver=local`（HMAC 签名 PUT 经 Nginx → Node 写 EBS） |
| `after` | `storage.driver=s3`、`storage.status=ok/degraded`（预签名 URL 直传） |

## upload-burst

```bash
npm run exp:login
npm run exp -- storage --label before --scenario upload-burst --vus 10 --duration 120s
scripts/module enable storage
npm run exp -- storage --label after  --scenario upload-burst --vus 10 --duration 120s
npm run exp:report -- storage
```

每个文件 `fileMb`（默认 20 MB）：1600×1200 的 JPEG 用 COM 段补齐到目标大小，像素数不变，两档的差别只在“字节经不经过 EC2”。
同时以 `feedRps`（默认 2）读时间线作为背景流量。客户端分别记 `PUT /api/storage/upload`（local）与 `PUT s3:upload`（S3 预签名）。
观察：`host.net_rx_bytes`（`/proc/net/dev` 首尾差，local 与上传总量同一数量级）、`host.cpu.p95`、`host.event_loop_delay.p99`、`host.rss_max_bytes`、
时间线 p95；`scenario.uploadPath` 显示本轮是 `via-ec2` 还是 `s3-direct`。旁证：实例上 `sar -n DEV 1`、`pidstat -r -u -p $(pgrep -f dist/server.js) 1`。

## upload-sidebyside

```bash
npm run exp -- storage --label after --scenario upload-sidebyside --param fileMb=5
```

启用 s3 后可用：交替调用 `POST /api/lab/storage/upload-target?driver=local|s3`（lab/ 命名空间，服务端清理），同一时间、同一实例上看两条路径。
只看方向与数量级（两条路径互相干扰）。端点由 storage 模块提供，未实现时结果记 `endpointAvailable=false`。

## ebs-growth

```bash
npm run exp -- storage --label before --scenario ebs-growth --fault-via ssh --ssh ec2-user@<EIP> --param fillPct=92
npm run exp -- storage --label after  --scenario ebs-growth --fault-via ssh --ssh ec2-user@<EIP>
```

第 0 秒 `faults/balloon.sh fill <fillPct>`（`fallocate` 占位到数据卷使用率），等 `settleSec` 后尝试上传与评论各 `attempts` 次，结束时
`balloon.sh release`。预期：local 上传返回 507（`scenario.uploadRejected507`）；继续压低剩余空间后评论（SQLite 写）也失败；s3 档上传不受影响，
但 SQLite 仍会因磁盘满写失败——数据库与其他数据共用一块盘的风险依然存在（database 模块的动机之一）。

注意：如果运行中断，记得在实例上手工执行 `sudo bash experiments/storage/faults/balloon.sh release`。
