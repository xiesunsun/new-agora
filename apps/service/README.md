# 本地服务

服务拥有工作正文、版本、审阅、队列和文件结算。领域与应用层通过端口访问存储和文件桥。HTTP 与桌面入口使用相同的业务裁决。

| 参考实现入口（相对 `next/`） | 职责 |
| --- | --- |
| `apps/service/src/core/application/documents.ts` | 导入、正文保存、独立版本确认、历史恢复 |
| `apps/service/src/core/domain/review.ts`、`apps/service/src/core/application/reviews.ts` | 审阅依据、等待条件、逐项决定与明确确认 |
| `apps/service/src/core/application/work.ts` | 原子批注与排队、领取、候选登记、文件计划、结算和恢复 |
| `apps/service/src/files/local-files.ts` | 文件读取、串行替换、读回与文件回执 |
| `apps/service/src/http/documents-server.ts`、`apps/service/src/storage/migrations/` | HTTP 接入与版本化 SQLite 结构 |

批注、排队记录和命令回执在同一事务保存。每文档最多一个运行中或待核对的执行，以及一个开放文件计划。规范路径的绑定保持唯一。服务重启保留原执行、文件计划与身份，待核对的工作继续占用执行槽位。

审阅 token 覆盖文档、冻结正文和成员。决定校验当前正文、token 与原 Change，处理依赖和过期范围。确认校验正式版本及工作结算，在同一事务写入版本、决定和回执。文件对齐标记只在实际读回与目标相符，且计划仍覆盖当前待同步内容时清除。

维护保护正式版本、工作正文、检查点、保留动作的基底和活动恢复依据。已结算记录满足条件后可收缩详情，保留去重身份。收缩回执返回 `already_processed` 与 `detailsAvailable=false`。未知回执格式阻止相关清理。可选业务历史裁剪仍是历史设计项。

验证入口为参考实现的 `tests/documents.test.ts`、`tests/work.test.ts`、`tests/reviews.test.ts`、`tests/maintenance.test.ts` 和[验收场景](../../tests/README.md)。
