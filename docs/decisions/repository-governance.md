# 仓库约束的归属与执行

## 问题

Ink 接入后，主目录、应用托管 worktree 和旧分支并存。此前开工规则要求保存基线，却没有规定默认执行目录、分支用途、worktree 回收或源码目录名。目录存在不代表它是独立项目，局部验收名也不能解释分支交付什么。

## 选择

根 AGENTS 保留短规则，指向[仓库约束](../repository-workflow.md)。[文档归属规则](../AGENTS.md)说明每类事实的唯一位置。当前职责放在架构和模块 README，机器现场放在有日期的证据中。

普通任务沿用用户指定的主目录。分支描述一个可审阅结果，worktree 对应有负责人和回收条件的隔离任务。新规则向前执行，已有分支与目录经过核对后再迁移。

## DeepSeek Harness 的依据

学习入口为 Codex 聊天 `01a1491a-8929-7430-8cc4-dadb42cd37ad`，标题为「检查项目是否为最新版本」。直接依据为本机 DeepSeek Harness 的提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，本次没有核验它是否为上游最新版本。

- [文档分层](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact)要求每个事实有唯一归属，其他位置引用。
- [按当前职责命名](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cookbook/adding-a-package.md#name-the-role-that-exists)区分能力与实现，只有角色独立演进时才拆包。
- [根开发规则](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/AGENTS.md)要求把可检查的约束接入实际 gate，用反例验证，并明确独立变更与依赖 PR 的历史关系。
- [Agent Notes](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/.agents/notes/README.md)保存持续影响维护的原因，区分提议、实现与历史。

Agora 据此保留自己的单包结构、决策和证据目录。分支格式、主目录选择和 worktree 路径是本项目新约定，不能称为 DeepSeek 的原有规范。没有复制其多包分组、双语文档、原生 GitHub stack 依赖或整套 gate 编排器。

## 执行边界

既有依赖检查继续约束源码边界。本次补充开发文档，没有新增分支命名或 worktree 生命周期的自动检查。检查能力与审阅责任在现行规则中分开标明，后续增加检查时必须接入全量入口并验证违规样例。

当前分支、worktree、命名遗留项及实际验证见[核对记录](../../evidence/repository-governance/README.md)。
