# 开发、运行与恢复

## 先选目的

- 看代码、修改页面、跑程序测试：只需仓库、Node.js 和 Python。
- 本地完整查询：还需要 PostgreSQL + pgvector、知识数据和模型 API 密钥。
- 接管已有线上服务：先取得服务器访问权限和最新备份，不要用本地历史库覆盖线上。

以下命令从仓库根目录执行或按 `cd` 进入相应目录。Windows 使用 PowerShell，Linux 将 `.venv/Scripts/python.exe` 换为 `.venv/bin/python`。

## 依赖与模拟测试

本次使用 Python 3.12、pnpm 10.5.1；生产历史记录为 Node 24。Web 锁文件与 Python `requirements-handoff-lock.txt` 为本次新生成的验证环境锁定，并非线上依赖清单。

```powershell
cd web
npx --yes pnpm@10.5.1 install --frozen-lockfile
npx --yes pnpm@10.5.1 test
npx --yes pnpm@10.5.1 exec tsc --noEmit
npx --yes pnpm@10.5.1 build
cd ../agent
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-handoff-lock.txt
.venv/Scripts/python.exe -m pip install --no-deps -e .
.venv/Scripts/python.exe -m pytest tests/unit_tests tests/integration_tests -q
```

Agent 当前预期会报告 STATUS.md 中两项失败，不能视为环境搭错。不要改跑旧 90 道业务评测。

## 数据库：新建隔离开发库

安装与备份兼容的 PostgreSQL（建议先核实生产版本）和 pgvector 扩展。以下在本机管理员 psql 会话执行；密码用 psql 的交互命令输入：

```sql
CREATE ROLE aiuser LOGIN;
\password aiuser
CREATE DATABASE ai_cs_dev OWNER aiuser;
\connect ai_cs_dev
CREATE EXTENSION IF NOT EXISTS vector;
```

再以 `aiuser` 连接 `ai_cs_dev`，按顺序执行 `database/001_workbench_v2.sql` 至 `004_reply_adjustments.sql`。例如在仓库根目录：

```powershell
psql -h 127.0.0.1 -U aiuser -d ai_cs_dev -v ON_ERROR_STOP=1 -f database/001_workbench_v2.sql
psql -h 127.0.0.1 -U aiuser -d ai_cs_dev -v ON_ERROR_STOP=1 -f database/002_system_version.sql
psql -h 127.0.0.1 -U aiuser -d ai_cs_dev -v ON_ERROR_STOP=1 -f database/003_user_display_name.sql
psql -h 127.0.0.1 -U aiuser -d ai_cs_dev -v ON_ERROR_STOP=1 -f database/004_reply_adjustments.sql
```

空表可以用于页面/账号开发；**没有激活且有向量的知识，不能完整生成回复**。已有资料恢复到另一套全新开发库更容易复现旧行为，见下一节。本次没有在本机实际安装 PostgreSQL 或完成数据库恢复演练。

## 从历史 dump 恢复

完整资料包含 `archive/workspace/backups/local-handoff-20260824T055001Z/linglongzivectordb_v2.dump` 和原始 `manifest.json`。先验证其 SHA256，使用相同或更新且兼容的 pg_restore。

恢复到**空的隔离库**，不要先建业务表；pgvector 需在服务器上可安装：

```powershell
pg_restore --list PATH_TO_DUMP
pg_restore --exit-on-error --no-owner --no-acl -h 127.0.0.1 -U aiuser -d ai_cs_dev PATH_TO_DUMP
```

`aiuser` 需要创建该备份要求的扩展权限，或由管理员预装扩展后确认恢复步骤。数据库所有者/授权与旧服务器不同，必须检查实际错误，不能忽略失败。恢复后按实际结构补执行 `002`、`003`、`004`，核实知识版本、表数量和向量字段。

8 月 dump 不包含后续新增反馈或 9 月知识。最新备份需要服务器恢复连接后另取，不能用这个历史库回滚当前唯一线上库。

## 账号与本地配置

复制 `web/.env.example` 为 `web/.env.local`；复制 `agent/.env.example` 为 `agent/.env`。

| 位置 | 变量 | 含义 |
|---|---|---|
| Web | `DATABASE_URL` | 本地 PostgreSQL 连接串 |
| Web / Agent | `WORKBENCH_AGENT_TOKEN` | 两端完全相同的随机内部口令，至少 16 字符 |
| Agent | `POSTGRES_URI_CUSTOM` | 指向同一个业务库的连接串 |
| Agent | `DASHSCOPE_API_KEY` | 百炼密钥；当前生成和向量共用 |
| Agent | `DASHSCOPE_BASE_URL` | 生成接口，默认中国区兼容接口 |
| Agent | `MODEL_VERSION` | 默认 `qwen-plus` |

密码中的 `@`、`:` 等字符需做 URL 编码。查询向量适配器仍固定使用百炼 `text-embedding-v4` 和对应接口；改生成 base URL 不会自动改向量提供商。

恢复库中已有账号；如果需要新开发管理员，见 `web/scripts/create-dev-admin.mjs`。它只允许本机 `ai_cs_dev`，不修改已有账号。给 `.env.local` 临时增加 `DEV_ADMIN_USERNAME`、`DEV_ADMIN_PASSWORD`（至少 12 位）后：

```powershell
cd web
node --env-file=.env.local scripts/create-dev-admin.mjs
```

成功后从 `.env.local` 移除这两个临时管理员字段。正式同事账号由工作台管理员页面创建，不共享生产管理员密码。

## 启动

第一个终端：

```powershell
cd agent
.venv/Scripts/python.exe -m uvicorn api.app:app --host 127.0.0.1 --port 2124
```

第二个终端：

```powershell
cd web
npx --yes pnpm@10.5.1 dev --hostname 127.0.0.1 --port 3100
```

打开 `http://127.0.0.1:3100/login`。Agent `/health` 反映配置、数据库和知识可读性；不代表付费模型实际可用。生成和调整会调用模型，需有可用公司账户。

## 服务器运行与回退

历史新服务：Web `/root/apps/linglongzi-agent-chat-ui-v2`，PM2 `workbench-web-v2`，3100；Agent `/root/apps/linglongzi-new-langgraph-templete-python-v2`，PM2 `workbench-agent-v2`，2124；数据库 `linglongzivectordb_v2`。原 3000/2024 服务保留。

两服务 `ecosystem.config.cjs` 是历史部署配置，包含原服务器路径、`.env.v2`、`uv run`、日志目录；搬到新机器前逐项适配。`ops/server_inventory.py` 默认代理和本机凭据路径也需调整，不能视为开箱即用部署器。

恢复连接后先只读执行 `pm2 ls`、两仓库 `git status --short` / `git rev-parse HEAD`、Agent `/health`、登录页 HTTP 检查和有效知识版本查询；不要通过 `pm2 env` 把密钥打印到记录中。

9 月 18 日发布前备份路径为 `/root/backups/ai-customer-service/20260918-before-adjustments`，旧构建另在 Web 的 `.next.before-adjustments-20260918`。当前交接尚未下载该备份。回退应恢复对应源码/构建、保留新增调整表与上线后业务记录，不直接恢复整库抹掉后续记录。

源码从本仓库重新构建后先放隔离目录测试，复核差异、做备份后再切换新版服务。已有发布脚本含固定白名单和时间戳，仅供历史参考，不直接重复执行。
