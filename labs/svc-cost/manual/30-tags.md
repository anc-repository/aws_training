---
step: tags
---

项目预算按成本分配标签 `Project=CloudAlbum` 筛选费用。所有模块栈都带着栈级标签 `Project`、`Module`，但用户定义的标签必须先在
Billing 中**激活**为成本分配标签，才会出现在成本数据的分组里。

```bash {runsOn=workstation}
aws ce list-cost-allocation-tags --tag-keys Project Module --region us-east-1
```

没有激活（或列表里找不到）时，执行平台动作（当场不会生效）：

::platform-action{id=cost-activate-tags}

:::expected
`Project` 的 `Status` 为 `Active`。如果还没有生效，也可以继续：项目预算会一直显示 0——这本身就是观察点。
:::

:::why
新的标签键要过一段时间才出现在可激活列表里，激活后还要一段时间才生效，而且不追溯激活之前的费用（时长以官方文档为准）；
在 AWS Organizations 中只有管理账号能激活。所以这一步最好在实验前一天做。
:::

:::tip
Cost Explorer 的 API 可能按请求计费，平台的检查结果会缓存 30 分钟；不要在终端里反复执行上面的命令。
:::

::checks
