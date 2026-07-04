# archive/ — Layer A 档案层

包含逐字聊天档案和导入原文。

## 目录结构

```
archive/
├── README.md              # 本说明
├── <safe_chat_id>/        # 按聊天会话组织的档案
│   ├── <yyyy-mm-dd>-<safe_message_id>.md
│   └── recent.md          # 近期上下文（最近 5 轮）
└── imports/               # 批量导入原文归档
    ├── <source_slug>/
    │   └── <chunk_index>.md
    └── README.md
```

## 隐私与 gitignore

- `archive/` 中的真实逐字内容默认被 `.gitignore` 忽略，不进 git。
- `archive/README.md` 和 `.gitkeep` 文件保留在 git 中。
- 如需备份历史，可手动 `git add -f archive/` 或导出。
