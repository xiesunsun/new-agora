# 开发收尾与资源验收

本轮从 `dc0e595a69e558f062a7246b93a8023b5d2c8be2` 继续，实际执行目录为 `/Users/ssunxie/code/new_agora`，沿用 `codex/docs-repository-governance` 修正 [PR #2](https://github.com/xiesunsun/new-agora/pull/2)。2026-11-09 的本地全量检查通过，118 个测试无失败或跳过。远端 CI 以 PR 当前提交的 Checks 为准。

## 事实与保留位置

任务基线、恢复前清单、复盘、候选配置与运行日志归入 `~/.local/state/agora/tasks/2026-11-09-development-lifecycle`。旧临时资料归档在 `~/.local/state/agora/archive/2026-11-09-legacy-temporary`，112 项目录或文件、354 个文件内容在移动前后核对一致。

本轮创建的最后一份系统临时 mock 夹具在确认无打开文件后已删除，清理清单保存在任务目录。源码中原有的 36 份日志、截图和构建清单已逐文件校验归档，位于 `~/.local/state/agora/archive/2026-11-09-repository-evidence`，`manifest.json` 保存源提交、路径、摘要与大小。当前 `evidence` 只保留索引，旧产物仍能通过固定 Git 提交访问。本次没有改写历史提交。

## 已复现的流程问题

- 创建迁移 worktree 是隔离实现的选择，不是原型接入的技术前提；此前没有明确回收和聊天绑定关系。
- Ink 是来源原型代号，没有单独的正式命名决策。当前源码按编辑器、面板、文稿服务命名，历史记录保留来源名。
- 已知 GitHub 创建 PR 方法返回 403，后续却重复尝试。当前规则将该方法单独登记，保留已验证的 `gh` 路径。
- 第一版新 hook 从旧工作树寻找缺失脚本，使工具调用和 `Stop` 重复失败。用户移走配置并重启后恢复。新的启动命令须通过旧 worktree、缺失及失败处理的回归验证后才恢复。

## 本地验收结果

`AGORA_TASK_ID=2026-11-09-development-lifecycle pnpm check` 通过仓库归属、格式、lint、类型、依赖边界、构建、118 个测试及文档链接检查。`pnpm clean:dev` 列出的默认受管运行为空。完整日志为任务目录中的 `check.log`。

回归覆盖 mock 启动失败与停止、显式保留和清理、测试污染源码、runner 中断、独立进程组、浏览器中断、PID 启动身份和不确定身份的安全停止。独立审阅发现的基线符号链接写入、运行句柄随环境变化及中断回调问题均已修复并以反例验证。

首轮远端 CI 暴露 Linux 全机快照中合法的进程组 `0` 被误拒绝。本地加入同类记录复现后，修正读取校验并新增回归；所属资源记录和清理目标仍要求正数进程组。该次失败作业的源码检查、证据上传和状态清理成功。

CI 生命周期脚本的 27 项本地行为检查通过。真实远端作业结果通过 PR Checks 和任务目录中的 CI 记录定位，不把本地脚本检查写成远端通过。

实际配置命令已从旧 worktree 执行并返回有效 JSON，缺失脚本、崩溃及无效输出有回归。新宿主观察未提供真实 `SessionStart` 或 `Stop` 触发证据，自动 hook 仍未验收。当前任务未绑定 session，按显式命令收尾，最终回执保存在任务目录 `receipt.json`。

## 验收范围

任务命令的结构检查与实际复盘质量分开。模拟 hook、实际宿主加载和实际宿主触发分开。CI 配置验证与远端 CI 作业分开。正式产品的 Codex 宿主 A01、A03 验收不由本轮开发工具测试代替。

[当前资源协议](../../docs/development-lifecycle.md) · [实施计划](../../docs/plans/2026-11-09-development-lifecycle.md) · [DeepSeek 对照依据](../../docs/decisions/repository-governance.md)
