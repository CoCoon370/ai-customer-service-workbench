# 代码来源与交接口径

此仓库为开发入口，不覆盖原项目、不合并原目录未提交变更，也未部署到线上。

| 部分 | 来源 |
|---|---|
| Web 骨架、配置、许可证 | 完整 `web-input-dda7f4c.bundle` 叠加增量 `web-ime-enter-fix.bundle` 至 `9c0a7a52ced156cd664a0c54d1cd6741c997275e` |
| Agent 骨架、配置、许可证 | 完整 `agent-semantic-9d3fe68.bundle`，提交 `9d3fe68241250ac184eba945d669a870d15fa529` |
| 当前 src/tests/package 配置 | `integration_contracts/reply-adjustment-20260917` 快照，含 9 月 18 日功能 |
| SQL 与运维 | `server-deployment` 工作树及调整迁移 |
| 知识准备 | 9 月 15 日构建/校验脚本；仅增加资料根目录配置入口 |

Web 增量 bundle 不能单独 clone，需要先恢复完整前置 bundle。完整交接包保留二者及来源映射。

同类完整快照中已不存在的旧源文件未沿用，其余工程资源从基线补齐。9 月线上完整依赖锁文件本地未找到，因此本次安装依赖后生成锁文件，记录的是 **本次交接验证环境**，不是生产依赖快照。

原本地仓库所有可达分支历史在完整包 `git-history/local-all-branches.bundle`；另有工作区快照、各工作树、未提交脚本/补丁及服务器历史 bundle。新 GitHub 仓库从整理基线开始，不上传旧业务数据与凭据历史。

上游许可证保留在 `web/LICENSE`、`agent/LICENSE`。业务内容的授权不因上游许可证改变。
