# 面板

面板显示服务投影，负责本机输入与请求顺序。浏览器和桌面插件复用面板交互。正式正文和版本以[服务](../service/README.md)的结果为准。

| 参考实现入口（相对 `next/`） | 职责 |
| --- | --- |
| `apps/panel/src/controller/document-controller.ts` | 保存队列、前序编辑提交、旧响应处理、审阅决定和历史读取 |
| `apps/panel/src/controller/annotation-composer.ts` | 选区、批注草稿和内容变化时的重新定位提示 |
| `apps/panel/src/drafts/store.ts` | IndexedDB 草稿及原待核对请求 |
| `apps/panel/src/components/review-panel.tsx` | 通篇、逐条、批量决定与明确确认的界面 |

发送前持久化原请求 ID、参数和当时的输入。重开先查询原回执，未知结果沿用原 ID 和参数。旧回执只结算对应输入，较晚的本机输入继续保留。正文基底冲突时保留草稿，交给用户决定。

批注、开始审阅和版本操作先处理前序编辑。批量决定逐项刷新审阅依据；遇到冲突、未知结果、轮次变化或另一入口先作决定时停止。预览响应只可更新它所属的文档和当前选择。

验证入口为参考实现的 `tests/controller.test.ts`、`tests/draft.test.ts`、`tests/reviews.test.ts` 和 [A04](../../tests/README.md#a04)、[A05](../../tests/README.md#a05)、[A11](../../tests/README.md#a11)。
