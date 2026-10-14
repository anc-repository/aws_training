---
section: wrap-up
---

## 你做到了什么

- 把站外通知从“EC2 逐个发信”换成一次 SNS Publish，扇出到邮件订阅与模块自带的 SQS 收件队列。
- 用订阅过滤策略让每位用户只收到与自己有关的通知，并在 CloudWatch 里看到被过滤掉的投递。
- 看到了邮件订阅的确认流程，以及 worker 停机时 SNS 投递照常进行、只有收件队列积压。

## 考点回顾

- SNS + SQS 扇出与 SQS 竞争消费的区别；订阅协议（HTTP/S、Email、SQS、Lambda、SMS、移动推送、Firehose）。
- 订阅过滤策略（消息属性 / 消息体）；邮件订阅要确认；原始消息传递；按协议的投递重试与订阅级 DLQ。
- SNS FIFO + SQS FIFO 用于需要顺序与去重的扇出。
- 队列策略与主题策略中的 `aws:SourceArn` / `aws:SourceAccount`；SSE-KMS 主题与服务主体授权。
- SNS、SES、EventBridge 的适用场景：广播订阅、事务性邮件、基于事件内容的路由。
