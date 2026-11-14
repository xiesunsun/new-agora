# 测试辅助

正式执行入口为 `pnpm test` 和 `pnpm test:browser`。runner 分配临时根、证据目录及进程归属，结束时核对源码和剩余进程；具体规则见[测试资源](../AGENTS.md)与[资源协议](../../docs/development-lifecycle.md)。这些辅助不替代外层 runner。

## 夹具与清理

`fixture.mjs` 的 `createFixture(context, prefix, parent?)` 分配测试目录并登记一次关闭过程。默认父目录为 runner 设置的临时根；独立运行已有受管目录时可显式传入该目录。返回值的 `after(cleanup)` 登记已取得资源的关闭动作，按注册的逆序等待执行，全部关闭成功后才删除目录。`close()` 可重复等待。

取得服务、MCP 客户端和浏览器后立即登记到同一夹具，目录权限恢复也登记到该夹具。初始化中断仍关闭已登记的资源。某个关闭动作失败时继续关闭其余资源，保留目录并报告失败；外层 runner 保留诊断，不丢弃进程身份。

## 服务就绪与诊断

`service.mjs` 的 `startService(cleanup, document, runtime, options?)` 启动构建后的正式服务，读取真实 `connection.json`，返回 `request()`、`url` 与幂等的 `stop()`。`cleanup` 可使用上面的夹具。测试副本和运行目录由调用方提供。

默认启动期限为 15 秒。可用 `options.env` 为故障测试设置子进程环境，`timeoutMs` 用于明确的启动期限测试。服务退出、信号结束与启动超时均停止该子进程，并在错误中附带输出。完整输出保存到运行目录的 `service.log`；启动失败时另复制到 runner 的证据目录。停止先发 SIGTERM，5 秒未退出再发 SIGKILL，再等待最多 5 秒，失败保留诊断。

`wait.mjs` 的 `waitFor(read, {description, timeoutMs?, diagnostics?})` 在有期限的轮询中等待读取结果；只有 `undefined` 表示未就绪。默认期限为 15 秒，异常直接报告，超时附上诊断。用于等待真实连接或进程报告，不把固定延迟当作工作已结束的证据。

[辅助行为回归](../tooling/service-fixtures.test.mjs)验证延迟启动、异常输出、有期限停止和清理顺序；[runner 回归](../tooling/test-isolation.test.mjs)验证递归发现、浏览器范围、源码与进程隔离。
