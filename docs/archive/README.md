# 参考实现与旧文档索引

参考来源是本机 `/Users/ssunxie/code/agora/Agora` 的 `refactor/service-boundaries` 工作树。旧版已提交基线为 `8bd9fdc43c1f28ed130510e49f869255d413dcac`。本次迁移同时读取该工作树中的独立 `next/`、研究笔记与验收记录，其中部分内容当时尚未提交。仅检出该提交只能得到旧基线。下表路径相对旧仓库根目录。

| 源材料 | 新入口或保留用途 |
| --- | --- |
| `next/AGENTS.md`、`next/README.md`、`docs/90-research/Service-Boundaries-Refactor.md` | [架构与状态归属](../architecture.md)和模块说明。参考实现启动、构建与打包命令留在 `next/README.md`。 |
| `docs/90-research/Scenario-Shared-Core-and-MVP.md`、`Scenario2-Entity-Contracts.md`、`Layered-Implementation-Design.md` | [产品范围](../product.md)、[服务](../../apps/service/README.md)和[决策](../decisions/README.md)。早期实体与接口提案供推导溯源。 |
| `docs/90-research/P1-Human-Document-Loop.md`、`next/docs/Frontend-Legacy-Interaction.md` | [编辑与保存](../flows/edit-and-save.md)、[历史与恢复](../flows/history-and-restore.md)和[面板](../../apps/panel/README.md)。 |
| `docs/90-research/P2-Queue-and-File-Sync.md`、`SQLite-Jobs-Idempotency-and-Recovery.md`、`File-Sync-and-Edit-Progression.md`、`DocumentAction-and-Markdown-Sync-MVP.md` | [批注与同步](../flows/annotate-and-sync.md)、[worker](../../apps/worker/README.md)、[服务](../../apps/service/README.md)和[文本算法](../../packages/text/README.md)。 |
| `docs/90-research/P3-Concentrated-Review.md`、`Backend-Use-Cases-and-State.md`、`Frontend-and-Communication-Design.md` | [集中审阅](../flows/review.md)、[运行时契约](../../packages/contracts/README.md)、[面板](../../apps/panel/README.md)和[服务](../../apps/service/README.md)。 |
| `docs/90-research/P4-Codex-Plugin-Integration.md`、`P5-Maintenance-and-Acceptance.md`、`Content-Retention-and-Cache-Management.md`、`End-to-End-Acceptance.md` | [宿主接入](../../plugins/desktop/README.md)、[服务维护](../../apps/service/README.md)、[场景与验收](../../tests/README.md)及[历史证据](../../evidence/README.md)。 |
| `docs/90-research/P0-Integration-Probe-Results.md`、`ChatGPT-Desktop-Integration-Validation.md`、`next/plugins/codex/` | P0 和早期插件探针。正式桌面适配器在 `next/plugins/desktop/`。 |
| `docs/Architecture-Guide.md`、`Developer-Guide.md`、`Developer-Iteration-Guide.md`、`docs/01-product/` 至 `docs/05-agent/` | 旧 Session、SSE、CLI、专用子 Agent 和旧设计。已采纳的交互见 `next/docs/Frontend-Legacy-Interaction.md`。 |
| `docs/99-internal/`、`docs/superpowers/`、`docs/90-research/Independent-Rebuild-Implementation-Plan.md`、`next/docs/trials/` | 历史实施计划、过程记录和试用副本。 |

在同一行省略目录的文件与该行第一个文件同目录。新仓库保存现行摘要和溯源索引。原始记录继续保存在旧工作树。参考源码路径和历史验收结果应按上述来源解释。
