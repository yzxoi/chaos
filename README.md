# Chaos

[![GitHub License](https://img.shields.io/github/license/yzxoi/chaos)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/yzxoi/chaos)](https://github.com/yzxoi/chaos/commits/main)

飞书群 Synergy 项目智能助手 —— 通过 WebSocket 长连接接入飞书，基于 RCM + DeepSeek 自动处理产品反馈、Bug 追踪和功能建议。

## 能力

- **意图识别** — 自动分类 Bug、功能建议、使用问题、已知问题跟进
- **去重检查** — 创建 Issue 前查询历史，避免重复
- **代码扫描** — 自动定位相关模块和代码路径
- **记忆系统** — 沉淀产品知识，多轮对话保持上下文
- **Issue 管理** — 自动创建规范的 GitHub Issue，带标题/标签/定位信息

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：填写 FEISHU_APP_ID、FEISHU_APP_SECRET、DEEPSEEK_API_KEY

# 3. 启动
bun run bot.ts listen
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|:--:|------|
| `FEISHU_APP_ID` | ✓ | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✓ | 飞书应用 App Secret |
| `DEEPSEEK_API_KEY` | ✓ | DeepSeek API Key |
| `TARGET_REPO` | | 目标 GitHub 仓库，默认 `SII-Holos/synergy` |
| `REPO_PATH` | | 本地仓库路径，默认 `./synergy` |

## CLI

| 命令 | 说明 |
|------|------|
| `bun run bot.ts listen` | 启动 WebSocket 长连接 |
| `bun run bot.ts once "msg"` | 单次测试 |
| `bun run bot.ts import <file>` | 导入文档到知识库 |
| `bun run bot.ts consolidate` | 整理记忆条目 |

## 架构

```
飞书群 @bot → WebSocket → bot.ts → RCM (DeepSeek) → GitHub Issues
                              ├── archive/   (对话档案)
                              ├── memory/    (知识层)
                              └── mempalace  (语义检索，可选)
```

## 飞书配置

| 配置项 | 值 |
|--------|-----|
| 订阅方式 | **使用长连接接收事件** |
| 订阅事件 | `im.message.receive_v1` |
| 权限 | `im:message`、`im:message:send_as_bot` |

## License

MIT
