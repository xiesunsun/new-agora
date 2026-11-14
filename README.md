# Agora

在 Codex app 里共同修改 Markdown。你可以直接编辑正文，也可以选中文字留下批注，让当前对话中的 Codex 提交修改建议。逐项选择要采用的内容，再保存到原文件。

当前版本面向本地试用，支持 Markdown 编辑、批注、差异审阅、保存与历史版本。使用流程与能力边界见[产品说明](docs/product.md)和[文档索引](docs/README.md)。项目主页、本稿要求和根据反馈重新生成仍是[设计草案](docs/plans/2026-11-14-project-writing-workflow.md)。

## 在 Codex app 中试用

按[桌面插件安装说明](plugins/desktop/README.md#构建和安装)构建并安装插件，然后在当前对话中说：

> 用 Agora 打开 `/绝对路径/文稿.md`。

一个 Markdown 路径对应一个项目，插件自动启动所属服务。日常编辑、保存草稿和重新打开的行为见[打开文稿与保存草稿](docs/flows/edit-and-save.md)。

## 本地浏览器预览

先按[开发环境要求](docs/development.md#运行检查)准备依赖工具，再运行：

```sh
git clone https://github.com/xiesunsun/new-agora.git
cd new-agora
pnpm install --frozen-lockfile
pnpm dev
```

打开终端打印的预览地址。这个入口使用正式面板与服务、隔离的测试文稿副本，并用脚本模拟 Codex 改稿。停止命令会回收该次开发运行。

## 参与协作

- 从 `main` 新建功能分支，通过 Pull Request 合并回 `main`。分支命名、依赖关系和工作目录约定见[仓库工作流](docs/repository-workflow.md)。
- 提交前运行 `pnpm check`。安装浏览器测试依赖、验证交互和准备审阅证据见[开发与审阅](docs/development.md)。
- 在 [Issues](https://github.com/xiesunsun/new-agora/issues) 讨论需求或反馈问题。说明使用场景、复现步骤和预期结果；涉及文稿时提供可分享的示例。

源码职责见[代码分工](docs/architecture.md)。当前行为、设计取舍和未来方案分别从[文档索引](docs/README.md)、[决策记录](docs/decisions/README.md)和[项目写作流程草案](docs/plans/2026-11-14-project-writing-workflow.md)进入。
