# 代码分工

面板收集用户的批注和审阅选择。本地服务保存本轮底稿、Codex 交回的待审稿和历史版本。桌面插件按 Markdown 路径打开项目，拥有项目租约和正式服务子进程，并把生成任务交给当前 Codex 对话。Codex 写待审文件，用户点应用后由本地服务写回原文件。

```mermaid
flowchart LR
    Panel[共用面板] -->|读取状态与提交操作| Transport[PanelTransport]
    Transport -->|浏览器：本机 HTTP| Service[本地服务]
    Transport -->|桌面：宿主转发工具调用| Plugin[MCP 插件进程]
    Plugin -->|本机 HTTP| Service
    Plugin -.->|按项目启动并在宿主断开后回收| Service
    Adapter[桌面面板适配器] -->|生成获受理后通知当前对话| Host[Codex]
    Adapter -->|挂载| Panel
    Host -->|领取与提交| Plugin
    Host -->|编辑| Candidate[待审 Markdown]
    Candidate -->|提交后读取并比较底稿| Service
    Service -->|差异与应用结果| Panel
    Service -->|用户应用后写入并读回| File[原 Markdown]
    Service --> Versions[历史版本]
```

| 问题 | 负责的部分 |
| --- | --- |
| 怎么保存输入、看差异、改变选择？ | [面板](../apps/panel/README.md) |
| 怎么保存本轮内容、写回原文件、登记版本？ | [本地服务](../apps/service/README.md) |
| 怎么让当前对话拿到任务并提交待审稿？ | [桌面插件](../plugins/desktop/README.md) |
| 怎么用配置模拟 Codex 改稿？ | [开发场景](../dev/mock/README.md)和[脚本执行器](../apps/worker/README.md) |
| 怎么传数据和计算差异？ | [接口约定](../packages/contracts/README.md)和[文本工具](../packages/text/README.md) |

本轮底稿可能包含还未写到磁盘的人类编辑。生成差异时用底稿比较，应用后读回原文件核对写入结果。实际领到任务后才显示正在改稿。

项目身份由 Markdown 的规范路径决定。面板和执行分别携带项目身份，切换路径不会重定向旧面板或旧执行。项目数据跨宿主重启保留；进程和活动对话的租约由插件连接拥有。桌面默认入口自动管理服务，显式外部连接仅用于联调。具体配置和关闭边界见[桌面接入](../plugins/desktop/README.md)。

这些目录是根 npm 包中的源码模块，当前不分别安装或发布。`apps/worker` 目前只提供开发用的脚本执行器，不是独立的生产 agent 服务。目录层次与命名规则见[仓库与命名约束](repository-workflow.md#源码层次与命名)。

## 面板与开发场景

浏览器与桌面宿主使用同一套面板。PanelTransport 保持异步读取与命令边界。面板控制器管理输入缓冲、命令顺序和临时显示状态，服务管理已确认的工作稿、任务、审阅、写入证据与版本。

面板内的持久原生编辑器拥有选区、组合输入和撤销，源码快照负责将编辑投影回 Markdown。安全阅读与完整 Markdown 审阅复用结构解析和源码区间，审阅选择仍由服务裁决。它们都属于现有面板模块，不新增文稿或版本的持久化写入方。具体文件职责、源码保留范围与恢复行为见[面板](../apps/panel/README.md)。

生成、审阅和保存都携带身份。停止后结果发布失效，执行结束未知时仍保留原执行记录。写入成功回执携带原操作与输入来源，不能把较晚的工作稿标为已保存。版本采用分别记录工作稿基点与最新磁盘版本。

mock 使用独立配置和启动入口，复用真实服务。脚本执行器领取真实任务、修改真实候选文件并提交，写回只落在临时文稿副本。示例、规则与失败配置不进入生产面板。原型 notebook、浏览器模拟原文件和历史 schema 迁移不成为第二份业务实现。

[开发运行资源](../dev/runtime/README.md)统一分配 mock 与测试的受管目录，由创建者释放或记录保留原因。它不持有文稿业务状态，也不清理用户显式指定的文件或运行目录。

[接入取舍](decisions/ink-integration.md) · [接入证据](../evidence/ink-integration/README.md)
