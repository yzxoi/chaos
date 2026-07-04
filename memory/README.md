# memory/ — Layer B 知识层

## Schema

每条记忆是一个独立的 markdown 文件，遵循以下 schema：

```yaml
---
title: <简短标题>
created: <ISO 8601 时间戳>
updated: <ISO 8601 时间戳>
source: <来源标识：chat / import:<source> / consolidate>
tags: [<tag1>, <tag2>]
---
```

正文使用自由 markdown 格式，保持简洁准确。

## 索引规则

- `MEMORY.md` 是全局索引，每行一条，格式为 `- [<title>](<relative-path>)`。
- 索引行数上限 200 条。超过 200 时运行 `bun run bot.ts consolidate`。
- 新增记忆时，先搜索索引和已有文件避免重复。
- 更新已有事实时更新原文件及索引，不新建。

## 写入策略

- 仅 `memory_ingest` 和 `memory_consolidate` 管道写入。
- 所有写入通过单并发队列串行执行，避免并发覆盖。
- 主 assistant 模板只有读权限，不允许写 memory。

## 回滚方式

- memory 纳入 git 版本控制，错误写入可 `git revert` 回滚。
- 也可手动编辑后重新运行 `consolidate` 重建索引。

## 目录结构

```
memory/
├── README.md         # 本说明
├── MEMORY.md         # 全局索引（上限 200 行）
├── imported/         # import --distill 产生的知识条目
└── <topic>.md        # 按主题组织的记忆文件
```
