---
section: wrap-up
---

## 你做到了什么

- 把后台任务从进程内存搬进 SQS：杀掉 worker，任务一个不丢。
- 看到了至少一次投递的代价：可能重复执行，由幂等去重吸收。
- 用死信队列隔离了坏消息，并练习了重驱动。

## 考点回顾

- 标准队列与 FIFO 队列；可见性超时与心跳；长轮询减少空接收。
- 死信队列、`maxReceiveCount`、`RedriveAllowPolicy`、死信重驱动；死信队列的保留期要更长。
- 削峰填谷、松耦合、竞争消费者；按“每实例积压”指标驱动 Auto Scaling。
- SQS、SNS、EventBridge、Kinesis 各自的适用场景。
