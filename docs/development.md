# 开发与审阅

开始任务时先按[仓库与命名约束](repository-workflow.md)记录执行目录、基线和交付分支。文档分工见[文档归属规则](AGENTS.md)。

## 运行检查

在 macOS 或 Linux 准备 Node.js 22.13 或更新的 22.x 版本、pnpm 9.15.0、Python 3.9 或更新版本，以及 Git。在仓库根目录安装依赖并运行检查。进程归属检查依赖这两个平台的进程身份接口。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --only-shell chromium
pnpm check
```

本地和 CI 使用同一个 `pnpm check`。开发时可以单独运行受改动影响的检查。

| 命令 | 检查内容 |
| --- | --- |
| `pnpm format:check` | 代码和配置的格式。Markdown 走链接检查 |
| `pnpm lint` | 代码正确性、显式 `any`、TypeScript 抑制指令和计算生成的导入路径 |
| `pnpm typecheck` | TypeScript 严格类型检查 |
| `pnpm check:repository` | 仓库根目录、运行数据和生成产物的归属 |
| `pnpm check:architecture` | 生产源码的依赖方向、公开入口、循环与无法解析的导入 |
| `pnpm test` | 构建后递归运行 `tests` 下全部 `.test.mjs`，包含浏览器与开发工具回归 |
| `pnpm test:browser` | 构建后递归运行 `tests/browser`，用真实服务与 Chromium 验证编辑、批注、审阅、保存、历史和文本保真 |
| `pnpm check:docs` | Markdown 的本地文件与标题链接，调用 `python3 scripts/check-doc-links.py` |

运行 `pnpm dev` 打开 [A01 测试文稿](../tests/README.md#a01)。命令会构建实际面板和服务，并打印预览地址、Markdown 副本和运行目录。要单独构建发布入口，运行 `pnpm build`。

运行 `pnpm mock` 打开已确认的书店示例。运行 `pnpm mock --config /absolute/path/scenario.json` 更换初始文稿、批注、生成结果与延迟。每次使用隔离的测试副本，配置和模拟执行不进入面板。[mock 场景说明](../dev/mock/README.md)给出字段与真实服务入口。

本仓库源码保持严格类型检查。根配置按 NodeNext 检查服务、脚本和测试；[面板配置](../apps/panel/tsconfig.json)按 Bundler 检查浏览器源码，与 esbuild 的解析方式一致。`pnpm typecheck` 运行两者。`skipLibCheck` 只跳过依赖声明文件的检查，不抑制本仓库源码错误。

定位单条回归时，可以临时设置 `AGORA_TEST_NAME_PATTERN` 后运行相同测试入口，例如 `AGORA_TEST_NAME_PATTERN='native editor' pnpm test:browser`。runner 记录选择，保留原有源码与进程隔离，并拒绝无效或没有匹配用例的模式。完整交付检查不设置该变量，选定用例通过不能代表全套通过。

新增测试放在 `tests` 所属目录中，以 `.test.mjs` 结尾；runner 拒绝符号链接和空测试集合。夹具关闭、服务启动诊断及有期限的等待接口见[测试辅助](../tests/support/README.md)。验收与自动测试的对应关系见[场景索引](../tests/README.md#覆盖与运行入口)。

## 在 Codex app 中开发

从用户指定的主项目目录打开 Agora。普通任务沿用该目录，需要隔离时按 [worktree 规则](repository-workflow.md#主目录与-worktree)记录用途和回收条件。选择共享的 `Agora` 本地环境后，由 Codex 新建的 worktree 会安装锁定的依赖和无头 Chromium。顶栏的 **启动 A01**、**浏览器冒烟** 和 **全量检查** 调用本页的相同命令。环境初始化要求本机已有 Node.js 和 pnpm。参见 [Codex 本地环境](https://learn.chatgpt.com/docs/environments/local-environment)。

在 Codex 的 **Settings > Hooks** 审阅并信任 Agora 的项目 hook。`SessionStart` 报告真实目录和 session，`Stop` 检查明确请求的收尾，`PreToolUse` 执行已知的工具限制。改动定义后需要重新审阅信任。配置、脚本验证和宿主实际触发分开记录，见[任务收尾与资源回收](development-lifecycle.md)及 [Codex Hooks](https://learn.chatgpt.com/docs/hooks)。

## 固定开发基线

开工前按[任务协议](development-lifecycle.md#开始与关闭任务)建立有名字的外部任务目录。`begin` 调用基线脚本保存提交、路径和摘要。工作树已有改动时，先确认归属；完成后对照清单审查本轮增量。

```sh
pnpm task begin 2026-11-09-save-recovery
```

清单记录当前 `HEAD`、文件路径和 SHA-256。它覆盖已跟踪文件和未忽略的未跟踪文件。需要逐项比较时，对 `begin` 打印的 `baseline.json` 运行 `python3 scripts/worktree-baseline.py diff`，确认归属后再暂存本轮文件。清单和运行数据都归入统一状态目录。

## 写代码和测试

从[代码分工](architecture.md)和对应的[验收场景](../tests/README.md)确定模块归属及可观察的结果。服务负责保存和裁决业务状态，面板负责呈现和收集用户输入。桌面适配器负责接入 Codex，跨模块接口通过共享契约表达。

- 依赖规则写在[架构检查配置](../.dependency-cruiser.mjs)。共享包通过 `src/index.ts` 暴露公开入口。用可以静态解析的路径导入。面板可以调用纯文本工具，审阅和写回决定由服务负责。面板、契约和文本工具避开 Node 内置模块。
- 并行实现前，由一个负责人协调共享契约。委派时写明接口、各自负责的文件和可观察的验收结果。组装后从真实入口跑一条跨模块调用。
- 让状态有明确的写入方。沿用已有领域术语。抽取代码时，确认调用者可以少理解一层实现细节。
- 在接口入口校验外部数据。用类型表达内部约束。审阅时沿着一个真实调用检查成功、失败和恢复路径。
- 新增或调整自动检查时，用违规样例确认检查会失败。行为测试通过真实入口断言用户看到的结果或调用方读回的数据。
- 验收文稿流程时，只用脚本执行器替代 Codex 改稿。面板、服务、差异计算和持久化走真实代码。验证写回时使用临时 Markdown 副本，并核对文件正文和版本记录。

## 准备审阅证据

提交前运行 `pnpm check`。PR 记录基线、实际执行的命令、场景和结果。界面变更链接同一构建的截图或录屏，标明构建版本或摘要及实际入口。原始产物保存在受管状态目录或 CI artifacts，源码仓库只留简短索引。桌面接入、打包和发布验收使用实际安装的插件。按 [A01](../tests/README.md#a01) 和 [A03](../tests/README.md#a03) 验证真实 Codex 宿主，并单列结果。

自动检查通过后，审阅者仍需判断代码是否易读、职责是否清楚、交互是否符合预期。每份变更围绕一个可验收的结果。新增依赖、跨模块入口或规则例外时，在 PR 说明调用场景和取舍。改动用户可见行为时更新对应流程和验收。把今后仍会影响设计的取舍记在[决策记录](decisions/README.md)里。
