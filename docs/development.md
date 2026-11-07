# 开发与审阅

## 运行检查

准备 Node.js 22.13 或更新的 22.x 版本、pnpm 9.15.0、Python 3.9 或更新版本，以及 Git。在仓库根目录安装依赖并运行检查。

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
| `pnpm check:architecture` | 生产源码的依赖方向、公开入口、循环与无法解析的导入 |
| `pnpm test` | 仓库自动化测试 |
| `pnpm test:browser` | 构建并启动 Agora，用 Chromium 验证文稿编辑器可见、可编辑并加载正确正文 |
| `pnpm check:docs` | Markdown 的本地文件与标题链接，调用 `python3 scripts/check-doc-links.py` |

运行 `pnpm dev` 打开 [A01 测试文稿](../tests/README.md#a01)。命令会构建实际面板和服务，并打印预览地址、Markdown 副本和运行目录。要单独构建发布入口，运行 `pnpm build`。

本仓库源码保持严格类型检查。`skipLibCheck` 跳过依赖声明文件的检查，兼容桌面 MCP SDK 声明中省略扩展名的导入。

## 固定开发基线

开工前记录已接受的基线提交。工作树已有未提交改动时，在仓库根目录保存清单，完成后对照清单审查本轮增量。

```sh
baseline_dir=$(mktemp -d)
python3 scripts/worktree-baseline.py capture "$baseline_dir/before.json"
python3 scripts/worktree-baseline.py diff "$baseline_dir/before.json"
```

清单记录当前 `HEAD`、文件路径和 SHA-256。它覆盖已跟踪文件和未忽略的未跟踪文件。比较按路径列出新增、修改和删除，逐项确认归属后再暂存本轮文件。清单和临时运行数据保存在仓库外。

## 写代码和测试

从[代码分工](architecture.md)和对应的[验收场景](../tests/README.md)确定模块归属及可观察的结果。服务负责保存和裁决业务状态，面板负责呈现和收集用户输入。桌面适配器负责接入 Codex，跨模块接口通过共享契约表达。

- 依赖规则写在[架构检查配置](../.dependency-cruiser.mjs)。共享包通过 `src/index.ts` 暴露公开入口。用可以静态解析的路径导入。面板可以调用纯文本工具，审阅和写回决定由服务负责。面板、契约和文本工具避开 Node 内置模块。
- 并行实现前，由一个负责人协调共享契约。委派时写明接口、各自负责的文件和可观察的验收结果。组装后从真实入口跑一条跨模块调用。
- 让状态有明确的写入方。沿用已有领域术语。抽取代码时，确认调用者可以少理解一层实现细节。
- 在接口入口校验外部数据。用类型表达内部约束。审阅时沿着一个真实调用检查成功、失败和恢复路径。
- 新增或调整自动检查时，用违规样例确认检查会失败。行为测试通过真实入口断言用户看到的结果或调用方读回的数据。
- 验收文稿流程时，只用脚本执行器替代 Codex 改稿。面板、服务、差异计算和持久化走真实代码。验证写回时使用临时 Markdown 副本，并核对文件正文和版本记录。

## 准备审阅证据

提交前运行 `pnpm check`。PR 记录基线、实际执行的命令、场景和结果。界面变更附同一构建的截图或录屏，标明构建版本或摘要及实际入口。桌面接入、打包和发布验收使用实际安装的插件。按 [A01](../tests/README.md#a01) 和 [A03](../tests/README.md#a03) 验证真实 Codex 宿主，并单列结果。

自动检查通过后，审阅者仍需判断代码是否易读、职责是否清楚、交互是否符合预期。每份变更围绕一个可验收的结果。新增依赖、跨模块入口或规则例外时，在 PR 说明调用场景和取舍。改动用户可见行为时更新对应流程和验收。把今后仍会影响设计的取舍记在[决策记录](decisions/README.md)里。
