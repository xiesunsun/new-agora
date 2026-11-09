# Ink 接入证据

基线为 `78cafaf1cf6c7f52b77939b07d9a01381a3bd7c2`。工作分支为 `codex/ink-integration`。实现提交为 `fdb0b0abf6bf06fa125c247c314543e342f1968a`。原工作树保持干净，本轮在独立管理的 worktree 中实现。

## 实际检查

主代理在最终源代码冻结后运行 `pnpm check`。[完整输出](check.log)记录 72 项测试通过，无失败、取消或跳过。格式、lint、严格 TypeScript、依赖方向和两种构建都通过。架构检查包含 41 个模块与 74 条依赖。

[构建与截图清单](build.json)保存实际 bundle 的 SHA-256 和下表 30 张截图的校验值。截图来自完整检查中真实服务驱动的浏览器测试。示例与主代理原生操作使用相同 panel.js 和样式，场景数据不同。

| 场景 | 1280 | 760 | 390 |
| --- | --- | --- | --- |
| 写作 | [截图](screenshots/writing-1280.png) | [截图](screenshots/writing-760.png) | [截图](screenshots/writing-390.png) |
| 选区笔尖 | [截图](screenshots/pen-1280.png) | [截图](screenshots/pen-760.png) | [截图](screenshots/pen-390.png) |
| 批注输入 | [截图](screenshots/composer-1280.png) | [截图](screenshots/composer-760.png) | [截图](screenshots/composer-390.png) |
| 批注回看 | [截图](screenshots/peek-1280.png) | [截图](screenshots/peek-760.png) | [截图](screenshots/peek-390.png) |
| 任务圆片 | [截图](screenshots/orbit-1280.png) | [截图](screenshots/orbit-760.png) | [截图](screenshots/orbit-390.png) |
| 行内审阅 | [截图](screenshots/review-1280.png) | [截图](screenshots/review-760.png) | [截图](screenshots/review-390.png) |
| 已选回看 | [截图](screenshots/readback-1280.png) | [截图](screenshots/readback-760.png) | [截图](screenshots/readback-390.png) |
| 历史 | [截图](screenshots/history-1280.png) | [截图](screenshots/history-760.png) | [截图](screenshots/history-390.png) |
| 删除确认 | [截图](screenshots/delete-dialog-1280.png) | [截图](screenshots/delete-dialog-760.png) | [截图](screenshots/delete-dialog-390.png) |
| 生成中断 | [截图](screenshots/interrupted-1280.png) | [截图](screenshots/interrupted-760.png) | [截图](screenshots/interrupted-390.png) |

## 原生浏览器核对

主代理通过 cua_repl 操作最终构建。书店示例从实际 mock 入口启动，接受第一项、保留第二处原文并用 Command + S 保存。直接读取测试 Markdown，确认只包含第一项改动，与 V2 完全一致，版本总数为 2。

另一份测试副本包含 BOM、混合 LF 与 CRLF 和 emoji。在原文编辑器选中可见的「乙」，通过快捷键打开批注。服务保存的 quote 为「乙」，原文范围为 UTF-16 17–18。取消后添加感叹号并保存，逐字节核对未修改的换行，结果与 V2 相同。[操作及读回记录](native-results.json)保留入口、副本路径和正文摘要。

这些原生观察由协调者根据实际工具输出记录，没有导出完整聊天和工具逐条记录。自动化浏览器回归独立覆盖正反选区、历史及确认取消后的选择方向、输入法组合事件、全舍弃保存、已选回看与动画取消。

## 审阅结果

no-comments 最终扫描没有可操作的注释或抑制指令。保留严格 checkJs 必需的 JSDoc 类型声明。服务规格、服务质量、界面规格和界面质量分别经过独立审阅。审阅发现的旧回执、旧批注焦点、历史采用、原文换行、选区映射与保存状态问题均修复并补上回归。

[决策轨迹](decisions.tsv)按实际先后追加记录。[实施计划](../../docs/plans/ink-integration.md)区分已完成接入与未验收的实际桌面宿主。[接入决策](../../docs/decisions/ink-integration.md)记录长期边界。

## 探索文件清理

[源清单](source.json)记录 12 个顶层源文件、归档摘要和明确的删除名单。两个对应目录的 378 个源文件在删除前重新与归档清单核对，全部一致。只清理 ink-prototype-v1 和 review-readback-20261109，其他设计目录保留。

可恢复归档为 `/Users/ssunxie/.local/state/agora/archive/ink-integration-20261109/accepted-explorations.tar.gz`。同目录 sha256.json 记录逐文件摘要。归档包含 macOS AppleDouble 元数据，378 个源内容独立核验一致。设计与交叉评审材料也在该仓库外目录保留。

早期基线 12 项测试和原型全部 check 脚本通过，由协调者在本聊天中实际运行。没有独立保存这两次历史执行的完整 stdout，审计不能把它们等同于最终完整输出。轨迹中原型 README 的旧路径已随清理迁入上述归档。

## 验证边界

当前会话未暴露已启用的 Agora 桌面工具。没有安装或启用被关闭的插件。真实服务、脚本执行器、MCP stdio 与桌面 SDK 边界测试通过；实际安装的 Codex 宿主 A01、A03 仍未验收。输入法检查使用浏览器组合事件，不声称进行了操作系统输入法硬件测试。

最终文档追加后另跑链接检查，28 份 Markdown、138 个本地链接通过。清理后重新构建，bundle 摘要与已验收构建一致。

## 审阅交付

[PR #1](https://github.com/xiesunsun/new-agora/pull/1)面向 main，处于公开审阅状态，不是草稿。本轮没有合并或部署。代码提交与文档证据分别保留。GitHub CI 的实时状态以 PR 页面为准。

GitHub 连接器创建 PR 返回权限不足，协调者改用已登录的 gh 完成创建，并将 PR 附加到当前聊天。该过程记录没有完整工具转录，属于协调者报告；PR 的存在、目标分支及非草稿状态可独立读取验证。
