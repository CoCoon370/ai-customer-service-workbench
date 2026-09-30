# 知识资料与发布边界

代码在仓库，真实资料在完整交接包。完整包中的 `archive/workspace` 保留原目录结构，让构建脚本能追溯来源。

## 关键数据入口

| 路径（相对完整交接包） | 状态/用途 |
|---|---|
| `archive/workspace/outputs/knowledge-prepared-20260915-final/` | 最新准备包入口，尚未生产适配/向量化/激活 |
| `archive/workspace/.codex-tmp/knowledge-2026-09-05-v2/` | 最近记录对应的线上知识版本资料，不是当天数据库镜像 |
| `archive/workspace/.codex-tmp/knowledge-2026-09-05-v3/` | 中间候选，不能仅按版本名字判断已上线 |
| `archive/workspace/outputs/飞书资料核读-20260905/` | 已保存的飞书文本、表格与核读材料 |
| `archive/workspace/outputs/飞书资料清洗-20260907/` | 清洗、去重和用途分类过程 |
| `archive/workspace/data/youzan/` | 历史商品采集、处理结果 |
| `external-materials/business-originals/` | 协议、客服原始材料、测试表、补充工作簿 |
| `external-materials/workbuddy/` | 早期独立探索的导出报告和 SOP |

## 9 月 15 日准备包口径

3,196 个商品、3,196 条商品片段；1,640 条知识记录，其中 171 条 `draft_evidence`、1,422 条 `staff_reference`、45 条 `question_only`、2 条 `restricted_pointer`；1,759 条来源；37 组同问异答；4,789 个待向量化任务，实际新生成向量 0。

- `draft_evidence`：可作为参考草稿依据，仍须带上条件、notes、来源，不代表已重新业务审批。
- `staff_reference`：内部经验、历史规则、可能有差异的资料；不能无条件当确定对客答案。
- `question_only`：只统计知识缺口，不进入回答依据或向量任务。
- `restricted_pointer`：仅供管理追溯，不进入对客检索。

不要把新准备 SQLite 覆盖生产 PostgreSQL，也不能把所有记录改成 approved 后塞进旧 FAQ 表。价格/在售状态均是历史快照，SKU 未提供新的完整独立明细。图片原文和例会排班按原任务要求未进入这版知识准备。

## 校验与重建

```powershell
python knowledge/scripts/verify_knowledge_release_20260915.py PATH_TO_PREPARED_PACKAGE
$env:AI_CS_KNOWLEDGE_SOURCE_ROOT='PATH_TO_HANDOFF/archive/workspace'
python knowledge/scripts/build_knowledge_release_20260915.py --output PATH_TO_NEW_EMPTY_OUTPUT
```

构建脚本从指定资料根目录读取固定来源，不调用外部模型，不修改生产库；输出目录必须不存在。默认目录为仓库 `data/source-workspace`，真实数据被 Git 忽略。

## 下一阶段发布

先从当前运行库取得新备份，建立未激活版本；按用途和商品条件适配生产表与检索流程；按文本指纹复用/生成匹配向量；验证数量、来源、权限、反馈链和业务表现后再激活，保留旧版本回退。以前的导入/向量脚本在完整包 `.worktrees/server-deployment/scripts/postgres`，包含固定旧库名、版本和 SSL 要求，不能直接执行来导入新准备包。
