# 本地 worker

参考实现的可控执行入口在 `next/apps/worker/src/cli.ts`。构建后在参考实现目录使用 `pnpm worker`。完整开发与安装步骤见参考实现的 `next/README.md`。使用临时 Markdown 验证。

1. 用 `open` 明确打开测试 Markdown。若已通过面板导入同一原文，可用 `--document` 指向该文档。
2. 提交批注后，用 `claim` 领取，再用 `to` 同步已保存的人类输入。
3. 在命令返回的原路径串行编辑。用 `from` 捕获差异，用 `complete` 核对并结束原执行。

| 现场 | 恢复方式 |
| --- | --- |
| 请求结果未知 | 用 `retry-request` 发送原 ID 和原参数。 |
| 文件计划尚未结算 | 用 `resume` 核对同一计划。文件已是目标时补原回执。 |
| 实际文件偏离 before 和目标 | 保留观测内容并停下。确认原 writer 已停后，可明确选择 `recover-align --writer-stopped`。 |
| 执行失联 | 用 `fail-unknown` 保留现场和执行槽位。 |
| 原 writer 已停且文件可核对 | 用 `fail --writer-stopped` 明确结束。用户重试时创建新尝试并排到队尾。 |

`--writer-stopped` 是操作者对现场的确认。协议串行约束覆盖遵守协议的执行者。判断候选是否登记、执行能否结束和同步是否结算由[服务](../service/README.md)负责。故障复现见 [A06](../../tests/README.md#a06)、[A09](../../tests/README.md#a09)和 [A10](../../tests/README.md#a10)。
