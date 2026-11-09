# 仓库约束核对记录

观察日期为 2026-11-09。Agora 已接受的基线为 `204dac28bdc04119abd36ca1ad291b19322a81af`。本轮在 `/Users/ssunxie/code/new_agora` 从该提交建立 `codex/docs-repository-governance`，没有新增 worktree。文档依赖尚未合并的 Ink 接入内容，父分支为 `codex/ink-integration`，[父 PR 为 #1](https://github.com/xiesunsun/new-agora/pull/1)。

开工时主目录干净。仓库外基线与原始 Git 清单保存在 `/var/folders/fd/15y1w99s05730vn0zr1d00cr0000gn/T/agora-repository-governance-7i8cayif/`。这是本机临时记录，不是跨机器交付依赖。

本轮文件由主代理统一修改，范围为根开发入口、仓库规则、文档归属、架构与 worker 说明、Ink 计划状态及本次决策和证据。验收要求是阅读入口可达、规则职责一致、来源可核对，并通过仓库检查。

## 当时的分支与 worktree

以下是开工快照，不是持续维护的分支注册表。用 `git branch -avv` 和 `git worktree list --porcelain` 重新取得现场。

| 工作目录 | 检出状态 | HEAD |
| --- | --- | --- |
| `/Users/ssunxie/code/new_agora` | 开工时为 `codex/ink-integration`，本轮切换为 `codex/docs-repository-governance` | `204dac2` |
| `/Users/ssunxie/.codex/worktrees/ink-integration/new_agora` | 分离 HEAD，当前聊天仍绑定此目录 | `204dac2` |
| `/Users/ssunxie/code/new_agora-a01` | `codex/a01` | `beefda2` |
| `/Users/ssunxie/code/new_agora-gates` | `codex/development-gates` | `beefda2` |

本地 `main` 为 `beefda2`，本地已有的 `origin/main` 引用为 `78cafaf`。`codex/a01-baseline` 也指向 `78cafaf`。这些值来自本地引用，本次没有 fetch，不能称为实时远端状态。

## 需要后续整理的项目

| 项目 | 已确认的事实 | 后续处理条件 |
| --- | --- | --- |
| `codex/a01`、`codex/a01-baseline` | 名称表达场景或基线，不能说明交付结果 | 核对独有提交、文件和引用后，再判断保留、改名或回收 |
| `codex/development-gates` 与旧 worktree | 仍被检出，不能凭名称推断已完成 | 核对交付状态与未推送工作，再按新规则关闭 |
| 托管的 detached worktree | 与主目录指向同一接入提交；此前应用拒绝归档活动聊天的主检出目录 | 保留目录，待解除聊天绑定并确认无独有工作后由应用回收 |
| 本地 `main` 与 `origin/main` | 指向不同提交 | 查看提交关系和远端状态，再确定同步方式 |
| `apps/worker` | 当前只实现开发用脚本执行器，归在 `apps` 容易被理解为生产服务 | 已修正文档；实际移动至开发工具归属需一起迁移调用方、依赖规则、构建和测试 |

本轮没有移动源码、改名旧分支、合并或删除旧 worktree。现行[仓库约束](../../docs/repository-workflow.md)约束新工作，以上遗留项按明确范围另行处理。

## 学习与验证边界

已读取指定聊天最近的学习记录，并核对本机 DeepSeek Harness 的根规则、模块规则、文档规则、命名指引和 Agent Notes。直接来源与提交固定在[决策记录](../../docs/decisions/repository-governance.md)中。

本轮仅修改开发说明与入口链接。没有实现新的 Git 或目录检查器。

主代理运行 `pnpm check` 通过。[完整输出](check.log)记录格式、lint、严格类型、依赖检查及 72 项测试通过，无失败、取消或跳过。文档检查覆盖 32 份 Markdown 和 165 个本地链接。追加日志链接后再次运行文档检查，32 份 Markdown 和 166 个本地链接通过。

no-comments 审阅没有发现需处理的注释或抑制指令，删除、恢复和重跑均为 0。独立文档审阅核对了事实归属、来源、现有模块职责与执行边界，结论为通过。两位审阅者只读，本轮文件仍由主代理统一修改。
