# 绿手指 AI 客服辅助工作台

真人客服输入客户问题，系统检索业务知识并生成参考回复；客服决定采纳、调整或弃用，再自行复制发送。系统不自动联系客户。

本仓库把分散在服务器源码快照、补丁和本地工作树中的开发入口集中起来，采用 **一个仓库、两个服务** 的结构。

## 接手先读

1. [当前状态与待办](docs/STATUS.md)：已完成什么、还有什么缺口。
2. [架构说明](docs/ARCHITECTURE.md)：模块如何配合、功能应该改在哪里。
3. [开发与运行](docs/RUNBOOK.md)：依赖、配置、数据库、启动与验证。
4. [知识资料说明](knowledge/README.md)：数据来源、上线准备和用途约束。
5. [代码来源](docs/PROVENANCE.md)：本仓库如何从历史代码整理而来。

## 目录

| 目录 | 用途 |
|---|---|
| `web/` | Next.js 页面、登录、账号管理、反馈与历史记录 API；测试在 `web/tests/` |
| `agent/` | Python/FastAPI 检索、提示词和模型调用；测试在 `agent/tests/` |
| `database/` | 工作台建表与增量迁移 |
| `knowledge/` | 离线知识准备及校验脚本、资料交接说明 |
| `ops/` | 既有服务器检查、备份校验工具；历史配置需按运行手册调整 |
| `docs/` | 架构、运行手册、已知问题、资料来源 |

## 版本与边界

- 功能基线：`workbench-adjustments-20260918-v1`，支持最多 3 次成功调整。
- 本仓库是 **2026-09-28 根据本地备份和 9 月 18 日源码快照重组的开发副本**，不是当天线上完整镜像。
- 9 月 28 日 SSH 与 HTTP 连接未成功，未确认线上此刻状态、未导出当天数据库。
- 最近记录的线上知识版本：`knowledge-2026-09-05-v2`。`knowledge-prepared-20260915` 尚未完成生产适配和向量化。
- 本仓库不含生产 `.env`、密钥、账号口令、真实聊天或数据库备份；完整业务资料另见交接资料包。

## 本次验证

Web：86 项测试通过，TypeScript 检查通过。Agent：63 项中 61 通过、2 失败，详见 [状态说明](docs/STATUS.md)。新知识准备包的文件哈希、SQLite 完整性、来源关联和向量队列约束通过。未调用付费模型，未执行生产数据库恢复演练。

## 快速开始

推荐 Node.js 24、pnpm 10.5.1、Python 3.12、PostgreSQL + pgvector。模拟测试不需要生产密钥；完整生成回复需要数据库知识和可用模型密钥。

```powershell
cd web
npx --yes pnpm@10.5.1 install --frozen-lockfile
npx --yes pnpm@10.5.1 test
```

```powershell
cd agent
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-handoff-lock.txt
.venv/Scripts/python.exe -m pip install --no-deps -e .
.venv/Scripts/python.exe -m pytest tests/unit_tests tests/integration_tests -q
```

完整启动见运行手册。旧 `index.html + local_server.py` 本地原型不作为本仓库入口。
