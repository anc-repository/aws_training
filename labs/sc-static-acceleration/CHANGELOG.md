# sc-static-acceleration 变更说明

## 1.0.0

- 静态资源全球加速：第一版内容（04 v2）。tls、dns 模块尚未实现，本版只保留 cdn（S3 媒体源站 + OAC）；自定义域名与 ACM 证书在模块实现后补回（主版本 +1）。cdn 的公共检查引用 svc-cdn 的同名检查：svc-cdn 主版本变化时本卡必须同步提升版本。
