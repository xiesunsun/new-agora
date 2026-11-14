# Agora 开发入口

从 [Agora 文档](docs/README.md) 找你要改的功能。想知道 Codex 改哪份稿、用户怎么选、什么时候会保存版本，先读[生成修改建议](docs/flows/annotate-and-sync.md)和[审阅与写回](docs/flows/review.md)。

改完文档，运行 `python3 scripts/check-doc-links.py` 检查链接。验证原文件写入时，用一份测试文稿的副本。

安装依赖、运行检查和提交审阅证据，见[开发与审阅](docs/development.md)。

开工、切分支或创建 worktree 前，按[仓库与命名约束](docs/repository-workflow.md)确认主目录、基线和交付分支。沿用用户指定的项目目录，不默认迁移到新 worktree。

开工前记录已接受的基线。工作树有未提交改动时，先把文件清单和校验值保存到仓库外。并行修改前确定共享契约、文件归属和可观察的验收结果。

开发任务按[任务收尾与资源回收](docs/development-lifecycle.md)运行 `pnpm task begin` 和 `pnpm task close`。交付前复盘本轮失败、对照 DeepSeek Harness、记录规则改动和资源去向。临时资料统一进入受管状态目录。

仓库只保留源码、配置、夹具和长期说明。日志、截图及运行数据按资源协议保存。修改 hook 时，先测试未加载的候选配置，覆盖旧 worktree 与脚本失败，再恢复加载。

按当前职责命名模块。新增或移动模块时，同步[代码分工](docs/architecture.md)、模块 README 和依赖检查。改文档先读[文档归属规则](docs/AGENTS.md)。
