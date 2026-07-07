# Chaos

[![GitHub License](https://img.shields.io/github/license/yzxoi/chaos)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/yzxoi/chaos)](https://github.com/yzxoi/chaos/commits/main)

多平台群聊智能助手 —— 接入飞书 / QQ 群，基于 RCM + DeepSeek 自动处理产品反馈、Bug 追踪和功能建议。

## 能力

- **意图识别** — 自动分类 Bug、功能建议、使用问题、已知问题跟进
- **去重检查** — 创建 Issue 前查询历史，避免重复
- **代码扫描** — 自动定位相关模块和代码路径
- **记忆系统** — 沉淀产品知识，多轮对话保持上下文
- **Issue 管理** — 自动创建规范的 GitHub Issue，带标题/标签/定位信息
- **多平台** — 统一管道，飞书和 QQ 共享同一套编排逻辑和记忆

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：填写 FEISHU_APP_ID、FEISHU_APP_SECRET、DEEPSEEK_API_KEY、GITHUB_TOKEN

# 3. 启动
bun run bot.ts listen
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|:--:|------|
| `FEISHU_APP_ID` | ✓ | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✓ | 飞书应用 App Secret |
| `DEEPSEEK_API_KEY` | ✓ | DeepSeek API Key |
| `GITHUB_TOKEN` | ✓ | GitHub Personal Access Token（`repo` scope） |
| `TARGET_REPO` | | 目标 GitHub 仓库，默认 `SII-Holos/synergy` |
| `REPO_PATH` | | 本地仓库路径，默认 `./synergy` |
| `PLATFORMS` | | 启用的平台，逗号分隔，默认 `feishu`（可选 `qq`） |
| `QQ_BRIDGE_PORT` | | QQ 桥接端口，默认 `18080` |

## 架构

```
┌──────────────────────────────────────────────────┐
│              bot.ts（平台无关编排层）               │
│   去重 → 时效检查 → RCM → 回复 → 归档 → 记忆提炼   │
└──────┬───────────────────────┬───────────────────┘
       │                       │
  platform-feishu.ts     platform-qq.ts
   Lark WebSocket         HTTP :18080
       │                       │
       │               astrbot-plugin-chaos
    飞书群                    │
                          QQ 群
```

| 层 | 说明 |
|----|------|
| `lib/platform.ts` | `PlatformAdapter` 接口定义 |
| `lib/platform-feishu.ts` | 飞书适配器（WS 长连接 + 消息解析） |
| `lib/platform-qq.ts` | QQ HTTP 桥接适配器 |
| `lib/dispatch.ts` | RCM 模板引擎 + `accelerate run` 调度 |
| `lib/memory.ts` | 双层记忆系统（Archive + Memory） |

## CLI

| 命令 | 说明 |
|------|------|
| `bun run bot.ts listen` | 启动所有已启用的平台适配器 |
| `bun run bot.ts once "msg"` | 单次测试 |
| `bun run bot.ts import <file>` | 导入文档到知识库 |
| `bun run bot.ts consolidate` | 整理记忆条目 |

## 平台配置

### 飞书

| 配置项 | 值 |
|--------|-----|
| 订阅方式 | **使用长连接接收事件** |
| 订阅事件 | `im.message.receive_v1` |
| 权限 | `im:message`、`im:message:send_as_bot` |

启用方式：`.env` 中 `PLATFORMS=feishu`

### QQ（AstrBot）

1. 在 `.env` 中设置 `PLATFORMS=feishu,qq`
2. 将 `astrbot-plugin-chaos/` 复制到 AstrBot 的 plugins 目录
3. 重启 Chaos 和 AstrBot
4. 群聊中 @bot 即可触发

## License

MIT
