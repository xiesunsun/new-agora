# Codex 桌面接入

## 安装测试构建

在仓库根目录运行 `pnpm build`。桌面插件在 `dist/desktop`。用测试 Markdown 副本和独立运行目录启动真实服务。

```sh
scratch=$(mktemp -d)
cp tests/fixtures/a01/original.md "$scratch/manuscript.md"
pnpm start --file "$scratch/manuscript.md" --runtime "$scratch/runtime"
```

将插件构建复制到本地测试市场，在副本的 `.mcp.json` 中设置 `mcpServers.agora-a01.env.AGORA_CONNECTION`，值为上一步打印的运行目录下 `connection.json` 的绝对路径。运行目录保留在插件目录外。按 [Codex 本地市场安装步骤](https://developers.openai.com/plugins/build/plugins#build-your-own-curated-plugin-list) 在桌面应用安装测试构建。在测试对话请 Codex 调用 `agora_open_document` 打开文稿。

## 改稿与提交

从当前 Codex 对话打开并绑定 Markdown。用户点 **生成修改建议** 后，桌面插件通知该对话领取任务。通知受理后继续显示等待，直到本地服务核对绑定和对话并确认领取。

`agora_claim_next` 返回待审 Markdown 路径、批注选区和用户意见。Codex 用原生工具修改待审稿，再用同一个执行编号调用 `agora_submit_candidate`。Agora 读取待审文件并算出差异。来自其他对话的领取或提交应被拒绝。

给出待审路径并说明用途只能约束正常操作。如果 Codex 仍能写原文件，副本本身不提供权限隔离。要承诺强制限制原路径写入，必须用工具或运行环境验证该限制。

用测试文件在真实 Codex 桌面版验证当前对话能领取并编辑待审稿，切到另一对话不能领取，审阅前原文件内容保持原样。参见[完整闭环](../../tests/README.md#a01)和[对话归属](../../tests/README.md#a03)。
