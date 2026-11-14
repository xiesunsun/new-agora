# 验收记录

## 开发流程

[任务收尾与资源验收](development-lifecycle/README.md)记录受管运行、源码边界与 hook 的验证范围。原型接入的历史产物见[接入索引](ink-integration/README.md)。原始日志与截图保存在受管归档或 CI artifacts。

## 早期实现

| 构建与入口 | 验收结果 |
| --- | --- |
| 2026-11-06，`pnpm dev` 浏览器与脚本执行器，`panel.js` 摘要 `ac0ec3076431` | A01 跑通。应用前原文件等于 V1。重开后保留与舍弃仍生效。模拟写回受阻后，重新打开面板并核对原操作，预览、写回正文和 V2 一致。历史显示人工标题和初稿时间两处变化，重复应用仍为 V2。 |
| `agora-a01` 0.1.0 MCP stdio 与真实服务，`server.mjs` 摘要 `7e545d6e48b5` | 合成宿主对话标识驱动完整 A01。无标识和其他对话的领取被拒。实际 Codex 桌面安装、渲染和自动唤醒待验收。 |

## 参考实现

下表是从旧工作树迁移的历史记录。源码及证据路径相对[参考实现索引](../docs/archive/README.md)中的旧仓库根目录。表内编号沿用旧版验收场景。现行[验收场景](../tests/README.md)采用待审稿和一次应用流程，需要单独验证。

| 构建与入口 | 旧场景 | 记录结果 | 原始记录 |
| --- | --- | --- | --- |
| P1 浏览器与本地服务 | A04、A11 | 浏览器导入、编辑、确认 V2、只读预览、恢复 V3，以及服务重启后继续草稿并生成 V4。 | `docs/90-research/P1-Human-Document-Loop.md` |
| P2 浏览器、构建后的可控 CLI | A06、A07、A09 | 原路径编辑与捕获，重启后核对原执行，同区冲突保留双方内容。 | `docs/90-research/P2-Queue-and-File-Sync.md` |
| 0.1.2 真实 Codex 宿主 | A01、A03、A09 | 当前对话排队与原生修改。用户接受两项、拒绝一项，明确确认 V2，再完成文件对齐。记录另含重开、重启和另一对话领取被拒。 | `docs/90-research/P4-Codex-Plugin-Integration.md` |
| 0.1.4 SQLite、受控独立包和真实 App 重载 | A09、A10、A12 | 受控场景验证引用保留、收缩与恢复。实际 App 重启单独核对加载和现有现场。 | `docs/90-research/P5-Maintenance-and-Acceptance.md`、`docs/90-research/evidence/p5-acceptance-20261014.json` |
| 0.2.1 浏览器与受控候选 | A01、A04、A11 | 验证通篇和逐条审阅、V1 到 V2、段落保存和取消、草稿重开、历史只读。 | `next/docs/Frontend-Legacy-Interaction.md`、`next/evidence/ui/editorial-acceptance.json` |
| 0.2.1 真实 Codex 宿主，2026-10-15 | A01的候选登记前半段、A03的当前对话排队 | 重载后完成自然唤醒、领取、编辑和捕获。一次执行产生 31 个待审差异。现场停在审阅阶段，工作正文和正式 V1 维持原值。 | `next/evidence/ui/native-reload-20261015.json`、`next/docs/Frontend-Legacy-Interaction.md` |

同一版本的浏览器记录和真机记录可以证明不同步骤。当前文档迁移的验证是文档结构、引用和历史记录核对，运行验收结果仍归各自的参考构建。
