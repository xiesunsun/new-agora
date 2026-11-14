# Codex 桌面接入

## 日常使用

安装插件后，在 Codex app 当前对话中说「用 Agora 打开 `/绝对路径/文稿.md`」。插件按路径进入项目，自动启动该稿件的正式服务，恢复工作稿、批注、待审建议和历史。首次打开需要路径；之后省略路径会恢复当前对话最近打开的项目。

一个 Markdown 规范路径对应一个项目。打开另一个路径会进入另一项目，已打开面板仍绑定原项目。符号链接指向同一份文件时沿用原项目。另一个活动对话不能接管已打开的项目；原插件连接结束后，可在新的对话里显式打开同一路径继续。

已打开项目的普通请求沿用所属服务与对话绑定，路径规范化由打开操作负责，原文件一致性由写回负责。原文件暂不可用时的草稿与保存行为见[打开文稿与保存草稿](../../docs/flows/edit-and-save.md)。

服务由 Codex 插件进程创建和回收，不要求用户另开终端，也不安装登录常驻服务。宿主结束 MCP 连接或退出时关闭所属服务，项目数据保留。只有窗口隐藏但宿主仍保留连接时，服务也会保留。子服务崩溃不会转移项目归属，原对话可恢复服务。

项目数据位于统一状态根的 `projects/<路径摘要>`，最近打开记录位于 `projects/threads`。状态根遵循 `AGORA_STATE_DIR`、`XDG_STATE_HOME/agora` 和 `~/.local/state/agora` 的优先级；配置须为绝对路径。原 Markdown 留在用户指定的位置。项目数据不属于 `clean:dev` 的临时运行，更新插件也不删除它。

## 构建和安装

运行 `pnpm build`，将 `dist/desktop` 的完整内容放入持久的本地插件市场，再按 [Codex 本地市场安装步骤](https://developers.openai.com/plugins/build/plugins#build-your-own-curated-plugin-list) 安装。默认安装不设置 `AGORA_CONNECTION`。安装包包含 MCP 入口、面板和独立的正式服务，不引用开发仓库的 `dist` 或 `node_modules`。宿主提供的 Node.js 需支持 Node 22.13 及其内置 SQLite。

面板资源地址包含插件版本，页面的 `agora-version` 元信息标记实际构建。浏览器与桌面使用同一套编辑、审阅和打包样式。更新安装包后，要核对已安装文件、正在运行的 MCP 和重新打开的面板；旧连接仍加载旧代码时，需要重新连接宿主。独立 SDK 检查不代表当前 Codex 窗口已刷新。插件升级不回滚项目数据。

`src/projects.ts` 负责项目路径、最近项目、父进程拥有的项目租约和子服务生命周期；`src/connection.ts` 负责本机 HTTP 契约；`src/server.ts` 负责当前对话身份、工具路由和 MCP 关闭；`src/host.ts` 负责面板挂载与当前项目的改稿通知。插件不导入服务领域实现。

打开结果、面板命令和通知携带 `projectId`。领取指定该项目，结果返回 `projectId`、`executionId` 和 `candidatePath`。提交或结束报告使用领取时的项目和执行编号；重启后核对未知执行也沿用这两个身份。切换到新项目不会把旧执行提交到新稿件。

## 显式外部服务联调

在仓库根目录运行 `pnpm build`。桌面插件在 `dist/desktop`。用测试 Markdown 副本和独立运行目录启动真实服务。

下面的前台命令创建受管测试副本，只启动正式服务。进程存活期间拥有运行目录；停止或异常退出后保留文稿和数据库，供人工读回核对。

```sh
node --input-type=module <<'JS'
import { copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { createManagedRun } from './dev/runtime/src/index.mjs';
import { createTestProcessScope, finishTestProcesses } from './scripts/test-processes.mjs';

const run = await createManagedRun('test');
const scope = createTestProcessScope(run.root, process.env);
let reason = 'Desktop A01/A03 manuscript and version readback';
try {
  const document = join(run.root, 'manuscript.md');
  await copyFile('tests/fixtures/a01/original.md', document);
  const child = spawn(process.execPath, ['dist/run.js', '--file', document,
    '--runtime', join(run.root, 'runtime')], { stdio: 'inherit', env: scope.env });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw new Error(`Service exited: ${code}`);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
} catch (error) {
  reason = `Desktop acceptance failed: ${String(error)}`;
  throw error;
} finally {
  const report = await finishTestProcesses(scope);
  if (report.leaked.length || report.survivors.length || report.uncertain.length) {
    reason = `Desktop process cleanup requires review: ${JSON.stringify(report)}`;
    process.exitCode = 1;
  }
  await run.retain(reason);
  console.log(`Retained: ${run.root}`);
  const state = dirname(dirname(run.root)).replaceAll("'", "'\\''");
  console.log(`Cleanup: AGORA_STATE_DIR='${state}' pnpm clean:dev --remove ${basename(run.root)}`);
}
JS
```

用终端打印的 Markdown 和运行目录进行验收。完成后停止命令，记录实际结果，再执行它打印的精确清理命令。运行数据的归属与回收规则见[资源协议](../../docs/development-lifecycle.md#运行资源的创建者负责回收)。

将插件构建复制到本地测试市场，在副本的 `.mcp.json` 中设置 `mcpServers.agora-a01.env.AGORA_CONNECTION`，值为上一步打印的运行目录下 `connection.json` 的绝对路径。运行目录保留在插件目录外。按 [Codex 本地市场安装步骤](https://developers.openai.com/plugins/build/plugins#build-your-own-curated-plugin-list) 在桌面应用安装测试构建。在测试对话请 Codex 调用 `agora_open_document` 打开文稿。

## 改稿与提交

从当前 Codex 对话打开并绑定 Markdown。用户点 **生成修改建议** 后，桌面插件携带原面板的项目身份通知该对话领取任务。通知受理后继续显示等待，直到本地服务核对绑定和对话并确认领取。

`agora_claim_next` 返回待审 Markdown 路径、批注选区和用户意见。Codex 用原生工具修改待审稿，再携带原项目和执行编号调用 `agora_submit_candidate`。Agora 读取待审文件并算出差异。来自其他对话的领取或提交应被拒绝。领取后失败或取消，使用同一身份调用 `agora_finish_execution` 报告 failed 或 cancelled。停止后迟到提交只提供结束证据，不能发布旧建议。执行结束未知时，重试与全新生成都保持阻止。

给出待审路径并说明用途只能约束正常操作。如果 Codex 仍能写原文件，副本本身不提供权限隔离。要承诺强制限制原路径写入，必须用工具或运行环境验证该限制。

用测试文件在真实 Codex 桌面版验证当前对话能领取并编辑待审稿，切到另一对话不能领取，审阅前原文件内容保持原样。参见[完整闭环](../../tests/README.md#a01)和[对话归属](../../tests/README.md#a03)。
