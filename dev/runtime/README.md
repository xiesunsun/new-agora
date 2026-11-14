# 开发运行目录

公开入口是 `src/index.mjs`。Node.js 调用方可以导入 `stateRoot()` 和 `createManagedRun(kind)`。`kind` 只接受 `mock` 或 `test`。

`stateRoot()` 优先返回绝对路径 `AGORA_STATE_DIR`，其次使用 `XDG_STATE_HOME/agora`，默认使用 `~/.local/state/agora`。相对路径配置会报错。

`createManagedRun(kind)` 返回 Promise，结果包含 `root`、`release()` 和 `retain(reason)`。运行目录位于 `stateRoot()/runs/<kind>-<唯一后缀>`。`release()` 只删除当前句柄拥有的目录，可以重复调用。`retain(reason)` 要求非空原因，保留目录供排查，并允许随后调用 `release()`。

每个运行目录的 `owner.json` 记录版本 `1`、运行类型、创建进程 PID、创建时间和 `active` 或 `retained` 状态。保留状态还记录原因。设置 `AGORA_TASK_ID` 时，标记同时记录任务身份。

`pnpm clean:dev` 列出运行目录、状态以及拥有者 PID 是否存活。`pnpm clean:dev --remove <完整目录名>` 只删除已退出进程拥有的、标记有效的运行目录。命令拒绝路径、通配符、符号链接目录和符号链接标记。它不会按目录年龄自动删除。

[Mock 场景](../mock/README.md) · [开发与审阅](../../docs/development.md)
