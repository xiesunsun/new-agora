# Codex 桌面接入

参考实现 `next/plugins/desktop/` 负责当前对话的面板与 MCP 接入。业务状态写入[本地服务](../../apps/service/README.md)，面板使用同一套[界面逻辑](../../apps/panel/README.md)。

| 文件 | 职责 |
| --- | --- |
| `src/server.ts`、`src/panel.ts` | MCP 工具、面板和公开回调 |
| `src/adapter.ts`、`src/gateway.ts` | 归属检查、服务访问与执行请求 |
| `src/runtime.ts` | 匹配服务、独立包启动与运行环境 |

面板发送自然唤醒后，以实际领取判断任务是否开始。发送前校验当前对话；公开 active 消息接口在切换对话时存在校验与发送之间的竞态。执行入口还会核对绑定与执行上下文。缺失或外来上下文的调用被拒绝。宿主标识的用途是本地接入归属校验。

安装验证使用参考实现 `next/README.md` 的桌面插件步骤。先确认插件构建、当前对话、临时绑定文件和隔离运行目录，再走 [A01](../../tests/README.md#a01)、[A03](../../tests/README.md#a03)和 [A09](../../tests/README.md#a09)。受控 MCP 和实际宿主分开记录。已知构建结果见[历史证据](../../evidence/README.md)。
