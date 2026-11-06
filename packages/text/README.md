# Markdown 与差异

参考实现的 `next/packages/text/src/` 保存纯文本算法。原文包含 BOM、CRLF 和 Unicode。选区、批注锚点与修改范围使用原文 UTF-16 偏移。展示层转换偏移时保留原文映射。

| 文件 | 职责 |
| --- | --- |
| `structure.ts`、`cache.ts` | Markdown 结构、源位置、可重建索引与缓存 |
| `positions.ts` | 锚点映射、按顺序应用人类修改、识别歧义和重叠 |
| `changes.ts` | 精确文本差异与候选定位 |

批注原始目标和 Change 原范围保留。展示位置可随正文重算。重复片段无法可靠区分、目标删除或同位置竞争时，返回定位状态或冲突，由[服务](../../apps/service/README.md)决定如何处理。

用重复文本、emoji、BOM、CRLF 和重叠修改验证。见参考实现 `tests/manuscript.test.ts`、`tests/work.test.ts` 及 [A07](../../tests/README.md#a07)和 [A08](../../tests/README.md#a08)。
