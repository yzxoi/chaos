# Feishu RCM Issue Bot

外置飞书长连接 bot，通过 RCM（Recursive Context Machine）自动处理用户反馈和创建 GitHub issue。

## 架构

```
飞书群 @bot → 飞书 WebSocket 长连接 → bot.ts → RCM accelerate dispatch/run → gh CLI → GitHub repo
```

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
```

`.env` 文件也会被自动加载（参考 `.env.example`）。

## 快速开始

```bash
cd synergy-feishu-bot
bun install

# 1. 设置环境变量（或编辑 .env）
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export DEEPSEEK_API_KEY="sk-xxx"

# 2. 启动长连接
bun run bot.ts listen

# 或测试一次
bun run bot.ts once "测试消息"
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

## 目录结构

```
synergy-feishu-bot/
├── bot.ts                  # 主入口：飞书 WS + RCM 调用
├── package.json            # bun 项目（@larksuiteoapi/node-sdk）
├── .env.example            # 环境变量模版
├── test-event.json         # 手动测试用事件
├── rcm-synergy/
│   ├── dispatch.toml       # RCM 事件路由
│   ├── .rcm-cache/         # 编译后的 .rcm + 运行日志
│   └── templates/
│       └── issue_triage.rcm.tpl  # RCM LLM 提示模板
└── README.md
```

## 行为

- 收到消息后调用 RCM 分析意图
- RCM 会：
  1. 理解用户意图（bug / feature / usage / unclear）
  2. 查重 `gh issue list --repo $TARGET_REPO --state all`
  3. 只读扫描本地仓库代码
  4. 确认新问题则 `gh issue create`
  5. 回复一句话到飞书
- 群聊中只有被 @ 时响应
- 支持引用消息（自动获取被引用的原文）
- 消息 10 秒内有效（过滤重启后的重放）
