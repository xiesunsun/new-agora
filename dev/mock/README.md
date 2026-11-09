# 调整 mock 场景

运行 `pnpm mock` 打开墨间书店示例。它创建临时 Markdown、数据库与运行目录，使用真实面板和服务。脚本执行器代替 Codex 修改候选文件。服务照常计算审阅、核对原文件并保存版本。

## 使用自己的场景

复制 [bookstore.json](bookstore.json)，修改配置后从仓库根目录运行。

```sh
pnpm mock --config /absolute/path/scenario.json
```

启动输出包含访问地址、文稿副本、运行目录、配置路径与 SHA-256。每次启动创建独立副本。原始场景文件不被写回。要继续同一运行目录，使用下方真实服务入口，按需要连接执行器。

| 字段 | 用途 |
| --- | --- |
| manuscript | 初始 Markdown 路径，相对于配置文件目录 |
| comments | 初始批注的 quote 与 instruction，quote 必须在文稿中唯一 |
| worker.threadId | 模拟执行器绑定的对话身份 |
| worker.pollMs | 轮询间隔，单位毫秒 |
| worker.editMs | 领取后等待时间，单位毫秒 |
| worker.rules | 精确 quote、可选 instruction 和 replacement，只替换本轮对应批注 |
| worker.results | 按执行顺序返回结果，耗尽后复用最后一项 |

results 的 kind 可为 rules、candidate、failed 或 cancelled。candidate 需要完整 body。failed 和 cancelled 通过正式执行结束接口报告，不把失败伪装成空建议。配置错误会阻止启动。

## 使用真实服务

```sh
pnpm build
pnpm start --file /absolute/path/manuscript-copy.md --runtime /absolute/path/runtime
```

明确指定文稿和运行目录后，不启动脚本执行器。不能同时指定 mock 配置。桌面接入见[插件说明](../../plugins/desktop/README.md)。

[开发检查](../../docs/development.md) · [边界决策](../../docs/decisions/ink-integration.md) · [mock 验收](../../tests/README.md#a14)
