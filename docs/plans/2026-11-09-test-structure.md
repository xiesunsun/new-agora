# 测试与验收结构整理

状态为已完成。本地两次完整检查均为 130 项测试通过，无失败或跳过；真实 Codex 宿主验收仍按场景索引单列。范围来自已确认的五项审阅问题：测试启动失败、夹具清理顺序、测试发现、说明漂移和验收索引。

## 基线与职责

主目录和执行目录均为 `/Users/ssunxie/code/new_agora`。沿用引入这些实现的 `codex/docs-repository-governance`，起点和已接受基线为 `56e27350bc878149f423461d4e67e1102277aedc`。集成目标为 `main`；本轮不切分支、不创建 worktree。开工工作树干净，外部任务 `2026-11-09-test-structure-fixes` 保存基线与运行证据。

主代理负责工具、测试共享接口及最终集成。独立审阅只读。保留单包、正式服务与测试副本的既有边界，不调整产品保存协议。

## 实施顺序

1. [x] 在 `tests/tooling/service-fixtures.test.mjs` 为服务启动补充真实入口反例：延迟超过旧预算仍可就绪，提前退出与信号退出包含服务输出，永不就绪有期限，重复停止安全。修改 `tests/support/service.mjs`，新增 `tests/support/wait.mjs` 的有期限读取接口 `waitFor(read, {description, timeoutMs, diagnostics})`；启动失败必须停止已启动的子进程并把输出保留到测试证据目录。嵌套进程等待以实际报告就绪为准，不使用短次数预算。
2. [x] 新增 `tests/support/fixture.mjs`，公开 `createFixture(context, prefix)`，返回 `root`、`after(cleanup)` 和幂等 `close()`。在 `tests/tooling/service-fixtures.test.mjs` 验证资源按注册的逆序关闭后才删除目录；关闭失败仍执行其他关闭动作并保留目录。部分初始化失败和手动停止后再次收尾同样验收。迁移 `tests/a01.test.mjs`、`tests/manuscript-service.test.mjs`、`tests/browser/panel.test.mjs`、`tests/mock.test.mjs`。
3. [x] 在 `tests/tooling/test-isolation.test.mjs` 的受管副本中增加两层嵌套失败测试。`scripts/test.mjs` 递归发现 `tests` 下的 `.test.mjs`，浏览器子集只选择 `tests/browser` 并继续递归。路径确定排序；符号链接报错，防止越界或静默漏测。验证完整模式发现失败、浏览器模式发现其子目录并排除其他目录，源码与资源隔离检查继续生效。
4. [x] 校正 `docs/architecture.md` 的实际通知路径，更新 `plugins/desktop/README.md` 的受管测试副本操作；在 `docs/development.md` 和新增的 `tests/support/README.md` 说明当前检查入口及边界。
5. [x] 在 `tests/README.md` 增加验收场景到具体测试、夹具和人工验收的链接；保留 A01 原稿和预期结果，单列 A12 及真实宿主未验收部分。
6. [x] 运行针对性回归、文档链接和完整 `pnpm check`，独立审阅增量，再对照固定 DeepSeek 来源复盘、核对资源并完成任务收尾。

## 可观察验收

- 服务启动错误包含可定位的输出；启动等待有明确期限，慢启动测试通过。
- 清理回调在目录存在时完成；失败路径保留必要目录，进程没有遗漏。
- 新的嵌套失败测试被真实 runner 执行，浏览器子集不会误收其他测试。
- 验收入口能直接找到自动测试与测试文稿，模拟、真实浏览器和真实桌面结果明确区分。
- 全量检查通过，源码增量可审阅；原文件写入只用测试副本。

采用逐项反例、实现和回归的顺序。具体日志、失败记录、临时诊断与回执进入受管任务目录，不提交到源码仓库。

针对性回归先运行 `node --test tests/tooling/service-fixtures.test.mjs tests/tooling/test-isolation.test.mjs tests/tooling/test-processes.test.mjs`；它用于观察反例和实现结果，不代替正式 runner 的隔离验收。最终运行 `pnpm check`，要求所有测试、源码清单、进程归属及文档链接均通过。文档单独运行 `python3 scripts/check-doc-links.py`。场景索引列出测试名称与链接，分别标记自动、部分自动、人工和 A12 后续维护。
