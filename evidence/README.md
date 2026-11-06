# 参考实现验收记录

下表是从旧工作树迁移的历史记录。源码及证据路径相对[参考实现索引](../docs/archive/README.md)中的旧仓库根目录。场景的预期结果见[验收场景](../tests/README.md)。

| 构建与入口 | 场景 | 记录结果 | 原始记录 |
| --- | --- | --- | --- |
| P1 浏览器与本地服务 | [A04](../tests/README.md#a04)、[A11](../tests/README.md#a11) | 浏览器导入、编辑、确认 V2、只读预览、恢复 V3，以及服务重启后继续草稿并生成 V4。 | `docs/90-research/P1-Human-Document-Loop.md` |
| P2 浏览器、构建后的可控 CLI | [A06](../tests/README.md#a06)、[A07](../tests/README.md#a07)、[A09](../tests/README.md#a09) | 原路径编辑与捕获，重启后核对原执行，同区冲突保留双方内容。 | `docs/90-research/P2-Queue-and-File-Sync.md` |
| 0.1.2 真实 Codex 宿主 | [A01](../tests/README.md#a01)、[A03](../tests/README.md#a03)、[A09](../tests/README.md#a09) | 当前对话排队与原生修改。用户接受两项、拒绝一项，明确确认 V2，再完成文件对齐。记录另含重开、重启和另一对话领取被拒。 | `docs/90-research/P4-Codex-Plugin-Integration.md` |
| 0.1.4 SQLite、受控独立包和真实 App 重载 | [A09](../tests/README.md#a09)、[A10](../tests/README.md#a10)、[A12](../tests/README.md#a12) | 受控场景验证引用保留、收缩与恢复。实际 App 重启单独核对加载和现有现场。 | `docs/90-research/P5-Maintenance-and-Acceptance.md`、`docs/90-research/evidence/p5-acceptance-20261014.json` |
| 0.2.1 浏览器与受控候选 | [A01](../tests/README.md#a01)、[A04](../tests/README.md#a04)、[A11](../tests/README.md#a11) | 验证通篇和逐条审阅、V1 到 V2、段落保存和取消、草稿重开、历史只读。 | `next/docs/Frontend-Legacy-Interaction.md`、`next/evidence/ui/editorial-acceptance.json` |
| 0.2.1 真实 Codex 宿主，2026-10-15 | [A01](../tests/README.md#a01)的候选登记前半段、[A03](../tests/README.md#a03)的当前对话排队 | 重载后完成自然唤醒、领取、编辑和捕获。一次执行产生 31 个待审差异。现场停在审阅阶段，工作正文和正式 V1 维持原值。 | `next/evidence/ui/native-reload-20261015.json`、`next/docs/Frontend-Legacy-Interaction.md` |

同一版本的浏览器记录和真机记录可以证明不同步骤。当前文档迁移的验证是文档结构、引用和历史记录核对，运行验收结果仍归各自的参考构建。
