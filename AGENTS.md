# Agora 开发入口

从 [Agora 文档](docs/README.md) 找你要改的功能。想知道 Codex 改哪份稿、用户怎么选、什么时候会保存版本，先读[生成修改建议](docs/flows/annotate-and-sync.md)和[审阅与写回](docs/flows/review.md)。

改完文档，运行 `python3 scripts/check-doc-links.py` 检查链接。验证原文件写入时，用一份测试文稿的副本。

安装依赖、运行检查和提交审阅证据，见[开发与审阅](docs/development.md)。

开工前记录已接受的基线。工作树有未提交改动时，先把文件清单和校验值保存到仓库外。并行修改前确定共享契约、文件归属和可观察的验收结果。
