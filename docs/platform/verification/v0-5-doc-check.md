# V0-5 官方文档核对结果（不调用 API）

- **对应计划**：`docs/platform/07-aws-verification-plan.md` 中的“V0-5 官方文档核对（不调用 API）”，核对清单 D1～D23。
- **查阅日期**：2026-10-14。下文所有链接都在这一天查阅。
- **来源范围**：docs.aws.amazon.com；aws.amazon.com（含 What's New、定价页、FAQ）；AWS 官方 GitHub 仓库。D15 另用 Let's Encrypt 官方文档；D20 另用 MDN、Chrome（Privacy Sandbox）、WebKit 的官方说明。少数非官方或旧的旁证在表中单独标出，不作数值依据。
- **执行方式**：只读文档。没有调用任何 AWS API，没有运行 aws 命令，没有创建资源，费用为零。
- **写法**：结论是转述，不摘抄原文；只写官方明确给出的数值；官方没写的标“文档未说明”，留给实测。

---

## 1. 摘要

### 1.1 判定口径

每一项给出一个**主判定**（四选一）。判定只看设计文档依赖的要点，同时存在多种情况时，按下面的顺序取最需要处理的一类：

1. **不一致**：设计文档里有与官方现行说法冲突的写法，或者漏掉了官方明确要求的配置，需要回写。
2. **官方说法矛盾**：官方不同页面（或同一页的不同位置）对设计依赖的要点说法不一，需要实测定论。
3. **文档未说明**：核对清单里的关键问题官方没有回答，留给实测。
4. **一致**：设计依赖的要点与官方一致。这类项仍可能有可以补上的具体数值。

同一项里的次要情况，在逐项表“一致性”一列中用“另含”注明。

### 1.2 统计

| 主判定 | 数量 | 编号 |
|---|---|---|
| 一致 | 7 | D1、D5、D8、D10、D15、D16、D20 |
| 不一致 | 8 | D2、D3、D6、D12、D13、D14、D17、D23 |
| 文档未说明 | 4 | D9、D11、D18、D19 |
| 官方说法矛盾 | 4 | D4、D7、D21、D22 |
| **合计** | **23** | |

“另含”的情况（不含主判定本身）：含“文档未说明”子项的有 D1、D2、D3、D4、D5、D6、D7、D13、D14、D16、D17、D22、D23；含“官方说法矛盾”子项的有 D3、D6、D17、D18、D20（D17、D18、D20 中的矛盾与设计无关或不影响结论）。

### 1.3 需要回写到设计文档的项

- **纠错（主判定为“不一致”，见第 3 节）**：
  - D2：01 §3.1、02 §7.7、§7.12、03 第 1196 行的事件历史延迟描述；01 §3.1 中 Route 53 记录区域的写法和“精确匹配”的写法。
  - D3：02 §4.6 的 CodeBuild 托管规则名拼写；02 中写死的 Catch 错误名。
  - D6：01 §6.4 和模块模板缺少角色链所需的 `sts:SetSourceIdentity`。
  - D12：scenario-cards 第 127 行、05 第 457 行把托管区域写成按时间折算。
  - D13：modules/01 第 646 行转发 `Authorization` 的写法；01 §3.8 的 no-cache 描述；失效免费额度按账号合计。
  - D14：modules/01 中签发角色的权限，以及 `ListCertificates` 的过滤参数。
  - D17：02 §10.4“不追溯历史”。
  - D23：01 §9.8 把 `ec2messages` 写成硬依赖。
- **待实测后回写（主判定为“官方说法矛盾”，见第 3 节）**：D4（50-iam.yaml 按调度名前缀授权）、D7（03 §5 的控制台会话时长）、D21（仓库内前后矛盾的预留并发为 0 时的表述）、D22（01 §3.1、02 §7.1 的措辞）。
- **补具体数值（把“以官方文档为准”换成官方数值，见 3.13）**：D1、D5、D8、D9、D10、D11、D15、D16、D18、D19、D20。D18 另有一个由推断得出的风险（ArgsB64 的 allowedPattern），建议先改。

按 07 V0-5 的“失败时的处理”，第 3 节中与设计冲突的各条应记入 07 第 13 节。本次只给建议，不改动 07 和其他任何文件。

---

## 2. 逐项记录表

所有来源的查阅日期均为 2026-10-14。“仍需实测”一列中的 V 编号沿用 07。

| 编号 | 事项 | 结论 | 一致性 | 对设计的影响 | 是否仍需实测（V 编号） | 来源链接（查阅日期 2026-10-14） |
|---|---|---|---|---|---|---|
| D1 | CloudFormation 自定义资源 `ServiceTimeout` 的取值范围与默认值 | ① 取整数秒 1～3600。模板中的类型是 String，修改属于无中断更新。<br>② 不设置时默认 3600 秒。模板参考与请求/响应参考两处一致，没有超过 3600 的设置方式。<br>③ 超时前没有收到响应，这次请求就算失败，栈操作随之失败。删除场景下栈最终停在什么状态、原因文本是什么：文档未说明。<br>④ 自定义资源的响应体总大小上限是 4096 字节。ResponseURL 是预签名 S3 URL，它的有效期：文档未说明。 | **一致**<br>另含：文档未说明（超时后的栈状态、ResponseURL 有效期） | 01 §4.8（第 753 行）和 02 §10.5（第 2179 行）写的“1～3600、默认 3600、不能调大”无需修改，“以官方文档为准”可以换成链接。建议在 02 §10.5 补两点：Reason 连同整个响应体不超过 4096 字节；超时后不再用旧 ResponseURL 回调，只用重试删除时新请求里的 URL。 | 需要，**V1-13**，只测超时后的行为：栈的最终状态和原因文本；超时后向旧 ResponseURL 发 PUT 是否被接受；重试删除时是否带新的 RequestId 和 ResponseURL；响应体超过 4096 字节时的表现。取值范围和默认值不必再测。 | https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudformation-customresource.html<br>https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html#response-timeout<br>https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref.html |
| D2 | CloudTrail 事件历史：保留期、单一查找属性、`LookupEvents` 频率限制、投递延迟 | ① 每个区域保留最近 90 天的管理事件，不含数据事件和网络活动事件。查看事件历史和调用 lookup-events 都不收费，也不需要 trail。<br>② `LookupAttributes` 只能放 1 个元素，查询只覆盖单账号、单区域。可用的键有 8 个：EventId、EventName、ReadOnly、Username、ResourceType、ResourceName、EventSource、AccessKeyId。AttributeValue 最长 2000 字符，其中下划线、空格、逗号、换行各按 2 个字符计。是否精确匹配、是否区分大小写：文档未说明。<br>③ 每账号每区域每秒 2 次，超出就被限流，API 页没有写错误名。配额页也写 LookupEvents 为 2 TPS，并说明 CloudTrail 没有可调整的配额。每页最多 50 条，翻页时要带与首次调用相同的参数。<br>④ “平均约 5 分钟、不作保证”出现在 trail 日志投递的语境里。事件历史（LookupEvents）的可见延迟：文档未说明。<br>⑤ 从 2021-11-22 起，CloudFront、IAM、STS 的事件记录在 us-east-1。官方同时提示，部分全局服务事件可能记在 us-east-2 或 us-west-2。 | **不一致**<br>（“通常数分钟”被当成事件历史的官方描述；Route 53 被列为记录在 us-east-1）<br>另含：文档未说明（事件历史延迟、匹配规则） | 一致的部分：01 §3.1，02 §7.3、§7.12、第 1882 行的“90 天、免费、不需要 trail、一次一个属性、按区域查询”。<br>可补数值：01 §3.1、§3.12（第 538 行）、02 第 1508 行改为“每账号每区域 2 次/秒，不可调整；每页最多 50 条”。atl-main 的令牌桶 `RATE#cloudtrail-lookup#<region>` 按 2 TPS 设置，由 atl-reaper 与 atl-checks 共用。<br>需要改写：01 §3.1、02 §7.7（第 1617 行）、§7.12（第 1917 行）、03 第 1196 行。见 3.1 节。 | 需要，**V1-9**，必须保留：事件历史可见延迟的分布；超过 2 TPS 时的确切错误名；Username、ResourceName 的匹配规则；Route 53 等全局服务事件实际出现在哪个区域。 | https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html<br>https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupAttribute.html<br>https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html<br>https://docs.aws.amazon.com/awscloudtrail/latest/userguide/how-cloudtrail-works.html<br>https://docs.aws.amazon.com/awscloudtrail/latest/userguide/WhatIsCloudTrail-Limits.html<br>https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-concepts.html#cloudtrail-concepts-global-service-events<br>https://aws.amazon.com/cloudtrail/faqs/ |
| D3 | Step Functions Standard：执行名复用与 `ExecutionAlreadyExists`；执行历史事件上限；`.sync` 托管规则名；`startExecution` 限流错误名 | ① Standard 的 StartExecution 是幂等的：同名、同输入，并且原执行还在运行时，调用成功并返回原来的响应；原执行已结束或输入不同时，返回 400 ExecutionAlreadyExists。执行名要等原执行结束满 90 天后才能复用。执行名长度为 1～80，有字符限制。同一 API 页的错误表只提到“同名不同输入”，与页面上的 Note 不完全一致（官方说法有出入）。<br>② 单次执行的历史最多 25,000 个事件，达到上限执行就失败。<br>③ 托管规则名：CodeBuild startBuild.sync 用 `StepFunctionsGetEventForCodeBuildStartBuildRule`（Event 是单数）；startBuildBatch.sync 用 `StepFunctionsGetEventForCodeBuildStartBuildBatchRule`；startExecution.sync 和 .sync:2 用 `StepFunctionsGetEventsForStepFunctionsExecutionRule`（Events 是复数）。.sync 被中止时，Step Functions 尽力取消，但不保证成功；同账号的 .sync 还会轮询，轮询消耗 Describe 类 API 的配额。<br>④ API 层被限流时返回通用错误 ThrottlingException。优化集成 `states:startExecution` 抛出的错误名前缀，以及被限流时的错误名：文档未说明。`StepFunctions.ExecutionAlreadyExistsException` 这个写法只在 aws/aws-cdk 的一个用户 issue 里出现过，不属于官方文档。 | **不一致**<br>（02 §4.6 规则名多了一个 s；Catch 中的错误名没有官方依据）<br>另含：官方说法矛盾（错误表与 Note）；文档未说明（优化集成的错误名） | 一致的部分：02 §2.7（第 242 行）的执行名规则，措辞宜改为“结束后 90 天内不能复用”；02 第 1833 行的“25,000 条”。01 §3.3（第 344 行）和 platform/infra/src/50-iam.yaml 第 224 行已经是正确的规则名。<br>需要修改：02 §4.6（第 874 行）的规则名；02 第 520、829、1420 行写死的 Catch 错误名。见 3.2 节。<br>执行名（`reclaim-<envId>-<mode>-<n>` 等）在生成时要校验长度不超过 80。 | 需要，**V1-12**，必须保留：经优化集成调用时，三种同名情况下 Catch 收到的确切 Error 和 Cause；人为制造限流时的错误名；缺少 events 权限时 .sync 的行为；Parallel 分支失败时被中止的构建是否真的被停止；执行名超过 80 字符时的报错。 | https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html<br>https://docs.aws.amazon.com/step-functions/latest/apireference/CommonErrors.html<br>https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html<br>https://docs.aws.amazon.com/step-functions/latest/dg/connect-codebuild.html<br>https://docs.aws.amazon.com/step-functions/latest/dg/connect-stepfunctions.html<br>https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html#connect-sync<br>https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html<br>https://docs.aws.amazon.com/step-functions/latest/dg/supported-services-awssdk.html<br>https://github.com/aws/aws-cdk/issues/8801（用户 issue，仅作旁证） |
| D4 | EventBridge Scheduler：名称长度、`at()` 格式、`at()` 时间已过、`ActionAfterCompletion`、重试与死信、`iam:PassRole` | ① 调度名 1～64 字符，字符集为 `[0-9a-zA-Z-_.]`；调度组名也是 1～64。<br>② `at(yyyy-mm-ddThh:mm:ss)` 按 ScheduleExpressionTimezone 求值，一次性调度忽略 StartDate 和 EndDate。触发精度为 60 秒，不设弹性窗口时，在指定那一分钟内的任意一秒触发。<br>③ 用已经过去的时间创建一次性调度，是会被拒绝还是立即触发：文档未说明。<br>④ ActionAfterCompletion 取 NONE 或 DELETE。设为 DELETE 时，一次性调度在调用目标一次后被删除。已经完成的一次性调度仍占配额。重试耗尽进入死信队列后调度是否也被删除：文档未说明。<br>⑤ MaximumEventAgeInSeconds 取 60～86400，MaximumRetryAttempts 取 0～185。死信队列只能用 SQS 标准队列，由执行角色投递，执行角色需要 sqs:SendMessage。<br>⑥ CreateSchedule 和 UpdateSchedule 要求调用方对执行角色有 iam:PassRole，条件是 PassedToService = scheduler.amazonaws.com。UpdateSchedule 会整体覆盖原调度。<br>⑦ 同一 IAM 示例页里，Create/Update 示例把 Resource 写到了具体调度名，DeleteScheduleGroup 一节的注释却说不支持对单个调度做资源级授权。 | **官方说法矛盾**<br>（是否支持对单个调度做资源级授权）<br>另含：文档未说明（at() 时间已过、DELETE 与死信的关系） | 01 §3.5（第 394～398 行）和 02 §5.2（第 919～943 行）的名称长度、at() 格式、DELETE、FlexibleTimeWindow OFF、60 秒精度、死信、PassRole、整体提交，都与官方一致。示例里的 MaximumRetryAttempts 10 和 MaximumEventAgeInSeconds 3600 在合法范围内。“触发时间已经过去的提醒不创建”是正确的保守做法。<br>受矛盾影响：platform/infra/src/50-iam.yaml 第 896 行按调度名前缀写的 `schedule/atl-system/atl-share-*`。见 3.3 节。 | 需要，**V1-11**，必须保留：at() 时间已过（过去 1 分钟、过去 1 天）时 CreateSchedule 的反应；DELETE 调度在重试耗尽进入死信后是否被删除；按调度名前缀授权是否生效；缺少 PassRole 时的错误；临近触发时删除调度后是否仍触发；实际触发时刻落在整分钟后的第几秒。 | https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html<br>https://docs.aws.amazon.com/scheduler/latest/APIReference/API_UpdateSchedule.html<br>https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html<br>https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html<br>https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-delete.html<br>https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html<br>https://docs.aws.amazon.com/scheduler/latest/UserGuide/troubleshooting.html<br>https://docs.aws.amazon.com/scheduler/latest/UserGuide/security_iam_id-based-policy-examples.html |
| D5 | IAM：角色内联策略总大小、托管策略字符上限、每角色托管策略数、最终一致性、`GetCallerIdentity` 不受 Deny 影响 | ① 一个角色可以挂任意多条内联策略，但全部内联策略合计不能超过 10,240 个字符，空白不计入，上限不能申请提高。<br>② 每条客户托管策略不超过 6,144 个字符，空白不计入，不可调整。<br>③ 每个角色可附加的托管策略默认 20 条，可以申请提高，自动批准的上限是 25。权限边界是否计入这个数：文档未说明。<br>④ IAM 变更要过一段时间才能在所有端点生效。官方建议生产流程在依赖变更之前先确认已经传播，但没有给出传播时间的数值（文档未说明）。<br>⑤ 调用 sts:GetCallerIdentity 不需要任何权限，即使显式 Deny 也能成功。扮演角色得到的会话，返回的 UserId 形如“角色ID:会话名”。 | **一致**<br>另含：文档未说明（传播时间、权限边界是否计数） | 01 §6.4（第 939 行）和 02 §6.3（第 1203 行）可以填入“10,240 字符（不计空白），是角色上全部内联策略之和”。ATLLearnerRole 挂着 ATLLearnerIam、ATLRevokedSessions、ATLAgentApi 三条内联策略，ATLRevokedSessions 能用的空间要扣除另外两条。07 V1-2 第 7 步和 01 §6.10 CI 的大小检查，都要按三条合计、去掉空白来算。01 §6.5（第 1138 行）的 6,144 与官方一致。02 §6.3 第 3 步“传播余量默认 2 分钟”是设计自定的值，没有官方数值支撑。07 第 560 行“探测不用 GetCallerIdentity”与官方一致。 | 需要，**V1-2**，保留：吊销写入后 Deny 对已签发会话生效的时间分布；内联策略超限时 PutRolePolicy 的错误；权限边界是否计入托管策略数。上限数值不必再测。 | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html<br>https://docs.aws.amazon.com/general/latest/gr/iam-service.html<br>https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html#troubleshoot_general_eventual-consistency<br>https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html |
| D6 | STS：角色链 1 小时上限、`DurationSeconds` 范围、`SourceIdentity` 字符集与长度、会话策略大小上限 | ① 用一个角色的临时凭证去扮演另一个角色就是角色链。角色链会话最长 1 小时，DurationSeconds 超过 3600 时调用直接失败。Lambda 执行角色、CodeBuild 服务角色、EC2 实例配置文件这几种情况，官方定义没有单独点名（文档未明确），按定义都属于角色链。<br>② DurationSeconds 取 900～43200，并且不能超过目标角色的最长会话设置（1～12 小时），不传时默认 3600。它和控制台会话的 SessionDuration 是两个独立参数。<br>③ SourceIdentity 的长度：STS API 参考写 2～64，IAM 用户指南写 2～256（官方说法矛盾）。字符为字母、数字、下划线和 + = , . @ -，不能以 aws: 开头。一旦设置，会话内不能修改，并且在角色链中延续。**角色链时，调用方的权限策略和目标角色的信任策略都要允许 sts:SetSourceIdentity，否则扮演失败**；官方跨账号示例中，即使不再显式传值，目标信任策略也包含这个动作。<br>④ 会话策略：内联 JSON 只能 1 个，托管策略 ARN 最多 10 个，两者明文合计不超过 2,048 字符。会话策略和会话标签还计入会话令牌的打包大小，这个大小另有上限，超限报 PackedPolicyTooLarge；官方没有给出打包上限的数值，建议看 SessionTokenUtilization。2,048 是否计入空白：文档未说明。 | **不一致**<br>（设计漏掉角色链所需的 `sts:SetSourceIdentity`）<br>另含：官方说法矛盾（SourceIdentity 64 与 256）；文档未说明（会话策略是否计空白、打包上限） | 一致的部分：01 §3.4、§6.2（第 894 行 MaxSessionDuration=1 小时），02 §5.1（第 901 行 clamp(…, 900, 3600)），03 §3.2 的“角色链最长 1 小时”。<br>需要修改：学员会话带着 SourceIdentity，再扮演 cloudalbum-* 或 CloudAlbum* 角色时，ATLLearnerRole 的权限策略和目标角色的信任策略都要有 sts:SetSourceIdentity。目前只有 ATLApiFunctionRole → ATLLearnerRole 这一处有（01 第 891、1421 行）。见 3.4 节。<br>03 §3.2（第 338 行）可以补上约束：按 64 字符、`[A-Za-z0-9_+=,.@-]` 校验。<br>01 §6.7 第 7 条的回收会话策略：每批 ARN 数按“内联 JSON 加 ARN 明文合计 2,048 字符，另有打包上限”计算，遇到 PackedPolicyTooLarge 时拆批重试。 | 需要，**V1-5**，必须保留并补一项：Lambda 角色扮演学员角色时传 3601 是否失败；STS 是否接受 65～256 字符的 SourceIdentity；**带 SourceIdentity 的学员会话扮演一个信任策略里没有 sts:SetSourceIdentity 的 cloudalbum-* 角色，是否失败、报什么错**；会话策略的 2,048 是否计空白，以及何时触发 PackedPolicyTooLarge。 | https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html<br>https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html#id_roles_terms-and-concepts<br>https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html<br>https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html#reference_iam-quotas-entity-length |
| D7 | 控制台联合登录：登录 URL 有效期；SessionDuration 与角色链；DurationSeconds 与长期凭证；是否支持 POST；区域端点 | ① 联合端点生成的登录 URL 自生成起 15 分钟内有效，与背后临时凭证的有效期无关。<br>② 只有 AssumeRole* 凭证可以在 getSigninToken 时传 SessionDuration，取值 900～43200，并且必须小于角色的最长会话时长。不传时，控制台会话默认等于凭证的时长。用角色链凭证传 SessionDuration，调用会失败。默认的控制台会话是在凭证到期（Expiration）时结束，还是从登录起再算满一个凭证时长：文档未说明。<br>③ 同页对“AssumeRole* 是否必须用 IAM 用户长期凭证调用”说法不一：步骤说明只在带 DurationSeconds 时这样要求，Important 提示笼统要求长期凭证，另有说明和 Python 示例又允许用临时凭证（官方说法矛盾）。<br>④ getSigninToken 和 login 两步都注明支持 POST，页面也有 POST 示例；但两步各有一条注释说其后的说明只适用于 GET。<br>⑤ 可以使用 `https://{region-code}.signin.aws.amazon.com/federation`。Sign-In 端点表列有 ap-northeast-1；us-east-1 用默认的全局端点。最终登录 URL 使用与第 5 步相同的联合端点。区域端点失败时退回全局端点是否可行：文档未说明。<br>⑥ 同页一条注释说，EC2 实例上的应用使用角色时不受角色链 1 小时限制；这与 IAM 术语页“不论怎样设置都限 1 小时”的写法不完全一致。 | **官方说法矛盾**<br>（长期凭证要求；EC2 例外）<br>另含：文档未说明（控制台会话的结束时刻、跨端点使用 SigninToken） | 03 §5 现行方案维持不变：不传 DurationSeconds 和 SessionDuration，两步都用 POST，链接 15 分钟有效，login 提交到签发令牌的同一个端点。03 §1.2、§11 D8 已如实记录了这处矛盾。<br>设计内部还有一处自相矛盾：01 §8.3（第 1933 行）写控制台通道传 DurationSeconds=3600，03 §5（第 1086、1107 行）写不传。见 3.5 节。<br>新增风险：如果实测发现控制台会话从登录时起算，03 §5.3 和 02 中回收器的 CloudTrail 扫描窗口要改。 | 需要，**V1-5 / 03 PoC ⑩**，必须保留：角色链、不带 DurationSeconds 时两步能否成功；带 900 或 3600 时是否失败；凭证签发约 40 分钟后再登录，控制台会话在何时结束；ap-northeast-1 区域端点两步 POST 是否都可用，跨端点提交令牌的结果；CloudTrail 中控制台操作的 AccessKeyId、会话名和 SourceIdentity。 | https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html<br>https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html<br>https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html<br>https://docs.aws.amazon.com/general/latest/gr/signin-service.html |
| D8 | KMS：计划删除的等待期范围；禁用与计划删除期间如何计费 | ① ScheduleKeyDeletion 的 PendingWindowInDays 取 7～30 天（含两端），不传时默认 30。实际删除可能比计划晚最多 24 小时。等待期结束时，密钥和指向它的全部别名一起删除。等待期内状态为 PendingDeletion，不能用于任何加密操作，可以用 CancelKeyDeletion 取消。<br>② Enabled 和 Disabled 的密钥都可以计划删除；对已处于 PendingDeletion 的密钥再次调用会返回 KMSInvalidStateException。DeleteAlias 在任何密钥状态下都能调用。<br>③ 每把密钥 $1/月，按小时折算；处于计划删除状态的客户托管密钥不收费；在等待期内取消删除，等待期的费用要补收。<br>④ 定价页没有单独提到禁用的密钥。AWS Prescriptive Guidance 写明，禁用的密钥继续产生存储费用。<br>⑤ 每月 2 万次免费请求不覆盖非对称密钥的 Sign、Verify、GetPublicKey 等请求。 | **一致** | 01 §4.3 的 KeyPendingWindowDays=7 在范围内（最小值），可以加 AllowedValues 7～30，并补一句“实际删除可能晚最多 24 小时”。02 §7.5 S5 的“等待删除视为完成”“先删别名”与官方一致。01 §11 的 KMS 一行可以写明：计划删除期间不收月费，等待期内取消会补收。04 §10.8 与附录 A R-22“禁用的密钥仍计费”一致，出处是 Prescriptive Guidance，不是定价页。 | 不需要（07 中为“—”）。可选：在 V0-3 的账单数据里旁证计划删除期间没有 KMS 月费。 | https://docs.aws.amazon.com/kms/latest/APIReference/API_ScheduleKeyDeletion.html<br>https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html<br>https://docs.aws.amazon.com/kms/latest/developerguide/key-state.html<br>https://aws.amazon.com/kms/pricing/<br>https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-kms-best-practices/key-management.html |
| D9 | Secrets Manager：恢复窗口；强制删除；同名重建 | ① RecoveryWindowInDays 取 7～30 天；两个参数都不传时默认 30 天。窗口结束后的永久删除是低优先级的后台任务，不保证具体完成时间。窗口内可以用 RestoreSecret 取消。计划删除中的 secret 读不到值，也不收费。<br>② ForceDeleteWithoutRecovery 跳过恢复窗口，删除后不能恢复，不能与 RecoveryWindowInDays 同时使用；实际删除由异步后台进程完成，可能有短暂延迟。对已删除或不存在的 secret 强制删除，不返回 ResourceNotFoundException。对已处于恢复窗口中的 secret 能否直接强制删除：文档未说明。<br>③ 删除后立即同名创建时，官方只要求退避重试，没有给出等待时长（文档未说明）。新建同名 secret 的 ARN 末尾有 6 个随机字符，旧 ARN 上的授权不会带过来。<br>④ 计划删除中的 secret 用 DescribeSecret 仍能查到，并带 DeletedDate；真正删除后返回 ResourceNotFoundException。 | **文档未说明**<br>（同名重建的等待时长；窗口内能否强制删除） | 02 §7.5 S2 的整体方案保留，用 DescribeSecret 返回“不存在”作为完成判据，与官方一致。“立即删除”的措辞宜改为“立即不可访问，后台异步删除”。由于官方没有给出同名重建的等待时长：平台模式下 secrets 模块名称应带 envName；创建同名 secret 的代码要有退避重试；回收报告不要把“已不可见”当成名称可以复用。 | 需要，**V1-14**，必须保留：恢复窗口中的 secret 能否直接强制删除；强制删除后同名 CreateSecret 要等多久；窗口内同名创建的错误码；强制删除后 DescribeSecret 多久返回不存在。 | https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html<br>https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html<br>https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DescribeSecret.html<br>https://docs.aws.amazon.com/secretsmanager/latest/userguide/manage_delete-secret.html |
| D10 | SQS：删除队列后同名重建需要等待多久 | ① 删除过程最长需要 60 秒。这 60 秒内，涉及该队列的请求（例如 SendMessage）可能仍然成功，但 60 秒后队列和消息都不存在。删除时队列中的消息全部丢失。<br>② 删除后至少要等 60 秒才能创建同名队列，DeleteQueue 和 CreateQueue 两个 API 页都写了这一点；在此期间 CreateQueue 返回 QueueDeletedRecently。<br>③ 新队列创建后至少要等 1 秒才能使用。同名同属性调用 CreateQueue 返回已有队列的 URL，属性不同则返回 QueueNameExists。 | **一致** | 设计原文只写“要等一段时间（以官方文档为准）”，与官方不冲突，现在可以补上 60 秒。service-cards-2 第 1051 行的 svc-queue 清理说明改为“删除后至少 60 秒内不能重建同名队列，期间返回 QueueDeletedRecently”。scripts/module 和 queue 模块对 QueueDeletedRecently 至少等 60 秒再重试。02 的回收器以“删除 60 秒后 GetQueueUrl 返回 QueueDoesNotExist”为完成判据。 | 可降级，**V4-4** 只做印证：重点看经 CloudFormation 删栈后立即建同名队列时，栈删除完成时刻与 60 秒窗口的关系，以及 CloudFormation 的报错文本。 | https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteQueue.html<br>https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CreateQueue.html |
| D11 | RDS：停止的实例多久后自动启动；RDS Proxy 支持的实例类（db.t3.micro、db.t4g.micro、db.t4g.small） | ① DB 实例最多连续停止 7 天，满 7 天还没有手动启动，RDS 会自动启动它。<br>② 有只读副本的实例、只读副本本身、Multi-AZ 部署的 RDS for SQL Server 不能停止。<br>③ 已停止的实例不能修改；停止过程可能需要几分钟，长则约 1 小时；停止期间实例小时不计费，但存储、备份存储，以及可公开访问实例的公网 IPv4 照常计费。<br>④ RDS Proxy 的“配额与限制”和“支持的区域与引擎”两页都没有对实例类（包括 T 系列）设限制，但也没有列出支持的实例类清单。三种实例类能否作为代理目标：文档未说明。<br>⑤ 代理只能关联写实例，不能关联只读副本；必须与数据库在同一个 VPC，自身不能公开访问；默认端点分布在两个 AZ；每账号默认最多 20 个代理；按底层实例的 vCPU 每小时计费，最少收 10 分钟。 | **文档未说明**<br>（RDS Proxy 是否支持这三种 T 系列实例类）<br>停止 7 天自动启动：一致 | 02 §8.2“官方为 7 天”一致，可补：停止可能长达约 1 小时；已停止的实例不能修改；停止期间存储、备份与公网 IPv4 照常计费，确认对话框应列出这几项。05 §10.4 的“RDS Proxy 是否支持 T 系列”从“未核实”改为“官方未限制也未明列，待实测”。svc-db-proxy 与 sc-db-performance 注明代理只能挂写实例，子网要覆盖两个 AZ。 | 需要（07 当前为“—”，建议补一项）：在 V4 的 svc-db-proxy 冒烟或单独的最小测试中，用 db.t4g.micro（可再加 db.t3.micro）的 RDS for PostgreSQL 建代理并注册目标，确认 TargetHealth 为 AVAILABLE。“停止 7 天后自动启动”不需要实测。 | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html<br>https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html<br>https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RDS_Fea_Regions_DB-eng.Feature.RDSProxy.html<br>https://aws.amazon.com/rds/proxy/pricing/ |
| D12 | Route 53：托管区域如何计费；Alias 查询如何计费 | ① 前 25 个托管区域每个 $0.50/月，之后每个 $0.10/月。月费**不按不足一个月折算**：创建时收一次，之后每月 1 日再收一次。创建后 12 小时内删除的托管区域不收托管区域费，但公有托管区域的查询仍计费。<br>② 标准查询前 10 亿次每百万次 $0.40，超出部分每百万次 $0.20。<br>③ Alias 指向 CloudFront、ELB、API Gateway、VPC 终端节点、配置为网站端点的 S3 桶等 AWS 资源时，查询不收费；指向同一托管区域中的非 Alias 记录时按标准查询收费。CNAME 指向 Route 53 中另一条记录时，每次查询按两次计费。 | **不一致**<br>（scenario-cards 与 05 暗含按时间折算） | sc-static-acceleration 的“托管区域月费与查询（Alias 指向 AWS 资源的查询不收费）”一致。scenario-cards 第 127 行把托管区域归为“按月折算的小额固定项”，05 第 457 行把它放进“按容量单位小时计费的小额项”，两处都与“不折算、12 小时内删除免收”不符。见 3.6 节。 | 不需要（07 中为“—”）。如需旁证 12 小时免收规则，可以在 V0-3 账单数据中观察，不是必须的。 | https://aws.amazon.com/route53/pricing/<br>https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html |
| D13 | CloudFront：失效免费配额；`AllViewerExceptHostHeader` 是否转发 `Authorization`；最小 TTL 与源站 no-cache；Requests 指标延迟 | ① 每个账号每月前 1,000 条失效路径免费，额度按账号下全部分配合计，标签失效也计入。超出部分每条 $0.005。带 * 的通配符路径只算 1 条。速率配额为每秒 150 条路径或标签、每秒 1 个通配符失效。<br>② 该托管策略转发除 Host 外的全部查看器请求头、全部 Cookie 和查询串，并附加若干 CloudFront 头，面向 API Gateway、Lambda 函数 URL 这类源站。这一页没有点名 Authorization；从“除 Host 外全部转发”可以推出会转发，但这是推断。专讲转发 Authorization 的小节给了三种做法：放进缓存策略的缓存键；**在源请求策略里单独列出 Authorization**；或用转发全部查看器头的策略（点名的是 Managed-AllViewer）。没有相应配置时，CloudFront 会去掉 GET/HEAD 请求的 Authorization。<br>③ 最小 TTL 为 0 时，CloudFront 遵守源站的 no-cache、no-store、private；最小 TTL 大于 0 时，CloudFront 至少按最小 TTL 缓存。CachingOptimized 的最小 TTL 为 1 秒，CachingDisabled 的三个 TTL 都是 0。<br>④ 默认指标免费、粒度 1 分钟，要在 us-east-1 读取，维度为 DistributionId 加 Region=Global。指标数据延迟：文档未说明（只有 2014 年的博客提到“数分钟前的活动”，不作依据）。 | **不一致**<br>（modules/01 第 646 行的转发方式；01 §3.8 no-cache 的描述）<br>另含：文档未说明（指标延迟） | 一致的部分：04 §11.2（第 3363 行）“最小 TTL 大于 0 时无视源站 no-cache/private”（官方还包括 no-store）；01 §3.8 的 /api/v1/* 用 CachingDisabled 加 AllViewerExceptHostHeader；04 §7.4 第 5 步在 us-east-1 读 Requests。<br>需要修改：modules/01 第 646 行；01 §3.8 的 no-cache 描述；01 §3.8 与 04 §11 的失效费用说明；04 §7.4、01 §7.3 的复核间隔不能引用官方数字。见 3.7 节。 | 需要，**V4-5、V5-1**，必须保留：经 CloudFront 用 GET 和 POST 带 Authorization 访问 /api/v1/*，确认源站收到 Authorization 且 Host 是 execute-api 域名；对 no-cache 的 index.html 连续请求，观察 1 秒内是否命中；多次记录 Requests 数据点的出现延迟，取 p50/p95。失效计费不需要实测。 | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html<br>https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-invalidations<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html#add-origin-custom-headers-forward-authorization<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-401-unauthorized.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/viewing-cloudfront-metrics.html<br>https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html<br>https://aws.amazon.com/blogs/aws/cloudfront-up-trends-metrics-stats/（2014 年博客，仅作旁证） |
| D14 | ACM ACME：端点、EAB、`ListCertificates` 过滤参数、计费维度（复核 2026-10-13 之后的变化） | 复核结论：2026-10-13 之后没有新的 ACM ACME 公告，也没有新的文档历史条目。文档历史最新一条是 2026-09-28（ACME 条件键）；What's New 最新一条是 2026-10-06 的“ACME 经 PrivateLink 签发”，modules/01 已收录。<br>① 端点：目录 URL 形如 `https://acm-acme-enroll.<region>.api.aws/<id>/directory`；授权方式只有 PRE_APPROVED；可选密钥算法为 RSA_2048、EC_prime256v1、EC_secp384r1。删除端点会连带删除它的 EAB、域验证和 ACME 账户。每账号每区域 50 个端点；ACME 证书不计入 ACM 的证书配额；单张证书最多 100 个域名。<br>② 域验证用持久 CNAME，最多尝试 72 小时。<br>③ EAB 绑定一个 IAM 角色，信任主体为 acm-acme.amazonaws.com，需要 sts:AssumeRole、TagSession、SetSourceIdentity；创建 EAB 的人需要对该角色有 iam:PassRole。<br>④ ListCertificates 默认不返回 ACME 证书，要用 CertificateKeyPairOrigins 加入 ACME；**它的默认过滤还只返回 RSA_2048 证书**，ECDSA 证书要在 Includes.keyTypes 中显式列出。SearchCertificates 默认包含 ACME 证书。<br>⑤ 计费按“每个域名在签发和每次自动续期时”计：FQDN 首档每域名 $1.00，通配符首档 $5.00；ACME API 调用每月前 30k 次免费。<br>⑥ 2026-09-28 的更新：ACME 签发按 acm:RequestCertificate 授权；端点设置了 CertificateTags 时还要单独按 acm:AddTagsToCertificate 授权，缺少就签发失败；经 ACME 吊销时只带 CertificateKeyPairOrigin 一个条件键，吊销语句附加域名或算法条件会全部被拒。<br>⑦ 签发最多约 2 分钟，证书有效期 45 天。未过期的 ACME 证书能否删除：文档未说明。 | **不一致**<br>（modules/01 签发角色权限与列证书参数不完整）<br>另含：文档未说明（未过期证书能否删除） | modules/01 tls 节在 10-13 核实的结论仍然成立，05 §4.6 回退档的触发条件不需要改。需要修改：modules/01 第 1288 行签发角色（加 AddTagsToCertificate、吊销语句单独写）；第 1307 行与 tls 感知器（ECDSA 过滤）；第 1291 行 EAB 命令参数。见 3.8 节。svc-tls 报价可以按每次签发或续期 $1.00/FQDN（首档）估算。 | 需要，**V3-5**，必须保留：带 CertificateTags、缺少 AddTagsToCertificate 时签发是否失败；只加 ACME 来源时 list-certificates 是否列出 ECDSA 证书；未过期证书能否删除；CLI 是否包含 ACME 子命令；实际签发耗时；不带域名条件的吊销是否成功。 | https://docs.aws.amazon.com/acm/latest/userguide/dochistory.html<br>https://aws.amazon.com/about-aws/whats-new/2026/07/aws-certificate-manager-acme/<br>https://aws.amazon.com/about-aws/whats-new/2026/10/AWS-Certificate-Manager-ACME-Privatelink/<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-acme.html<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-acme-endpoints.html<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-acme-domain-validation.html<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-acme-eab.html<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-acme-issuance.html<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-conditions-acme.html<br>https://docs.aws.amazon.com/acm/latest/APIReference/API_ListCertificates.html<br>https://docs.aws.amazon.com/acm/latest/userguide/acm-limits.html<br>https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-certificatemanager-acmeendpoint.html<br>https://aws.amazon.com/certificate-manager/pricing/ |
| D15 | Let's Encrypt：IP 证书的配置档、有效期、验证方式、签发限额 | ① 只有 shortlived 配置档接受 IP 标识；classic（90 天）和 tlsserver（45 天）只接受 DNS 名称。客户端要支持 ACME Profiles 并显式请求 shortlived。2026-01-15 起，shortlived 证书和 IP 证书对所有用户开放。<br>② 有效期 160 小时（略多于 6 天）。默认证书寿命计划在未来几年从 90 天逐步降到 45 天。<br>③ IP 标识只能用 HTTP-01（80 端口）或 TLS-ALPN-01（443 端口），不能用 DNS-01。Certbot：IP 证书配合 webroot 需要 5.4 及以上；webroot、manual、standalone 三种插件可用，nginx 和 apache 插件还不支持 IP 证书；证书安装需要 deploy-hook。<br>④ 限额：同一注册域（IPv4 按单个地址计）每 7 天 50 张；每账户每 3 小时 300 个新订单；标识集合相同的证书每 7 天 5 张；每个标识每账户每小时 5 次授权失败；每个 IPv4 地址每 3 小时 10 次新账户注册。通过 ARI 发起的续期豁免全部限额。<br>⑤ 有效期不足 10 天的证书，建议在寿命过半时续期，每天至少查询两次 ARI。 | **一致** | 03 §6.2 方案 B（shortlived、160 小时、过半前续期、HTTP-01 或 TLS-ALPN-01、不能用 DNS-01）和 modules/01 第 1394 行一致。05 §10.4、06 PM-21 的“以官方文档为准”可以换成上面的数值。建议补充：tls 本地档安装 certbot 时版本下限固定为 5.4，使用 shortlived、--ip-address、webroot 和 deploy-hook；Certbot 不提供 TLS-ALPN-01，按现有实现方案 B 只能走 HTTP-01，03 §6.2 的前提应写明“80 端口对公网开放”；数据卷丢失后反复重签可能触发“相同集合每 7 天 5 张”的限额，优先用 ARI 续期。 | 需要，**V3-4**，保留：在 EIP 上用 certbot 5.4 以上签发 IP 证书，确认有效期 160 小时、续期触发时机和 deploy-hook；关闭 80 端口后签发应失败并回退到自签名。 | https://letsencrypt.org/docs/profiles/<br>https://letsencrypt.org/docs/challenge-types/<br>https://letsencrypt.org/docs/rate-limits/<br>https://letsencrypt.org/docs/integration-guide/<br>https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability<br>https://letsencrypt.org/2026/03/11/shorter-certs-certbot |
| D16 | IAM Access Analyzer：每区域外部访问分析器数量上限；计费 | ① 账号级分析器每种类型、每账号、每区域只能有 1 个，不可调。组织级外部访问或未使用访问分析器默认 5 个，最多 20 个（可调）。<br>② 外部访问分析、策略生成、ValidatePolicy 都不另收费。收费的有三项：未使用访问分析（按每月每个被分析的角色或用户）、内部访问分析（按每区域每月每个被监控资源）、自定义策略检查（按调用次数）；具体单价出现在定价页的示例里。<br>③ 已有账号级分析器时再创建一个，CreateAnalyzer 返回什么错误名：文档未说明。 | **一致**<br>另含：文档未说明（重复创建的错误名） | 01 §3.10 的 create/existing/off 三档和 Preflight 检测与官方吻合。建议把“以官方文档为准”改成明确约束：Preflight 发现本区域已有 ACCOUNT 类型分析器时，create 一定失败，应自动改用 existing 或阻止安装。01 第 1308、1442 行 CI 中的 ValidatePolicy 免费；如果 CI 使用 CheckNoNewAccess 一类自定义策略检查，要在费用说明里写明按次计费。01 第 2312 行可以改为“外部访问分析免费”。 | 需要，**V5-1**，只测重复创建时的错误名，以及外部访问分析器不出现在账单计费行中。 | https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-quotas.html<br>https://aws.amazon.com/iam/access-analyzer/pricing/ |
| D17 | 成本分配标签（激活时延、成员账号限制）；Cost Explorer API 计费；“IAM 访问账单信息”开关；Budgets 控制台入口 | ① 标签打到资源上后最长约 24 小时才出现在成本分配标签页，激活后还要最长约 24 小时生效。UpdateCostAllocationTagsStatus 每次最多 20 个键；某个键尚未出现时，只有这个键返回 TagKeysNotFoundException，整个请求不会失败。<br>② 激活只从激活时起生效，但**管理账号可以申请最多 12 个月的回填**，每 24 小时只能提交一次。<br>③ 只有组织的管理账号和独立账号能管理成本分配标签，成员账号不能激活。<br>④ Cost Explorer API 每个分页请求 $0.01，端点在 us-east-1。不能通过 API 启用 Cost Explorer；创建第一个预算时会自动启用它。<br>⑤ “Activate IAM Access”开关**只能由根用户开启**，每个账号开启一次即可。未开启时，IAM 主体即使有策略也进不了账单控制台的大多数页面；Organizations 创建的成员账号默认已开启。这个开关不控制 Cost Explorer、Budgets、CUR 的 API 访问。<br>⑥ Budgets 从账单与成本管理控制台的左侧导航进入；教程链接为 `billing/home#/budgets/overview`。Budgets 数据每天最多更新三次，间隔通常 8～12 小时。<br>附带：Cost Explorer 预测期一页写 12 个月、另一页写 18 个月；控制台路径一处写 costmanagement、另一处写 cost-management（与设计无关）。独立账号能否回填：文档未说明。 | **不一致**<br>（02 §10.4“不追溯历史”）<br>另含：官方说法矛盾（与设计无关的小矛盾）；文档未说明（独立账号能否回填） | 一致的部分：标签出现和激活各最长约 24 小时；成员账号只能由管理账号激活；Cost Explorer API 按请求计费、需要学员确认；开关只能由根用户开启，CLI 路径不受开关限制。<br>需要修改：02 §10.4（第 2144 行）“不追溯历史”；平台动作 cost-activate-tags 的成功判定；04 §9.3 处理“Cost Explorer 尚未启用”；03 §5.4 的入口说明。见 3.9 节。 | 07 中为“—”。建议在 **V0-3** 账号预检中顺带确认：独立账号还是成员账号；“Activate IAM Access”开关的当前状态（开启只能由根用户在控制台完成，由用户决定是否执行）；Cost Explorer 是否已启用；标签键尚未出现时 UpdateCostAllocationTagsStatus 的实际返回。 | https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html<br>https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html<br>https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-allocation-backfill.html<br>https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_UpdateCostAllocationTagsStatus.html<br>https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html<br>https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api.html<br>https://docs.aws.amazon.com/cost-management/latest/userguide/ce-enable.html<br>https://docs.aws.amazon.com/cost-management/latest/userguide/ce-access.html<br>https://aws.amazon.com/aws-cost-management/aws-cost-explorer/pricing/<br>https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/control-access-billing.html<br>https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html<br>https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html |
| D18 | SSM：ENV_VAR 插值的最低 Agent 版本；GetCommandInvocation 截断长度；Session 文档字段取值范围；Run Command 参数长度上限 | ① ENV_VAR 插值需要文档 schema 2.2，且 SSM Agent 不低于 3.3.2746.0。Agent 会生成环境变量 `SSM_<参数名>`，参数值按字面量传入；更旧的 Agent 会忽略 interpolationType，只对命令文本里的 `{{ }}` 做原样替换。allowedPattern 会校验两次：API 侧用 Java regex，Agent 侧用 Go regexp。<br>② StandardOutputContent 只返回 stdout 的前 24,000 个字符，StandardErrorContent 只返回 stderr 的前 8,000 个字符；命令没有结束时这两个字段为空；完整输出要从 S3 或 CloudWatch Logs 取。<br>③ Session 文档：schemaVersion 只支持 1.0；idleSessionTimeout 取 1～60 分钟（配额页默认 20）；maxSessionDuration 取 1～1440 分钟；四个布尔字段都是必填；runAsEnabled=true 时 runAsDefaultUser 必须存在，否则会话启动失败，不会回退到 ssm-user。RunAs 的判定顺序，schema 页和 Run As 页的写法不同（官方说法有出入）。Linux 会话默认用 sh 启动。**Session Manager 不支持用操作系统的 root 用户认证会话**（指节点上的 OS 用户，不是 AWS 账户根用户）。<br>④ SendCommand 的 Parameters 字段没有长度约束，配额页也没有“Run Command 参数总大小”这一条：文档未说明。能确认的有：文档大小上限 64 KB；Comment 最多 100 字符；参数可以用 minChars/maxChars 自行限定长度。 | **文档未说明**<br>（Run Command 参数总大小）<br>另含：官方说法矛盾（RunAs 顺序，不影响设计）；由推断得出的风险（Agent 侧正则） | 01 §3.6 第②条、04 §6.1 设计要点 2 可以回写为 SSM Agent ≥ 3.3.2746.0，实验机、工作台 AMI 和 ASG 新实例都要满足。启动器在变量缺失时输出 RUNNER_UNAVAILABLE、不回退到文本替换，与官方描述相符。<br>**推断风险**：04 §6.1（第 2182 行）ArgsB64 的 allowedPattern 是 `'^[A-Za-z0-9_-]{2,6000}$'`。官方说 Agent 侧用 Go regexp 再校验一次，而 Go 的 regexp/syntax 拒绝超过 1000 的重复计数，Agent 可能编译不了这个正则，导致每次检查都失败；API 侧的 Java 正则没有这个限制，所以创建文档时不会报错。建议改为 `'^[A-Za-z0-9_-]+$'` 加 maxChars: 6000，由启动器复核长度。<br>03 §1.2、§4.11、04 §6.1 的“约 24,000 字符”可以去掉“约”，并补一句 stderr 只返回前 8,000 字符。03 §1.2、§3.3 的 Session 字段与官方一致，idle 20、max 240 在合法范围内。04 §6.1 设计要点 6 的“参数总大小”只能由实测确定。 | 需要，**V2-5**，必须保留：记录 Agent 版本并确认 SSM_ 环境变量存在；**用 6000 字符的 ArgsB64 调用 ATL-RunCheck，确认 Agent 侧的 {2,6000} 是否报错，并对照“+ 加 maxChars”的写法**；逐步加大参数长度，找出 SendCommand 实际能接受的上限；stdout 超过 24,000 字符时截断判定是否生效；ATL-SessionShell 能否正常开会话。 | https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-schemas-features.html<br>https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-syntax-data-elements-parameters.html<br>https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetCommandInvocation.html<br>https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-schema.html<br>https://docs.aws.amazon.com/systems-manager/latest/userguide/session-preferences-run-as.html<br>https://docs.aws.amazon.com/systems-manager/latest/userguide/session-preferences-shell-config.html<br>https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_SendCommand.html<br>https://docs.aws.amazon.com/general/latest/gr/ssm.html<br>https://pkg.go.dev/regexp/syntax（非 AWS 来源，AWS 参数页链接到 Go regexp 库，这里仅用于核实上面的推断） |
| D19 | CloudShell：CPU 架构；存储；空闲超时；主目录按角色还是按角色会话隔离 | ① 用户指南和 FAQ 只说环境基于 Amazon Linux 2023，没有写是 x86_64 还是 arm64：文档未说明。规格页安装 AWS CLI 的示例下载的是 x86_64 安装包，只能算旁证。<br>② 每个环境 1 vCPU、2 GiB 内存。每个区域 1 GB 免费持久存储，位于 $HOME，跨区域不共享。$HOME 之外的文件和用 dnf 安装的软件在会话结束后被回收。某区域 120 天不使用，该区域的数据会被删除。VPC 环境没有持久存储。<br>③ 20～30 分钟没有键盘或指针交互，会话结束，后台进程不算交互；会话连续运行约 12 小时后会被结束。<br>④ 每账号每区域最多同时 10 个 shell；单条命令不能超过 65412 个字符；没有入站端口和公网 IP，但可以出站访问公网；CloudShell 本身不另收费。<br>⑤ 文档只说持久存储“私有于你”，FAQ 说每个区域每个用户一个 VM（“用户”指能登录控制台的 IAM 主体）。扮演的角色是按角色还是按会话名区分主目录：文档未说明。 | **文档未说明**<br>（CPU 架构、主目录隔离粒度） | 03 §4.9：“CPU 架构以官方文档为准”文档给不出答案，确认之前要么同时构建 x86_64 和 arm64 两份、按 `uname -m` 选择，要么等实测结果。“存储与空闲超时”可以回写为：每区域 1 GB；20～30 分钟无交互断开；约 12 小时强制结束；120 天不用则删除。由此带来的约束：工具包加 node_modules 要明显小于 1 GB；较长的 `scripts/module enable` 如果期间没有键盘输入，20～30 分钟会断开，手册应提示；一键引导命令必须远短于 65412 字符。如果主目录按角色隔离，下一次会话会看到上次留下的文件，$HOME 中不能有机密，引导命令要覆盖旧的环境变量文件。 | 需要（07 中为“—”，建议补一项，可以并入 V1-5）：在 CloudShell 中执行 `uname -m` 记录架构；用两个不同的会话名打开 CloudShell，检查第二个会话能否看到第一个会话写入 $HOME 的文件。 | https://docs.aws.amazon.com/cloudshell/latest/userguide/vm-specs.html<br>https://docs.aws.amazon.com/cloudshell/latest/userguide/limits.html<br>https://docs.aws.amazon.com/cloudshell/latest/userguide/working-with-aws-cloudshell.html<br>https://aws.amazon.com/cloudshell/faqs/ |
| D20 | CHIPS（`Partitioned` Cookie）在 Chrome、Firefox、Safari 当前版本的状态 | ① Chrome 从 114 起默认启用，origin trial 已结束；Edge 也是 114 起支持。<br>② Firefox：MDN 兼容数据和 Privacy Sandbox 状态表都写 141（2025-07-22）。但 MDN 的 Firefox 131 开发者说明已经写了支持 CHIPS，MDN 自己对起始版本说法不一，不影响“当前版本可用”的结论。<br>③ Safari（macOS 与 iOS）：18.4 首次上线，18.5 移除，26.2（2025-12-12）重新上线。Safari 27.0 中与分区 Cookie 相关的只有一条修复，支持状态不变。MDN 把分区 Cookie 标为 Baseline 2025“新近可用”。<br>④ Safari 要求 Partitioned 与 SameSite=None、Secure 一起设置；分区键是站点而不是来源。Chrome 要求 Secure，并推荐 __Host- 前缀。 | **一致**<br>另含：官方说法矛盾（MDN 对 Firefox 起始版本，不影响结论） | 03 §1.2 和 §6.3 的历史描述（Chrome 114、Firefox 141、Safari 18.4 上线 / 18.5 关闭）与官方一致。“之后版本以 MDN 为准”可以回写为：Safari 从 26.2 起（macOS 与 iOS）重新支持，18.5～26.1 不可用。§6.3 的“Chrome、Firefox 当前版本可用”成立，可补上“Safari 26.2 及以上可用”。iframe 中“登录后仍未登录 → 提示改用新标签页”的降级逻辑要保留。现在的登录 Cookie 属性满足 Safari 的要求。Firefox 起始版本按 141 记录。 | 需要，**V3-4、V5-3**，保留：在当前稳定版 Chrome、Firefox、Safari（≥26.2，含 iOS）上确认 iframe 预览内登录能保持，且与新标签页互相独立；如有 Safari 18.5～26.1 设备，再验证降级提示。 | https://bcd.developer.mozilla.org/bcd/api/v0/current/http.headers.Set-Cookie.json<br>https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies<br>https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/131<br>https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141<br>https://privacysandbox.google.com/3pcd/chips<br>https://webkit.org/blog/17640/webkit-features-for-safari-26-2/<br>https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ |
| D21 | Lambda：预留并发为 0 时，异步调用的事件去了哪里 | ① 并发配置页：把预留并发设为 0 就是有意限流，在移除限制之前，函数不处理任何事件。<br>② 异步错误处理页：因并发不足被限流（429）或出现 5xx 系统错误时，Lambda 把事件放回队列重试，默认最长 6 小时（受最大事件年龄约束），重试间隔从 1 秒开始指数增长，最长 5 分钟；事件过期或用尽重试后被丢弃，配置了 DLQ 或失败目标时会先送到那里。<br>③ 指标页对 AsyncEventsDropped 的说明把“预留并发可能被设为 0”与“超过最大事件年龄”“用尽重试次数”并列为丢弃原因。<br>④ 通用规则是“被限流就放回队列重试”，指标说明却把“预留并发为 0”单独列为丢弃原因。并发为 0 时事件是立即被丢弃（先进入失败目标），还是先按限流规则重试、到最大事件年龄才被丢弃：文档没有说明。 | **官方说法矛盾** | svc-image-processing 第 6 步（service-cards-2 第 906 行）、labs/svc-image-processing/manual/60-throttle.md 第 24～25 行、checks/image-processing.yaml 第 246 行、05 第 697 行都断言“被丢弃并送往失败目标”，比官方文字更肯定，必须继续保留“以实测为准”。仓库里另有相反的旧表述：docs/modules/04-compute-async.md 第 574 行、docs/labs.md 第 580 行、scenario-cards 第 577、587、633 行、experiments/image-processing/experiment.json 第 116 行。见 3.10 节。模块配置为 MaximumEventAgeInSeconds=3600、MaximumRetryAttempts=2（infra/modules/image-processing.yaml 第 330～333 行），恢复后的观察窗口至少要超过 5 分钟，才能区分两种行为。 | 需要，**V4-3**，必须保留：reserved=0 期间上传 N 张照片，逐分钟记录 AsyncEventsReceived、AsyncEventsDropped、Throttles、AsyncEventAge 和失败队列消息；删除预留并发后再观察至少 10 分钟。刹车期间失败队列已有记录、恢复后没有补跑，说明是“立即丢弃”；恢复后有补跑，说明是“排队重试”。 | https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html<br>https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html<br>https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html |
| D22 | Resource Groups Tagging API 对 IAM 角色、Auto Scaling 组的覆盖 | ① Tagging API 参考 Welcome 页（2026-10-13 版本）有两条具体例外：IAM 用户和角色只能用于 TagResources、UntagResources，GetResources 目前不支持；Auto Scaling 组可以打标签、去标签，但 GetTagKeys、GetTagValues、GetResources 目前不支持，会返回空结果。<br>② 同一页开头却说三个 Get* 操作“支持所有资源类型”，GetResources 页也说凡打过标签的资源都会被返回，与①矛盾。取更具体的例外说明为准。<br>③ GetResources 按区域返回“当前或曾经打过标签”的资源；从未打过标签的资源不返回。每页最多 100 条；TagFilters 最多 50 个键、每个键 20 个值；分页令牌 15 分钟后过期。“刚删除的资源短时间内仍会被返回”：文档未说明。 | **官方说法矛盾**<br>另含：文档未说明（删除后的残留时间） | 02 §7.1“GetResources 不返回 IAM 用户与角色、对 ASG 返回空”与官方的具体例外一致，现有的绕行方案（iam:ListRoles 加 ListRoleTags；DescribeAutoScalingGroups 的标签过滤）保持不变。01 §3.1 的“覆盖不全”可以写得更精确。“刚删除的资源可能仍被列出”没有官方依据，应改为“以实测为准”。02 §7.1 第 4 条“删除前先用服务 API 确认存在”保留。见 3.11 节。 | 需要，**V1-10**，保留：给 IAM 角色和 ASG 打上标签，用两种类型过滤和不带过滤三种方式调用 GetResources，确认都不返回；删除一个带标签的资源后每分钟调用一次，记录它还会被返回多久。 | https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/Welcome.html<br>https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/API_GetResources.html |
| D23 | Session Manager 的并发会话配额；没有公网出口时需要哪些接口终端节点（是否仍需 `ec2messages`） | ① Systems Manager 配额页的 Session Manager 部分只列出 API 调用频率（StartSession 3 TPS；DescribeSessions、ResumeSession、TerminateSession 各 6 TPS；GetConnectionStatus 50 TPS）、空闲超时（默认 20 分钟，可设 1～60）和 30 天执行历史，没有每个实例或每个账号的并发会话数配额：文档未说明。<br>② 必需：`ssm` 和 `ssmmessages` 接口终端节点。ssmmessages 用于 Agent 与服务的通信、Run Command 和 Session Manager 数据通道。ec2messages 仍出现在终端节点清单里，但该条目和“消息 API 参考”页都说明：SSM Agent 从 3.3.40.0 起，只要 ssmmessages 可用就优先使用它；只要 IAM 允许 ssmmessages，即使同时允许 ec2messages，Agent 也只连 ssmmessages；2024 年之前上线的区域可以安全移除 ec2messages 权限；2024 年及之后上线的区域只支持 ssmmessages。<br>③ 可选：S3 终端节点（Agent 更新和访问 AWS 托管的 S3 桶，终端节点策略要放行这些桶）；logs（会话日志写入 CloudWatch Logs）；kms（会话 KMS 加密或 SecureString）；ec2（只用于 VSS 快照）。终端节点的安全组要放行来自实例子网的 443 入站。 | **不一致**<br>（01 §9.8 把 ec2messages 写成硬依赖）<br>另含：文档未说明（并发会话数） | 01 §9.8（第 2242 行）、第 2670、2697、2711、2855 行和 06 规则表 ATL-NET-001 把 ec2messages 列为私有放置的硬依赖。按官方说明，Agent ≥3.3.40.0 已不需要它；D18 又要求 Agent ≥3.3.2746.0，凡满足 ENV_VAR 要求的实例都不会走 ec2messages。02 第 872 行“较旧版本的 Agent 还需要 ec2messages，平台模式默认三个都建”的说法与官方一致。见 3.12 节。<br>03 §3.2 第 2 步自定的会话上限与官方不冲突，但 StartSession 只有 3 TPS、DescribeSessions 只有 6 TPS，打开终端的对账逻辑要带退避重试。录制版 ATL-SessionShell-Logged 需要 logs 终端节点，01 §3.6 已经写了回退。03 §3.2 第 8 步的双栈主机名 `ssmmessages.<region>.api.aws` 与官方一致。 | 需要，**V2-7**，必须保留：私有子网只建 ssm、ssmmessages 接口终端节点和 S3 终端节点、不建 ec2messages，Agent ≥3.3.2746.0，确认 PingStatus=Online、Run Command 和浏览器终端都能用；在同一实例上逐个开会话，直到失败或开满 10 个；连续快速调用 StartSession，记录被限流时的错误名。 | https://docs.aws.amazon.com/general/latest/gr/ssm.html<br>https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html<br>https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-setting-up-messageAPIs.html |

---

## 3. 需要回写的改动

本节只给建议，没有修改任何设计文件。3.1～3.12 对应主判定为“不一致”或“官方说法矛盾”的各项；3.13 汇总其余各项可以补上的数值。行号以 2026-10-14 仓库中的文件为准。

### 3.1 D2 CloudTrail 事件历史（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 01 §3.1；02 §7.7（第 1617 行）、§7.12（第 1917 行）；03 第 1196 行 | 把“通常数分钟、不作保证”当作事件历史的官方描述 | 改为：“官方没有给出事件历史的可见延迟；trail 投递平均约 5 分钟且不保证，仅作参考。”复扫时间点（+20 分钟、+60 分钟、+6 小时）和定向扫描最长等 20 分钟，标注为“以 V1-9 实测的延迟分布为准”。 |
| 01 §3.1（全局服务） | Route 53 也被列为记录在 us-east-1 | 官方只点名了 CloudFront、IAM、STS，并提示部分全局服务事件可能记在 us-east-2 或 us-west-2。改为只列这三项，其余标“待 V1-9 确认”；定向扫描只查 us-east-1 可能漏掉事件，要写明这一点。 |
| 01 §3.1（查找属性） | “精确匹配” | 官方没有写，改为“匹配规则待实测（V1-9）”。 |
| 01 §3.1、§3.12（第 538 行）；02 第 1508 行 | 频率限制“以官方文档为准” | 填入“每账号每区域 2 次/秒，不可调整；每页最多 50 条”。atl-main 的令牌桶 `RATE#cloudtrail-lookup#<region>` 按 2 TPS 设置，按“会话名 × 区域”分页扫描时据此估算耗时。 |

### 3.2 D3 Step Functions（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 02 §4.6（第 874 行） | 托管规则 `StepFunctionsGetEventsForCodeBuildStartBuildRule` | 改为 `StepFunctionsGetEventForCodeBuildStartBuildRule`（Event 单数），与 01 §3.3 第 344 行、50-iam.yaml 第 224 行一致；“规则名以官方文档为准”可以删去。记入 07 第 13 节。 |
| 02 第 520、829、1420 行 | Catch 写死 `StepFunctions.ExecutionAlreadyExistsException` | 官方文档没有这个错误名（只在一个 aws-cdk 用户 issue 中出现）。标注“待 V1-12 确认”；确认之前，建议 Catch 在这个名字之外再兜底 `States.TaskFailed`，并在处理分支里按 Cause 判断，避免 Catch 永远不命中。`<<SfnRetry>>` 覆盖的限流错误名同样以 V1-12 为准。 |
| 02 §2.7（第 242 行） | “90 天内不能复用” | 改为“原执行结束后 90 天内不能复用”；补充“执行名最长 80 字符”，`reclaim-<envId>-<mode>-<n>`、`rescan-<envId>`、`end-<sid>-retry-<k>` 等在生成时校验长度。 |
| 02 §4.6（附注） | “被停止的 .sync 构建由 Step Functions 尽力停止（以官方文档为准）” | 改为“官方说明为尽力取消、不保证”，保留 StopActiveBuilds 的二次停止。补一句：同账号 .sync 会轮询，并发子执行较多时要留意 DescribeExecution 的配额。 |

### 3.3 D4 EventBridge Scheduler（官方说法矛盾）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| platform/infra/src/50-iam.yaml 第 896 行；01 中对应的权限描述 | 按调度名前缀授权 `schedule/atl-system/atl-share-*` | 官方示例与注释对“单个调度的资源级授权”说法矛盾。在 V1-11 定论之前，01 中注明“前缀授权待实测”；如果实测不支持，改为按组授权 `schedule/atl-system/*`，并用别的方式（例如命名规范加调用方代码约束）限制范围。 |
| 02 §5.2（延长与补建） | “先建新、后删旧”；补建 `-r<k>` 调度 | 补一条：新建调度的 at() 时间至少比当前时间晚 1 分钟，避开“时间已过”的未定义行为。 |
| 01 §3.5 / 02 §5.2（DELETE 与死信） | 默认 DELETE 后调度消失 | 补一句：“重试耗尽进入死信队列后调度是否仍存在，官方未说明；DisarmTimers 按名删除并把 ResourceNotFound 当成功，两种情况都兼容。” |

### 3.4 D6 STS（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 01 §6.4 ATLLearnerIam；各模块模板中 cloudalbum-* / CloudAlbum* 角色的信任策略 | 只有 ATLApiFunctionRole → ATLLearnerRole 一处允许 `sts:SetSourceIdentity`（01 第 891、1421 行） | 学员会话带着 SourceIdentity。官方说明角色链时调用方的权限策略和目标角色的信任策略都要有 `sts:SetSourceIdentity`，否则 AssumeRole 失败。建议：ATLLearnerIam 对学员可扮演的角色加上 `sts:SetSourceIdentity`；凡是学员或卡片步骤会扮演的模块角色，信任策略加上这个动作（可用 `aws:SourceIdentity` 条件限定）。先由 V1-5 第 ③ 项确认再落地，并回写 06。记入 07 第 13 节。 |
| 03 §3.2（第 338 行） | SourceIdentity 约束“以官方文档为准” | 官方 64 与 256 两说。写成：按不超过 64 字符、只含 `[A-Za-z0-9_+=,.@-]`、不以 aws: 开头校验。Cognito 的 sub（36 位 UUID）符合；用邮箱类用户名时要检查长度和字符。 |
| 01 §6.7 第 7 条（回收会话策略） | 会话策略的大小上限未写数值 | 写为：“内联 JSON 加托管策略 ARN 明文合计 2,048 字符，最多 10 个 ARN；另有会话令牌打包上限（官方未给数值），超限报 PackedPolicyTooLarge 时拆批重试。” |

### 3.5 D7 控制台联合登录（官方说法矛盾）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 01 §8.3（第 1933 行）与 03 §5（第 1086、1107 行） | 01 写控制台通道 AssumeRole 传 DurationSeconds=3600；03 写不传 | 以 03 现行方案（不传）为准，统一 01 §8.3。V1-5 / PoC ⑩ 如果证明可以带 DurationSeconds，再按 03 D8 恢复“截断到会话截止时间”的规则。 |
| 03 §5.3；03 §5.6 与 02 回收器的 CloudTrail 扫描窗口 | “控制台会话 = 凭证剩余时间”；扫描窗口 max(expiresAt) | 官方没有说明默认控制台会话在何时结束。标注“待 V1-5 确认”；如果实测为“从登录起满一个凭证时长”，扫描窗口改为“登录时间 + 凭证时长”。 |
| 03 §1.2 | 区域端点 | 补记：Sign-In 端点表列有 ap-northeast-1 的区域端点，us-east-1 用全局端点；区域端点失败时退回全局端点属于设计自定，官方未说明。 |

### 3.6 D12 Route 53（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| docs/platform/cards/scenario-cards.md 第 127 行 | 托管区域归为“按月折算的小额固定项” | 改为：“托管区域按月整笔计费，不折算；创建后 12 小时内删除免收。”权重 0 的结论可以不变。 |
| 05 第 457 行 | 托管区域归入“按容量单位小时计费的小额项（…按月折算…）” | 同上，把 Route 53 托管区域从“按时间折算”中拿出来单列。 |
| 04 §3.4 与 01/02 的报价接口；scenario-cards 第 314 行；sc-backup-dr 的保留提示 | 托管区域的估价方式 | 会话内创建并在 12 小时内删除的计 0；勾选“保留”的，创建当月收一整月，之后每月 1 日再收一整月。 |
| 卡片讲解中“Alias 查询免费” | 未限定 | 限定为“指向 AWS 资源时免费”；指向同一托管区域中非 Alias 记录时要收费。 |

### 3.7 D13 CloudFront（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| docs/modules/01-edge-network-scaling.md 第 646 行 | “CachingDisabled 下只能靠转发全部查看器头的源请求策略带上 Authorization” | 官方现行文档允许在源请求策略里单独列出 Authorization。改为三种做法并列，并注明 CachingDisabled 下不能用“放进缓存键”这一种。（只给建议，由 06 统一回写 modules。） |
| 01 §3.8（index.html、config.json） | 设 no-cache，挂 CachingOptimized | CachingOptimized 的最小 TTL 为 1 秒，边缘仍会缓存至少 1 秒。描述改为“边缘最多约 1 秒旧数据”；如果要求完全不缓存，改用最小 TTL 为 0 的自定义缓存策略。 |
| 01 §3.8 与 04 §11（费用说明） | 失效费用 | 写明免费额度每月 1,000 条、按账号合计；平台 atl-web 的失效（atl-certs 更新、分享撤销、SPA 发布）与学员在 svc-cdn 卡里做的失效共用这一额度；超出部分 $0.005/条（以定价页为准）。atl-certs 尽量用少量通配符路径并合并提交；批量撤销时，通配符失效按每秒 1 个串行提交。 |
| 04 §7.4（pending-crosscheck）；01 §7.3 | 复核间隔 | 官方没有给出 Requests 指标延迟，复核时机按 V4-5/V5-1 实测的 p50/p95 设定，不引用官方数字。 |

### 3.8 D14 ACM ACME（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| docs/modules/01-edge-network-scaling.md 第 1288 行（签发角色 `cloudalbum-<env>-acme-issuer`） | 未包含 `acm:AddTagsToCertificate`；域名条件的写法 | 端点设了 CertificateTags（Project=CloudAlbum），所以要加 `acm:AddTagsToCertificate`（可用 `acm:CertificateKeyPairOrigin=ACME` 与 `aws:TagKeys` 限定），或者去掉 CertificateTags。`acm:DomainNames` 只放在 RequestCertificate 语句里；RevokeCertificate 单独写一条，只用 `acm:CertificateKeyPairOrigin` 条件。 |
| 同文件第 1307 行与 tls 感知器 | 只加 `--certificate-key-pair-origins ACME` | 如果签发的是 ECDSA（EC_prime256v1）证书，还要在 Includes.keyTypes 中列出 EC_prime256v1；或者改用默认包含 ACME 证书的 SearchCertificates。 |
| 同文件第 1291 行（EAB 命令）；第 1252 行（disable 清理） | EAB 命令参数；清理顺序 | EAB 命令带上 `--acme-endpoint-arn` 和 `--role-arn`，部署者对签发角色要有 iam:PassRole。删除端点会连带删除 EAB、域验证和 ACME 账户，清理顺序可以简化；已签发的证书不会随之删除。 |

### 3.9 D17 成本与账单（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 02 §10.4（第 2144 行） | 成本分配标签“不追溯历史” | 改为：“默认只从激活时起生效；管理账号可以申请最多 12 个月的回填，每 24 小时一次（独立账号能否回填，官方未说明）。” |
| 平台动作 cost-activate-tags | 以 HTTP 200 判定成功 | 标签键首次出现前调用，会对该键返回 TagKeysNotFoundException，而请求整体不报错。逐键检查 Errors，提示学员 24 小时后重试；每批不超过 20 个键。 |
| 04 §9.3（ce:GetCostAndUsage） | 未处理“Cost Explorer 尚未启用” | 补充：API 无法启用 Cost Explorer；MonthlyBudgetAmount 大于 0 时创建 atl-platform-guard 会顺带启用，约 24 小时后才有数据。 |
| 03 §5.4 与安装前检查 | 账单访问开关；Budgets 入口 | 写明“Activate IAM Access”只能由根用户开启，Organizations 创建的成员账号默认已开启；入口说明改为“账单与成本管理控制台 → Budgets”，深链接片段以巡检结果为准。02 §10.4“Budgets 数据有延迟”可写为“每天最多更新三次，间隔通常 8～12 小时”。 |

### 3.10 D21 Lambda 预留并发为 0（官方说法矛盾）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| service-cards-2 第 906 行；labs/svc-image-processing/manual/60-throttle.md 第 24～25 行；labs/svc-image-processing/checks/image-processing.yaml 第 246 行；05 第 697 行 | 断言“不排队、直接丢弃并送往失败目标” | 官方两处说法不一。保留“以实测为准（V4-3）”的标注，措辞从断言改为“预期”。 |
| docs/modules/04-compute-async.md 第 574 行；docs/labs.md 第 580 行；scenario-cards 第 577、587、633 行；experiments/image-processing/experiment.json 第 116 行 | 旧表述：恢复后由异步队列重试，照片陆续变成 READY | 与上一行相反，仓库内部前后矛盾。V4-3 出结果后，按结果统一回写上述所有位置，包括 scenario-cards 第 633 行的题目解析。 |

### 3.11 D22 Tagging API（官方说法矛盾）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 01 §3.1 | “对部分类型（例如 Auto Scaling 组）覆盖不全” | 改为：“GetResources 不返回 IAM 用户与角色；对 Auto Scaling 组返回空（官方 Welcome 页的具体例外，与同页总述矛盾，以 V1-10 为准）。” |
| 01 §3.1 / 02 §7.1 | “刚删除的资源可能短时间内仍被列出” | 官方页面中没有依据，改为“以实测为准（V1-10）”。02 §7.1 第 4 条“删除前先用服务 API 确认资源存在”保留。 |

### 3.12 D23 Session Manager 终端节点（不一致）

| 位置 | 现在的写法（概述） | 建议的修改 |
|---|---|---|
| 01 §9.8（第 2242 行）；01 第 2670、2697、2711、2855 行；06 规则表 ATL-NET-001；modules/01 network 模块 `InterfaceEndpoints` | private 放置时，`ssm`、`ssmmessages`、`ec2messages` 三个接口终端节点都是硬依赖 | 官方说明 Agent ≥3.3.40.0 已不需要 ec2messages，平台又要求 Agent ≥3.3.2746.0。建议：硬依赖改为“NAT，或 `ssm`、`ssmmessages` 接口终端节点加 S3 终端节点”；ec2messages 保留为可选项（只为旧 Agent）。等 V2-7 实测通过后，再回写 01 §9.8、06 规则表和 modules/01。这样每个可用区可以少建一个按小时计费的接口终端节点。记入 07 第 13 节。 |
| 03 §3.2 第 2 步（打开终端的对账） | 自定会话上限 | 与官方不冲突。补充：StartSession 默认 3 TPS、DescribeSessions 6 TPS，对账逻辑和学员连续打开多个标签页的情况都要带退避重试。 |

### 3.13 其余各项可以补上的数值（一致或文档未说明）

| 编号 | 位置 | 建议补充 |
|---|---|---|
| D1 | 02 §10.5 | Reason 连同整个响应体不超过 4096 字节；超时后不用旧 ResponseURL 回调。 |
| D5 | 01 §6.4（第 939 行）；02 §6.3（第 1203 行）；01 §6.10 CI | 角色内联策略合计 10,240 字符（不计空白），按三条内联策略合计检查；02 §6.3 第 3 步“传播余量 2 分钟”注明为设计自定值，以 V1-2 为准。 |
| D8 | 01 §4.3；01 §11；02 §7.5 S5 | KeyPendingWindowDays 加 AllowedValues 7～30；实际删除可能晚最多 24 小时；计划删除期间不收月费，等待期内取消会补收；KMSInvalidStateException（pending deletion）视为完成。 |
| D9 | 02 §7.5 S2 | “立即删除”改为“立即不可访问，后台异步删除”；同名重建要退避重试；secrets 模块名称带 envName。 |
| D10 | service-cards-2 第 1051 行；scripts/module 与 queue 模块；02 回收器 | 同名重建至少等 60 秒，期间返回 QueueDeletedRecently；删除完成以 60 秒后 GetQueueUrl 返回 QueueDoesNotExist 为准。 |
| D11 | 02 §8.2；05 §10.4；svc-db-proxy、sc-db-performance | 停止可能长达约 1 小时，停止中不能修改，存储、备份与公网 IPv4 照常计费；Proxy 是否支持 T 系列改为“官方未限制也未明列，待实测”；代理只能挂写实例、子网覆盖两个 AZ。 |
| D15 | 03 §6.2；05 §10.4；06 PM-21 | 160 小时；certbot ≥5.4，webroot 加 shortlived 加 deploy-hook；按现有实现只能走 HTTP-01，前提是 80 端口对公网开放；签发限额数值。 |
| D16 | 01 §3.10；01 第 2312 行 | 账号级外部访问分析器每区域只能有 1 个且不可调，Preflight 遇到已有分析器时自动改用 existing；外部访问分析免费，自定义策略检查按次计费。 |
| D18 | 01 §3.6；03 §1.2、§4.11；04 §6.1（第 2182 行） | Agent ≥3.3.2746.0；stdout 24,000 字符、stderr 8,000 字符；ArgsB64 的 allowedPattern 改为 `'^[A-Za-z0-9_-]+$'` 加 maxChars: 6000（推断风险，以 V2-5 为准）。 |
| D19 | 03 §4.9 | 每区域 1 GB；20～30 分钟无交互断开；约 12 小时强制结束；120 天不用则删除；单条命令不超过 65412 字符；CPU 架构与主目录隔离待实测。 |
| D20 | 03 §1.2、§6.3 | Safari 26.2 起（macOS 与 iOS）重新支持分区 Cookie，18.5～26.1 不可用；降级提示保留。 |

---

## 4. 对 07 后续实测项的影响

### 4.1 可以省略或缩小范围的实测

| 实测 | 影响 | 说明 |
|---|---|---|
| V1-13 | 缩小 | ServiceTimeout 的取值范围和默认值已由官方确认，只测超时后的行为（D1）。 |
| V1-2 | 缩小 | 内联策略、托管策略的字符上限已由官方确认（10,240 / 6,144，不计空白），第 7 步直接按 10,240 比较；只保留吊销生效时间、超限错误名和权限边界计数（D5）。 |
| V4-4 | 降级为印证 | 同名重建等待 60 秒已由官方明确（D10），只观察经 CloudFormation 删栈、重建时的表现，可以与其他 V4 项合并。 |
| D8、D12 | 不需要 | 07 中本来就是“—”。KMS 和 Route 53 的计费规则官方已写明，账单旁证可选。 |
| D11 第一问 | 不需要 | “停止 7 天后自动启动”官方已写明。 |
| D13 失效计费 | 不需要 | V4-5/V5-1 中不必测失效计费，只测 Authorization 转发、最小 TTL 和指标延迟。 |
| V5-1（D16 部分） | 缩小 | 数量上限和计费已确认，只测重复创建时的错误名。 |

### 4.2 必须保留的实测

| 实测 | 对应 | 必须保留的原因 |
|---|---|---|
| V1-5 | D6、D7 | 角色链与 DurationSeconds 的官方说法矛盾；SourceIdentity 64 与 256 两说；角色链传递 SourceIdentity 时的权限要求（新增风险）；控制台会话何时结束（文档未说明）。 |
| V1-9 | D2 | 事件历史的可见延迟官方没有数值；限流错误名、匹配规则、全局服务事件所在区域都要实测。 |
| V1-10 | D22 | Tagging API 官方说法矛盾；删除后的残留时间未说明。 |
| V1-11 | D4 | at() 时间已过、DELETE 与死信的关系未说明；按调度名前缀授权官方说法矛盾。 |
| V1-12 | D3 | 优化集成下的错误名官方未说明，而 02 的 Catch 依赖它。 |
| V1-14 | D9 | 同名重建的等待时长、窗口内强制删除未说明。 |
| V2-5 | D18 | Agent 侧正则 `{2,6000}` 的推断风险；Run Command 参数总大小未说明。 |
| V2-7 | D23 | 去掉 ec2messages 的方案要实测确认；并发会话数未说明。 |
| V3-4 | D15、D20 | certbot 的实际续期行为；各浏览器当前版本的 CHIPS 行为。 |
| V3-5 | D14 | 2026-09-28 新增的授权规则对签发与吊销的实际影响；ECDSA 证书的列出方式。 |
| V4-3 | D21 | 官方说法矛盾，卡片与检查的判定依赖实测结论。 |
| V4-5、V5-1 | D13 | Authorization 经 AllViewerExceptHostHeader 转发是推断；Requests 指标延迟没有官方数值。 |
| V5-3 | D20 | Safari（含 iOS）当前版本的 iframe 登录保持。 |

### 4.3 建议新增的实测（07 当前没有安排）

| 新增项 | 建议并入 | 内容 |
|---|---|---|
| RDS Proxy 与 T 系列实例 | V4（svc-db-proxy 冒烟）或单独的最小测试 | 用 db.t4g.micro（可再加 db.t3.micro）建代理并注册目标，确认 TargetHealth 为 AVAILABLE（D11）。 |
| CloudShell 架构与主目录隔离 | V1-5 | `uname -m`；两个不同会话名之间 $HOME 是否共享（D19）。 |
| 角色链传递 SourceIdentity | V1-5 | 带 SourceIdentity 的学员会话扮演信任策略里没有 `sts:SetSourceIdentity` 的 cloudalbum-* 角色，是否失败（D6）。 |
| 账号形态与账单开关 | V0-3 | 独立账号还是成员账号；“Activate IAM Access”开关状态；Cost Explorer 是否已启用；UpdateCostAllocationTagsStatus 对未出现的键的返回（D17）。 |

### 4.4 与使用根用户执行实测有关的官方说明

- 本次核对的 23 项中，官方明确写明**只能由 AWS 账户根用户完成**的只有 D17 的“Activate IAM Access”开关（每个账号开启一次即可；Organizations 创建的成员账号默认已开启）。
- D18 中“Session Manager 不支持用 root 认证会话”指的是**节点上操作系统的 root 用户**，与 AWS 账户根用户无关（抽查时已更正，见第 5 节）。
- 其余各项的官方说明都没有提到根用户。根用户能否用于某项实测，本次核对没有涉及，不在此下结论。

---

## 5. 抽查记录（2026-10-14）

写完后重新打开下列官方页面，核对表中结论是否与来源对应：

| 编号 | 重新打开的页面 | 核对结果 |
|---|---|---|
| D1 | aws-resource-cloudformation-customresource.html | 一致：1～3600 秒，默认 3600，类型 String，无中断更新。 |
| D3 | step-functions/latest/dg/connect-codebuild.html | 一致：两个 CodeBuild 托管规则名都是 `StepFunctionsGetEvent…`（单数）。 |
| D5、D6 | IAM reference_iam-quotas.html | 一致：角色内联策略合计 10,240、托管策略 6,144，均不计空白；每角色托管策略默认 20、自动批准上限 25；会话策略 2,048 字符、最多 10 个 ARN、另有打包上限。 |
| D6 | STS API_AssumeRole.html；IAM id_credentials_temp_control-access_monitor.html | 一致：API 参考写 SourceIdentity 2～64，用户指南写 2～256；角色链时调用方权限策略与目标信任策略都要有 sts:SetSourceIdentity。DurationSeconds 900～43200，默认 3600，角色链超过 1 小时失败。 |
| D10 | SQS API_DeleteQueue.html | 一致：删除最长 60 秒；同名重建至少等 60 秒。 |
| D13 | CloudFront add-origin-custom-headers.html（转发 Authorization 一节） | 一致：三种做法中包括“在源请求策略里单独列出 Authorization”，所以 modules/01 第 646 行的冲突成立。 |
| D21 | lambda monitoring-metrics-types.html | 一致：AsyncEventsDropped 的丢弃原因中列有预留并发为 0。 |
| D23 | systems-manager setup-create-vpc.html；systems-manager-setting-up-messageAPIs.html | 一致：Agent 3.3.40.0 起优先使用 ssmmessages；2024 年前上线的区域可以移除 ec2messages 权限；2024 年及以后上线的区域只支持 ssmmessages。页面列出的是 `com.amazonaws.<region>.s3` 终端节点，没有限定网关型或接口型，表中已据此写成“S3 终端节点”。 |
| D18 | systems-manager session-preferences-run-as.html | **已更正**：原始结论写“Session Manager 不支持用 root 账户认证会话”，页面实际指操作系统的 root 用户。表中已改为“操作系统的 root 用户（不是 AWS 账户根用户）”。RunAs 页的两步判定顺序（IAM 实体标签 → 偏好设置）与表中描述一致。 |

除 D18 的措辞外，抽查没有发现结论与来源不符的地方。
