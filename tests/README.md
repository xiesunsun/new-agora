# Agora 验收场景

先用固定的待审稿验证面板和服务，再用真实 Codex 桌面版跑 [A01](#a01) 和 [A03](#a03)。每次用临时 Markdown 和独立运行目录。记录构建、入口、实际结果和证据。旧构建结果见[历史证据](../evidence/README.md)。

A01、A03 和 A10 是首版闭环的关键验收。其他场景随对应能力验证。A12 属于后续维护。

## 覆盖与运行入口

`pnpm test` 构建后递归执行全部 `.test.mjs`，`pnpm test:browser` 只递归执行浏览器目录。下表用测试名的前缀定位用例，具体断言以链接的测试为准。“自动”表示已有对应回归，不代表每条人工步骤或真实宿主已验收；本轮运行结果记录在所属任务证据中。

| 场景 | 自动测试位置与用例 | 测试文稿或数据 | 人工验收边界 |
| --- | --- | --- | --- |
| [A01](#a01) 完整闭环 | [a01.test.mjs](a01.test.mjs)：`A01 keeps a selected suggestion` | [原稿](fixtures/a01/original.md)、[预期结果](fixtures/a01/expected.md)、[开发配置](../dev/mock/a01.json) | 自动覆盖真实服务、MCP 领取提交和写回；实际安装的 Codex 宿主仍需人工完成 |
| [A02](#a02) 重复请求 | [a01.test.mjs](a01.test.mjs)：`A01 keeps a selected suggestion`；[服务测试](manuscript-service.test.mjs)：`legacy successful apply receipts` | 测试创建的独立副本和操作编号 | 自动覆盖重放与版本唯一性；按下文步骤补核对各类相同编号、不同内容请求 |
| [A03](#a03) 对话归属 | [a01.test.mjs](a01.test.mjs)：`A01 keeps a selected suggestion`；[宿主边界](desktop-host.test.mjs)：`desktop wakes each queued generation` | A01 副本、测试对话身份和 SDK 边界替身 | 部分自动；真实对话忙碌、通知、切换对话与宿主文件工具需人工验收 |
| [A04](#a04) 工作稿恢复 | [控制器测试](panel-controller.test.mjs)：`a failed save preserves composer`；[浏览器测试](browser/panel.test.mjs)：`exact editor preserves mixed raw separators` | 用例内的工作稿、失败响应和重开副本 | 自动覆盖输入保留、阻止生成与重开；系统输入法单列人工观察 |
| [A05](#a05) 审阅恢复 | [服务测试](manuscript-service.test.mjs)：`manuscript service refuses undecided apply`、`legacy persisted review IDs and unknown timestamps` | 用例内底稿、候选、选择和重启数据库 | 自动覆盖服务重启、原范围与选择保持；桌面面板重新加载另按 A09 核对 |
| [A06](#a06) 中断与迟到结果 | [服务测试](manuscript-service.test.mjs)：`cancelled claimed execution blocks`、`restart preserves unknown execution gate`；[mock 测试](mock.test.mjs)：`stopping a claimed scripted worker` | 用例内候选、执行编号与重启副本 | 自动覆盖协议状态；实际 Codex 进程停止与工具行为需人工观察 |
| [A08](#a08) 文本边界 | [文本测试](text.test.mjs)：`review units preserve BOM`、`comment anchors shift by UTF16`；[浏览器测试](browser/panel.test.mjs)：`exact editor maps` | 用例内重复文本、emoji、BOM、混合换行 | 自动覆盖正反选区、位置映射和写回保真；系统输入法硬件行为单列 |
| [A09](#a09) 重开面板 | [服务测试](manuscript-service.test.mjs)：`manuscript service refuses undecided apply`；[浏览器测试](browser/panel.test.mjs)：`exact editor preserves mixed raw separators` | 用例内保存状态与重新打开的副本 | 部分自动；真实 Codex 面板在等待及审阅中的重新加载需人工验收 |
| [A10](#a10) 写入恢复 | [a01.test.mjs](a01.test.mjs)：`an interrupted apply stays pending`；[服务测试](manuscript-service.test.mjs)：`recheck retains unrelated disk evidence`；[控制器测试](panel-controller.test.mjs)：`a late apply receipt` | 用例内权限故障副本、原操作编号与目标正文 | 自动覆盖恢复、外部冲突和迟到回执；权限故障用例以普通用户执行 |
| [A11](#a11) 历史继续写作 | [服务测试](manuscript-service.test.mjs)：`history adoption switches working base`、`adoption persistence failure`；[浏览器测试](browser/panel.test.mjs)：`all-discarded review of an unedited adopted version` | 用例内 V1、V2、工作稿与磁盘基点 | 自动覆盖历史基点、持久化失败和保存权限；真实宿主操作可达性人工核对 |
| [A12](#a12) 后续维护 | 尚无该能力的完整验收用例 | 待设计的数据清理和回执收缩夹具 | 后续维护，未实现的能力不计为已覆盖 |
| [A13](#a13) 面板与异步输入 | [控制器测试](panel-controller.test.mjs)：`queued saves capture immutable inputs`、`rapid choices serialize canonical revisions`；[浏览器测试](browser/panel.test.mjs)：`panel preserves note IME`、`normal-motion choice animates` | 用例内延迟响应、组合事件及 1280/760/390 视口 | 自动覆盖浏览器组合事件和交互；真实系统输入法仍需人工验收 |
| [A14](#a14) 独立 mock | [mock 测试](mock.test.mjs)：`two configured mocks use isolated manuscripts`；[边界测试](mock-architecture.test.mjs)：`production panel cannot import mock configuration` | 用例内两个配置、[书店场景](../dev/mock/bookstore.json) | 自动覆盖独立副本、正式服务和保存版本；不能代替 A01/A03 的真实宿主验收 |
| [A15](#a15) 桌面项目生命周期 | [桌面项目测试](desktop-projects.test.mjs)：`desktop projects`、`desktop parent death`、`a service child crash`；[宿主边界](desktop-host.test.mjs) | 构建后的完整插件包、独立 Markdown 副本与状态根 | 自动覆盖服务拥有、项目隔离、重开、父进程强制退出和子服务崩溃；真实 app 关闭和通知仍需安装构建观察 |

原生编辑的源码投影见[编译回归](browser/manuscript-source.test.mjs)，组合输入、过期替换和初始化卸载见[生命周期回归](browser/manuscript-lifecycle.test.mjs)。[面板回归](browser/panel.test.mjs)覆盖清空后空格与换行、链接修改和撤销、恢复入口、富 Markdown 审阅及已验证保存的反馈。检查使用真实依赖与构建，物理输入法和宿主通知另列人工结果。

夹具、启动诊断及等待规则见[测试辅助](support/README.md)。测试工具本身的反例位于 [tooling](tooling/test-isolation.test.mjs)，不与产品场景编号混用。

## A01

在仓库根目录运行 `pnpm dev`，打开终端打印的 Agora 地址。命令从[原稿夹具](fixtures/a01/original.md)创建临时 Markdown 副本。脚本执行器通过与桌面插件相同的接口领取、编辑并提交待审稿。`pnpm test` 另从构建后的服务入口校验写回结果，预期正文见[结果夹具](fixtures/a01/expected.md)。真机入口见[桌面测试构建](../plugins/desktop/README.md)。

**生成、选取、一次应用。** 用标题「方案」和两个相隔的段落「本周完成初稿」「周五前交付」作为原文件和 V1。留下两条批注，再把标题改为「交付方案」，在标题尚未保存时点 **生成修改建议**。检查点击前 Codex 没有收到改稿任务，点击后先保存最新输入，再交出任务。

点生成后，从当前 Codex 对话领取同一轮。待审稿含新标题。分别把两段改成「周四上午完成初稿」和「下周一交付」，提交待审稿。检查原文件仍等于 V1，面板只展示这两处建议。保留第一处，舍弃第二处。应用预览应显示「交付方案」「周四上午完成初稿」「周五前交付」。此时历史仍只到 V1。

点一次 **保存**。检查原文件和 V2 均等于预览，面板在读回核对和版本登记完成后才显示 **已写入原文件 · V2**。历史差异包含标题和初稿时间的变化。重复应用相同正文，仍只有 V2。

## A02

**重复请求。** 分别重发开始生成、提交待审稿和应用的同一请求。检查只有一个有效执行、一份已保存候选和一次生效的应用。相同编号但内容不同的请求被拒绝。

## A03

**当前对话领取。** 当前 Codex 忙时点击生成，检查界面显示等待。重复通知和尝试领取只产生一次有效执行。切换到其他对话，检查它无法领取或提交。旧通知抵达时不能开启第二次执行。在真实宿主上检查正常编辑只发生在待审路径。

## A04

**工作稿恢复。** 保存一处人类编辑和一条未提交生成的批注。重开面板，检查输入仍在，原文件未写回，Codex 尚未收到改稿任务。再编辑一处并让开始生成前的保存失败，检查输入仍在、界面提示重试、任务未交给 Codex。仅应用人工编辑时也要核对原文件并保存版本。

## A05

**审阅恢复。** 保存一项选择后重开，检查待审稿和选择恢复，预览仍由同一份底稿算出。重新选择时预览随之更新。应用前原文件和版本保持在上一保存状态。

## A06

**生成中断与迟到结果。** 在 Codex 写待审稿时中断。检查面板保留工作稿和批注，显示待核对。确认原执行结束后才允许重试或全新生成。停止只撤销候选结果的发布权限，不声称终止外部 Codex。结束未知的状态必须在服务重启后继续保留。迟到提交或匹配执行的结束报告可提供结束证据，不能发布已取消的结果。原执行迟到提交不能替换新的待审稿。没有差异时显示 **没有新建议**。

## A08

**选区与文本边界。** 用重复文本、emoji、BOM、CRLF 与混合 LF/CRLF 验证批注选区与实际差异。先检查普通需求文稿正常显示并可直接编辑标题、列表和行内格式，再选字点批注，核对原始 UTF-16 起止位置与 quote。选中的 quote 必须与原文切片一致。另用含惰性 HTML 的副本进入例外的 **编辑原文** 模式，通过可见按钮和快捷键批注，继续核对原始字节、换行与焦点恢复。普通编辑不得统一重写其他完整结构的换行或源码。位置无法可靠对应时提示重新选择；被编辑结构的规范化范围以[面板契约](../apps/panel/README.md)为准。

[浏览器回归](browser/panel.test.mjs)的 `Markdown` 用例还覆盖 setext 标题、分隔线、删除线、实体、表格、代码围栏和嵌套引用链接。重复的引用前缀与转义内容分别核对，不能用相似文字猜测源位置。原始 HTML 不执行、危险地址不成为链接；未知片段的显示不能改写正文。

## A09

**重开面板。** 分别在等待和已有待审稿时重开。检查恢复到相应状态，已保存的选择仍可查看。重开不会替用户重新执行生成或应用。

## A10

**应用中断与恢复。** 在记录写入目标后、文件写入前中断，检查历史仍显示上一版本。另测文件已等于目标但版本未登记的情况，恢复时读回原文件并补记一次版本。恢复前确认旧写入已停止。无法核对时保持待核对状态。另让旧应用的成功响应迟于一次新的工作稿编辑，检查响应只确认原操作，新的编辑仍显示待写入。

## A11

**历史浏览与继续写作。** 先完成 A01，再切换查看 V1 和 V2，比较人类编辑与已应用建议。回到当前文稿，检查工作稿和已保存选择仍在。查看历史不会写文件或新增版本。点从此版继续写只切换工作稿基点。未保存正文、批注或审阅结果需要后果确认，取消保持原样。确认后仍不写磁盘、不新增版本，后续真正编辑才可保存。服务拒绝过期切换，持久化失败时保留原稿与协作上下文。

## A12

**后续维护。** 设计数据清理和回执收缩时，验证版本正文、未完成写入所需的记录和用于识别重复应用的编号仍可读取。

## A13

**面板交互与异步输入。** 在真实构建中用选区笔尖和快捷键写批注。检查正向与反向选区、中文输入法、换行、取消与删除确认、焦点返回。编辑原句使意见失去定位，检查意见保留且阻止生成，重新关联后恢复。服务保存失败时保留输入，不能交出生成任务。

生成标题改写、句内增删、完整句子与段落增删。每项使用真实服务的修改编号。选择后收起，页边页签可回看和改选。回看不改变选择、待选数量、保存权限或版本。未选完时保存不可用。全部保留原文后，保存人类编辑仍保留批注。

用延迟响应验证打字期间保存返回、旧轮询、过期确认和旧写入回执。较晚输入不能被覆盖或错误标为已保存。分别在 1280、760、390 宽度和减少动态效果偏好下验证操作可达、行框位置与历史返回。

全选删除后输入普通文字、空格和换行，检查始终可编辑、选区前缀仍可批注，撤销恢复原稿，保存重开后空段落与链接地址保留。核对隐藏的原生菜单不占据布局，批注完成后旧选区笔尖不覆盖页边标记。用纯强调、纯链接和完整单句修改检查审阅提取仍保留行内结构、改动标记与同一修改编号。跨引用定义合并段落无法安全保留源码时，检查原始草稿和磁盘不被覆盖，恢复副本在正文外，撤销可恢复。

## A14

**独立 mock 与正式服务。** 使用不同场景配置启动两次。检查文稿副本、数据库和执行目录彼此隔离，改稿结果与延迟由场景配置决定。同一正式面板经过领取、候选文件、提交、审阅和保存完成闭环，读回正文与正式版本一致。

生产入口指定原文件和运行目录时不启动脚本执行器。面板不加载模拟生成、原型重置或浏览器模拟文件。mock 的成功结果不能代替真实桌面宿主的 A01 与 A03 验收。

## A15

**Codex app 内的项目。** 安装[完整桌面构建](../plugins/desktop/README.md#构建和安装)，不设置外部连接，也不手动启动服务。在当前对话提供 Markdown A 的绝对路径，检查工作台打开、服务自动启动。编辑并留下批注，再打开 Markdown B，检查两份草稿、历史和原文件独立。回到 A 的旧面板生成，通知和领取须仍指向 A；切到 B 后提交 A 的执行不能改变 B。

关闭原插件连接，检查其服务退出。重开同一路径恢复进度；同一对话省略路径恢复最近项目。另一个活动对话不能读取、领取或接管 A，子服务崩溃也不能转移归属。原连接结束后，新对话可显式打开 A。分别在服务启动中和就绪后强制结束 MCP 父进程，检查子服务退出、锁释放并可重开。执行中断后仍需原项目和执行编号提供结束凭据，不能由进程退出直接清除未知门槛。
