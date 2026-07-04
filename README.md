# Feishu RCM Product Assistant with Memory

外置飞书长连接 bot，通过 RCM（Recursive Context Machine）和两级记忆系统（Layer A 逐字档案 + Layer B 知识层）提供有记忆的通用产品助手能力。

## 架构

```
飞书群 @bot → 飞书 WebSocket 长连接 → bot.ts → RCM accelerate dispatch/run → gh CLI → GitHub repo
                                                                    ↓
                          ┌────────────── Layer A (archive/) ──────────────┐
                          │  • 每轮问答逐字写入 archive/<chat_id>/          │
                          │  • 近期上下文（最近 5 轮）保持 prompt 精炼       │
                          │  • 默认不进 git，隐私保护                       │
                          └─────────────────────────────────────────────────┘
                                                                    ↓
                          ┌────────────── Layer B (memory/) ───────────────┐
                          │  • MEMORY.md 索引 + 结构化记忆文件              │
                          │  • 仅 memory_ingest 管道写入（单并发队列）      │
                          │  • 主 assistant 模板只读，不直接写              │
                          │  • git 版本控制，可回滚                          │
                          └─────────────────────────────────────────────────┘
                                                                    ↓
                          ┌────────── Mempalace（可选语义检索）──────────┐
                          │  • mine 命令索引 archive 目录                │
                          │  • search 命令在 prompt 中召回               │
                          │  • 无 mempalace 时降级为 grep/find          │
                          └─────────────────────────────────────────────────┘
```

## 核心概念

### Layer A — 逐字档案

- 路径：`archive/<safe_chat_id>/<date>-<message_id>.md`
- 包含 frontmatter（chat_id, message_id, reporter, time, action）和 Q/A 正文
- 每次成功回复飞书后写入
- 默认被 `.gitignore` 忽略，不进 git

### Layer B — 知识层

- 路径：`memory/` 下，`MEMORY.md` 为全局索引
- 每条记忆一个 markdown 文件，含 frontmatter
- 仅通过 `memory_ingest` 管道写入（单并发队列）
- 纳入 git 版本控制
- 索引上限 200 行，超限提示运行 `consolidate`

### Mempalace（可选）

- 安装后自动启用，提供语义检索
- 使用已核验的 `mine` / `search` 命令，不使用 `sweep`
- 无 mempalace 时降级为 `find` / `grep` 搜索

## 环境变量

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export DEEPSEEK_API_KEY="sk-xxx"
```

可选覆盖：

```bash
export TARGET_REPO="owner/repo"
export REPO_PATH="./repo"
export RCM_BIN="accelerate"
export GH_PATH_PREFIX="gh"
export RCM_RUN_TIMEOUT_SECONDS=420

# Mempalace 可选配置
export MEMPALACE_BIN=mempalace
export MEMPALACE_ENABLED=auto    # auto | true | false
export MEMPALACE_PALACE_PATH=
```

`.env` 文件也会被自动加载（参考 `.env.example`）。

## 快速开始

```bash
cd chaos
bun install

# 1. 设置环境变量（或编辑 .env）
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export DEEPSEEK_API_KEY="sk-xxx"

# 2. 启动长连接
bun run bot.ts listen

# 或测试一次
bun run bot.ts once "如何配置 provider？"
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `bun run bot.ts listen` | 启动飞书 WebSocket 长连接 |
| `bun run bot.ts once "message"` | 单次测试处理 |
| `bun run bot.ts import <file-or-url>` | 批量导入文档到 Layer A 档案 |
| `bun run bot.ts import <file-or-url> --distill` | 导入并提炼到 Layer B 知识层 |
| `bun run bot.ts consolidate` | 整理和合并记忆条目，重建索引 |

### import 命令

支持本地 markdown 文件和 HTTP(S) URL：

```bash
bun run bot.ts import ./docs/memory-design.md
bun run bot.ts import ./docs/memory-design.md --distill
```

导入过程：
1. 按 markdown 标题或空行切分 chunk（单块 ~4000 字符）
2. 每块逐字写入 `archive/imports/<source_slug>/<index>.md`
3. 启用 mempalace 时 mine 导入目录
4. `--distill` 时逐 chunk 通过 ingest 队列写入 Layer B

### consolidate 命令

```bash
bun run bot.ts consolidate
```

整理 `memory/` 下的所有记忆条目：
- 合并重复事实
- 删除或标记失效条目
- 验证引用的 GitHub issue 状态
- 重建 MEMORY.md 索引

## 目录结构

```
chaos/
├── bot.ts                  # 主入口：飞书 WS + RCM 调用 + 记忆归档
├── package.json            # bun 项目（@larksuiteoapi/node-sdk）
├── .env.example            # 环境变量模版
├── test-event.json         # 手动测试用事件
├── tsconfig.json           # TypeScript 配置
├── .gitignore              # git 忽略规则
├── lib/
│   ├── config.ts           # 配置与路径常量
│   ├── memory.ts           # 记忆系统辅助函数
│   └── rcm.ts              # RCM dispatch/run 封装
├── rcm-synergy/
│   ├── dispatch.toml       # RCM 事件路由（assistant / memory_ingest / memory_consolidate）
│   ├── .rcm-cache/         # 编译后的 .rcm + 运行日志
│   └── templates/
│       ├── assistant.rcm.tpl          # 主路由：通用产品助手
│       ├── memory_ingest.rcm.tpl      # 记忆提炼管道
│       ├── memory_consolidate.rcm.tpl # 记忆整理管道
│       └── issue_triage.rcm.tpl       # 历史备份（迁移引用）
├── memory/                 # Layer B 知识层（git 版本控制）
│   ├── README.md           # 使用说明
│   ├── MEMORY.md           # 全局索引（上限 200 行）
│   └── imported/           # import --distill 产生的知识条目
├── archive/                # Layer A 档案层（默认不进 git）
│   ├── README.md           # 使用说明
│   └── imports/            # 导入原文归档
└── README.md
```

## 隐私与 gitignore

- `archive/` 中的真实聊天和导入档案默认被 `.gitignore` 忽略
- `archive/README.md` 和 `.gitkeep` 文件保留在 git 中
- `memory/` 纳入 git 版本控制，便于回滚
- 如需备份历史档案，可 `git add -f archive/`
- mempalace palace 数据默认在 `.mempalace/`，不进 git

## 运行验证

```bash
# TypeScript 类型检查
bunx tsc --noEmit

# 手动测试一次（需要 RCM 可用）
bun run bot.ts once "测试消息"

# 批量导入测试
bun run bot.ts import ./docs/memory-design.md

# 批量导入并提炼
bun run bot.ts import ./docs/memory-design.md --distill

# 整理记忆
bun run bot.ts consolidate

# Dispatch smoke test（需要 accelerate 在 PATH）
accelerate dispatch --config rcm-synergy/dispatch.toml --event-name assistant --action feishu_message --event-path test-event.json
```

## 飞书开放平台配置

| 项 | 说明 |
|---|---|
| 机器人能力 | 必须开启 |
| 事件订阅方式 | **使用长连接接收事件** |
| 订阅事件 | `im.message.receive_v1` |
| 权限 | `im:message`、`im:message:send_as_bot` |

配置步骤：

1. 登录[飞书开发者后台](https://open.feishu.cn/app)
2. 创建企业自建应用，开启机器人能力
3. **事件与回调 > 事件配置**，编辑订阅方式，选择"使用长连接接收事件"
4. 订阅 `im.message.receive_v1` 事件
5. **权限管理**，添加 `im:message` 相关权限，发布新版本

> 注意：必须先启动 `bun run bot.ts listen` 建立 WebSocket 连接，才能在后台保存"使用长连接接收事件"。

## 回滚策略

| 组件 | 回滚方式 |
|------|---------|
| 代码 | `git revert` |
| Layer B 知识层 | 在 git 中，`git revert` 或手动编辑后重新 consolidate |
| Layer A 档案 | 删除对应 `archive/<chat>/<date>-<msgid>.md` |
| Mempalace 索引 | 删除或 repair palace 后重新 mine archive |
| Assistant 路由 | 紧急降级：改回 `issue_triage` 路由和 event name |

## 行为

- 收到消息后先读记忆和近期上下文
- 能直接回答时直接回答
- 已知问题返回 issue/PR 链接和状态
- 确认新 bug / feature / docs gap 才创建 issue
- 信息不足时追问具体字段
- 最终回复只有一句话，不暴露内部路径、token、secret、环境变量
- 成功回复后异步写档案、更新近期上下文、异步提炼记忆
- 记忆提炼通过单并发队列串行执行
- 群聊中只有被 @ 时响应
- 支持引用消息
- 消息 10 秒内有效（过滤重启后的重放）
