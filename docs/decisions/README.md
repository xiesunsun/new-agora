# 开发决策

这里保存会影响后续改动的取舍。流程页定义用户可见行为，模块文档维护实现细节。

## 复用当前 Codex 对话

用户从正在写作的对话进入面板，原生文件工具继续在这个对话中工作。宿主唤醒只是提醒，持久任务、领取和归属由 Agora 自己管理。这减少了为同一篇文稿启动另一个子对话的成本，也保留了现有上下文。代价是宿主 active 发送和界面切换之间存在竞态，执行侧仍需核对绑定。

行为与限制见[宿主接入](../../plugins/desktop/README.md)。历史来源为 `docs/90-research/Scenario-Shared-Core-and-MVP.md` 和 `P4-Codex-Plugin-Integration.md`。

## 分开接受、确认与文件对齐

接受是用户对修改的决定，确认保存正式快照，对齐处理实际文件。文件可以被外部编辑，也可能在写入后丢失回执。分开的边界让用户决定与正式历史可以保存，同时保留待核对的文件现场。恢复时按原文件计划核对实际内容。

用户承诺见[集中审阅](../flows/review.md)。历史来源为 `docs/90-research/P3-Concentrated-Review.md` 和 `File-Sync-and-Edit-Progression.md`。

## 用文档快照保存版本

每个正式版本保存不可变正文与来源。历史恢复形成一次新的用户操作，便于追踪，也保留恢复前后的版本。原路径绑定可以服务于本地协作，正式历史由 Agora 的文档存储提供。

行为见[历史与恢复](../flows/history-and-restore.md)。历史来源为 `docs/90-research/Scenario2-Entity-Contracts.md` 和 `P1-Human-Document-Loop.md`。历史来源目录以[参考实现索引](../archive/README.md)为准。
