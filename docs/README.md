# Agora 文档

这是新仓库的文档基线。产品行为和模块边界来自旧仓库的独立 `next/` 实现。[产品范围](product.md)说明 Agora 提供什么，[架构](architecture.md)说明各模块负责什么。

| 要处理的问题 | 从这里开始 |
| --- | --- |
| 导入、保存段落、草稿重开 | [编辑与保存](flows/edit-and-save.md) |
| 批注排队、重复领取、原文件冲突 | [批注与同步](flows/annotate-and-sync.md) |
| 润笔、接受失败、确认后仍待对齐 | [集中审阅](flows/review.md) |
| 历史预览、恢复旧版本 | [历史与恢复](flows/history-and-restore.md) |
| 复现故障或判断是否通过 | [验收场景和执行方式](../tests/README.md) |
| 核对某个宿主构建实际测了什么 | [既有验证记录](../evidence/README.md) |

产品规则由流程页维护。模块文档和测试入口见[架构](architecture.md)。查阅取舍用[决策记录](decisions/README.md)，定位旧文档和原始代码用[参考实现索引](archive/README.md)。

改动模块规则时，在同一次变更中更新所属说明和受影响的验收断言。改动用户可观察的跨模块行为时，也更新对应流程。设计提案和历史记录应标注状态与来源，现行流程只引用已采纳的规则。
