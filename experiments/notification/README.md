# notification 实验（有 / 无 SNS）

设计：[docs/modules/04-compute-async.md#notification](../../docs/modules/04-compute-async.md) 第 5 节。

| 标签 | 前置条件 | 说明 |
|---|---|---|
| `before` | `notification.driver=db` | 站内信 + 逐个调用 EmailPort（outbox 或 ses） |
| `after` | `notification.driver=sns`、`notification.status=ok/degraded` | 一次 Publish，SNS 按订阅过滤策略扇出；运维订阅待确认时为 degraded |

所有场景都以管理员身份运行（`npm run exp:login`）。业务流量只能“切换前 / 切换后”：通知是全局状态，不做运行时 A/B。

## 0. 准备种子用户（db 档）

```bash
npx tsx experiments/notification/seed-users.ts --count 3 --email you@example.com     # 你的真实邮箱；生成 +u1～+u3
```

经公开 API 注册 `you+u1@…`～`you+u3@…`，用 `/api/admin/outbox` 里的验证码完成邮箱验证，各上传一张公开小图，打开“邮件通知”，
再设为管理员（`--no-admins` 保持普通用户）。清单写入 `.cloudalbum/experiments/notification-users.json`（0600，含测试账号的密码）。
地址是保留域名（example.com 等）时，sns 档不会为它们创建订阅（PM-46 / PM-M23）。

## fanout（必需）

```bash
npm run exp -- notification --label before --scenario fanout --upload
scripts/module enable notification --param AdminEmail=you+admin@example.com --no-migrate   # 到邮箱确认运维订阅
npx tsx experiments/notification/subscribe-users.ts      # 为种子用户建 SNS 订阅（每人一封确认邮件，逐个点击）
npm run exp -- notification --label after  --scenario fanout --upload
npm run exp:report -- notification
```

给种子用户的照片评论 `comments`（默认 20）次，每条一个 `comment.created`。QUEUE_DRIVER=sync 时扇出在评论请求内，Server-Timing
的 `notification` 段就是 `NotifierPort.publish` 的耗时。服务端证据：`GET /api/admin/notifications/deliveries` 中本次事件的投递行
（db 档每条 1 行 `email`；sns 档 1 行 `sns` + worker 消费收件队列后的 1 行 `sqs-copy`）。功能对照端点可用时另测一次管理员广播。

`subscribe-users.ts` 是 `migrate-module notification up` 在迁移框架接入之前的等价做法（同一个 `subscribeEmail`，`--off` 对应 down）。

## filter（必需，after）

```bash
npm run exp -- notification --label after --scenario filter --param user=u1 --upload
```

只给 u1 发一条事件：服务端只有一行 `sns` 与一行 `sqs-copy`；邮箱中只有收件人为 `+u1` 的通知到达（所有别名进同一个邮箱）；
CloudWatch 的 `NumberOfNotificationsFilteredOut`（`TopicName` 维度）在几分钟后增加。

## compare（选做）

```bash
npm run exp -- notification --label after --scenario compare     # 或 npx tsx experiments/notification/compare.ts
```

`POST /api/lab/notification/compare`：同一个 `report.ready` 测试事件经 db（逐个发给全部管理员）与 sns（一次 Publish）各发一次。

## worker-stop（观察，after）

```bash
npm run exp -- notification --label after --scenario worker-stop --fault-via ssh --ssh ec2-user@<EIP>
# 或 shell-access=ssm：--fault-via ssm --instance-id i-…；没有投递通道：--fault-via skip，并按提示手工 stop / start
```

第 5 秒 `faults/stop-worker.sh`，第 50 秒 `faults/start-worker.sh`。评论照常成功（Publish 在 api 进程），邮件照常到达，只有收件队列积压；
worker 启动后积压被消费，`sqs-copy` 投递记录补齐。
