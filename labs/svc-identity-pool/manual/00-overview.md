---
section: overview
---

## 背景

CloudAlbum 的 F14 是“多文件、可续传、按前缀授权的直传”。起始状态（identity-pool 的 none 驱动）由 EC2 自己签发一个
**前缀范围上传令牌**：浏览器持有一个令牌，可以在 `raw/<userId>/` 下连续上传多个文件、分片续传，但每一片都要先问一次 EC2——
本卡的起始状态里 storage 已经是 S3，所以每一片先 `POST /api/uploads/parts:sign` 换一个预签名 `UploadPart` URL，授权逻辑写在应用代码里。

启用 Identity Pool 之后，已登录用户用 User Pool 的 ID 令牌换取一组 STS 临时凭证（Access Key 以 `ASIA` 开头），
这组凭证只能写模块自带暂存桶的 `private/<identityId>/`。浏览器自己签名，直接把分片传到 S3；`complete` 时后端校验大小、类型与
文件头（魔数），再用服务端 `CopyObject` 把对象导入原图位置——之后的缩略图、打标签流程与其他上传方式完全相同。

:::why
User Pool 回答“你是谁”（签发 JWT）；Identity Pool 回答“你能用 AWS 做什么”：它把 User Pool 的令牌换成一个 IAM 角色的临时凭证
（Web 身份联合，背后是 `sts:AssumeRoleWithWebIdentity`）。同一个角色给所有用户，却能把每个人限制在自己的前缀里，
靠的是 IAM 策略变量 `${cognito-identity.amazonaws.com:sub}`——它的值是 Identity ID（形如 `ap-northeast-1:uuid`），不是 User Pool 的 sub。
:::

## 对比实验预告

### 批量上传（identity-pool/upload-bench，必做）

- **没有 Identity Pool**：每个文件 = 建档 + **每个分片一次** `parts:sign` + complete，对后端的请求数随分片数线性增长。
- **有了 Identity Pool**：换一次凭证后，每个文件只有建档与 complete 两个后端请求；分片请求全部直达 S3。
- **你会在哪里看到**：报告的 `backendRequestsPerFile`；浏览器 DevTools 里 sts 模式的请求直达
  `cloudalbum-<env>-upload-staging-<账号>.s3.ap-northeast-1.amazonaws.com`，请求头带 `x-amz-security-token`，Authorization 的 Credential 以 `ASIA` 开头。

### 越权测试（identity-pool/cross-prefix，必做）

用户 A 写 B 的前缀、列出整个桶、删除 B 的对象：两种方式都拒绝，但**拒绝的人不同**——before 由应用返回 403 `UPLOAD_PREFIX_DENIED`，
after 由 S3 返回 `AccessDenied`，应用代码完全不参与。

### 断点续传（identity-pool/resume，必做）

上传中途断开再恢复：S3 的 `ListParts` 告诉浏览器已经收到哪些分片，只补传缺失的。

## 开始前

- 起始状态已经包含 storage（S3）、auth（Cognito）与两个已确认、密码已知的测试用户（种子 `cognito-test-users`）。
  对比实验从工作台读取它们（环境变量 `CLOUDALBUM_TEST_USERS_PARAM` 指向的 SecureString），密码只在本地进程内存中使用。
- 预期警告：`DEP-013`（auth=cognito 与 L0 的本地 outbox 同时出现）、`DEP-030`（APP_BASE_URL 是 http 时，临时凭证经明文下发；
  平台预览方案 B 让浏览器走 `https://<EIP>`）。黄色状态是设计使然，检查按预期警告判定。

## 平台模式说明

`scripts/module` 与对比实验在工作台终端以学员身份运行；Uploader 角色带工作负载权限边界（ATLWorkloadBoundary）。
暂存桶的 CORS 除了 `http://<EIP>`，还允许预览使用的 `https://<EIP>`。
