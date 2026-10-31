# opencode-goal-plugin

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](./LICENSE)
[![OpenCode v2](https://img.shields.io/badge/OpenCode-v2-black)](https://opencode.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://www.typescriptlang.org)

OpenCode v2 的持久 **Goal 模式** 插件。设定目标时同时说明「如何实现」与「如何验收」; 插件持续驱动会话工作, 直到
**常驻独立验收 agent** —— 执行会话看不到、也影响不了的另一会话 —— 真正判定通过。

[English](./README.md) | 简体中文

## 它做什么

`/goal` 把一段自由描述变成两部分明确契约 —— *实现要求* 与 *验收要求* —— 由模型提取、以可编辑弹窗供你确认。激活后,
goal 会话每次停下, 插件都会判断这次停止、跑一轮验收, 然后带着验收反馈继续执行, 或把 goal 关闭为完成 / 不可能。

执行模型从不被要求评判自己的工作。

## 特性

- **两段式目标契约** — 实现要求 + 验收要求, 由 LLM 提取, 开始前人工确认。
- **自动续行循环** — activated 状态下每次停下都决定: 继续、验收还是结束。
- **常驻独立验收会话** — 每个 goal 只创建一个子会话, 所有轮次复用, 拥有独立上下文、独立 agent 与可选专用模型;
  write 类权限被拒绝。
- **两阶段验收** — 先做零工具的「交付说明初筛」, 只有说明声称完成或不可能时才进入详细核对。
- **不可能性裁决** — "不可能"的论证会被独立核实, 不会照单全收。
- **虚假停止抑制** — 输出过少的停止视为误停, 直接续行。
- **进度报告** — 周期性生成 btw 风格摘要(transient 生成, 不写入上下文)。
- **保护阈值** — 连续验收 / prompt / 执行失败自动暂停, 避免死循环。
- **重启恢复** — 活跃 goal 持久化并恢复; 在途验收会重新挂接。
- **多实例安全** — storage 是唯一权威源; 每个 location 只有一个 leader 驱动 goal。
- **TUI 侧边栏** — 状态、阶段、要求与最新进度, 分区可折叠, 长内容可滚动。

## 环境要求

- 支持插件与 TUI 的 OpenCode v2。按 `@opencode/plugin` 2.0.18 开发, 在 OpenCode 2.2.3 上测试。
- 一个 subagent 型 agent 供验收会话使用(默认 `general`)。
- `/goal` 命令依赖 TUI 插件, 随本包一起通过 `./tui` 导出加载。

## 安装

### 从 GitHub 安装

```bash
opencode plugin add github:itheamyvalgulious/opencode-goal-plugin
opencode reload
```

### 带配置安装

`opencode plugin add` 写入的是纯字符串条目。需要传 options 时, 请在 `~/.config/opencode/opencode.json` 中改用对象
形式 —— 不要同时保留两个条目:

```jsonc
{
  "plugins": [
    {
      "package": "github:itheamyvalgulious/opencode-goal-plugin",
      "options": {
        "verify_model": "anthropic/claude-opus-4-6",
        "verify_agent": "general",
        "verify_timeout_minutes": 30
      }
    }
  ]
}
```

### 本地克隆安装

```bash
git clone https://github.com/itheamyvalgulious/opencode-goal-plugin.git \
  ~/.config/opencode/plugins/opencode-goal-plugin
```

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.config/opencode/plugins/opencode-goal-plugin",
      "options": { "verify_model": "anthropic/claude-opus-4-6" }
    }
  ]
}
```

## 用法

| 命令 | 作用 |
| --- | --- |
| `/goal <目标描述>` | 提取实现要求与验收要求, 弹窗展示供确认/修改, 确认后激活 goal。描述里应写清**如何实现**与**如何验收**。 |
| `/goal` | 查看当前 goal: 状态、统计、阶段、要求与最新进度。长内容在可滚动弹窗中展示。 |
| `/goal pause` | 暂停循环(`paused`)。 |
| `/goal resume` | 恢复暂停的 goal(`activated`)。 |
| `/goal clear` | 删除本会话的 goal。 |

Goal 状态: `activated`、`paused`、`complete`、`impossible`。

## 执行循环

goal 处于 `activated` 时, 会话每次 settle(停下)插件都会处理:

1. **虚假停止判定** — 停下输出的非空白字符少于 `min_text_chars` 时, 视为误停(例如高推理档产出空轮), 直接续行。
2. **验收轮** — 否则由该 goal 的常驻验收员执行两阶段验收:
   - **第 1 步 — 交付说明初筛。** 验收员只读执行 agent 的最后一条输出(交付说明), 不使用任何工具。
     - 说明承认还有未完成项 / 遗留问题 / 待办 → 直接 `FAIL`, 把说明发回继续修, **不进入**详细核对。
     - 说明主张目标不可能并给出理由 → 第 2 步进入**不可能性裁决**。
     - 说明声称已完成 → 第 2 步进入**详细验收**。
   - **第 2 步 — 详细核对。** 验收员读取工作目录、必要时运行命令, 逐项核对实现要求与验收要求。它可以复用此前轮次
     的结论, 但被改动过的证据必须重新检查。
     - `VERDICT: PASS` → goal 变为 `complete`。
     - `VERDICT: FAIL` → 结论发回执行会话, 继续完善。
     - `VERDICT: IMPOSSIBLE` → goal 变为 `impossible`。
3. **不可能性轮次** — 验收员独立确认约束是否真实、是否存在可行路径。只有论证成立才可回答 `IMPOSSIBLE`; 否则回答
   `FAIL` 并指出可行方向, 让执行会话继续尝试, 而不是重复"不可能"。
4. **无结论** — 超时、崩溃或格式不符记为一次验收失败, 会话继续。连续 `max_verify_errors` 次失败后自动暂停, 避免
   死循环。
5. **进度报告** — 每隔 `progress_interval_minutes` 基于会话上下文用 transient 生成(不写入对话历史)产出 200–300 字
   进度摘要。
6. **重启恢复** — server 重启或插件重载后恢复全部 activated goal。在途验收重新挂接并消费其结论; 丢失的当前步骤在
   同一验收会话中重发。

### 验收的独立性

- 验收员是 goal 会话的 OpenCode 子会话, 每个 goal 只创建一次、**所有轮次复用**, 因此保有对工作区的连贯记忆, 不必
  每轮从头重读。
- 独立会话、独立上下文、独立 agent; 执行 agent 看不到审查提示词, 也不会被要求自查。
- write 类工具(`write` / `edit` / `patch`)被拒绝: 验收员只检查、不修改; 审查提示词也禁止改动工作区。
- 模型**不自动挑选**: 配置了 `verify_model` 就用它, 否则与主会话同模型。该模型在验收会话创建时固定。验收的独立性
  来自独立会话/上下文与只读权限, 而不是换模型。

## 侧边栏

`sidebar.content` 槽位显示:

- goal 状态(`activated` / `paused` / `complete` / `impossible`)与统计;
- 当前阶段 —— 执行中、初筛、详细验收、不可能性裁决 —— 与验收模型;
- Goal 内容(实现要求 + 验收要求), 默认折叠, 点击展开;
- 最新进度, 默认展开, 点击折叠。

## 配置

通过插件条目(`plugins[].options`)传入:

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `verify_model` | 同主会话 | 验收模型, `provider/model` 或 `provider/model#variant`; 留空则与主会话模型相同。 |
| `verify_agent` | `general` | 常驻验收会话使用的 OpenCode agent。 |
| `verify_timeout_minutes` | `30` | 单个验收阶段超时(分钟)。 |
| `max_verify_errors` | `2` | 连续「验收无结论」次数上限, 超出自动暂停。 |
| `progress_interval_minutes` | `10` | 进度报告间隔(分钟)。 |
| `min_text_chars` | `20` | 虚假停止判定的非空白字符阈值。 |
| `max_prompt_failures` | `3` | 连续 prompt 失败次数上限, 超出自动暂停。 |
| `max_exec_failures` | `3` | 连续执行失败次数上限, 超出自动暂停。 |
| `max_turns` | `0`(不限) | 自动续行次数上限, 超出自动暂停。 |

## 持久化与多实例安全

- goal 状态保存在插件 storage 的 `goals.v2` 下, 是唯一权威源; 所有修改都是读-改-写。
- host 为每个 location 各加载一个插件实例, 且 location reload 后旧世代实例可能不被销毁。每个 location 通过 storage
  心跳(3 秒间隔, 12 秒失联)选举 leader: 新世代立即接管, 死掉的 leader 会被顶替; 只有「本 location 的 leader 且
  拥有该会话」的实例驱动循环。
- RPC(`extract` / `activate` / `control`)直写 storage, 因此在任意实例上都可用。
- 验收开始前, 先把 phase 原子地置为 `verifying` 并记录阶段, 因此并发 settle 或插件重载都不会重复验收。
- 验收会话 ID 持久化, 恢复时重新挂接; `lastVerifyAt` 保证没有新输出的重复 settle 不会再触发验收。

## 排障

- **`/goal` 不可用** — TUI 插件没加载。检查 `opencode plugin list` 与插件条目, 然后 `opencode reload`。
- **goal 像卡住了** — 查看 `/tmp/opencode/goal-diag.log`, 其中记录 settle、prompt、persist、leadership 与 verdict
  事件。
- **验收员不能改文件** — 这是设计: write 类权限被拒绝, 验收员不能"顺手修好"它正在审查的东西。
- **验收一直失败** — 连续 `max_verify_errors` 次后 goal 会自动暂停; 修好根因(或调整验收配置)后 `/goal resume`。
- **要换新目标** — `complete` 与 `impossible` 是终态, 先 `/goal clear`。

## 文件

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 服务端插件: 执行循环、常驻验收(初筛 + 详细验收)、进度扫描、重启恢复、RPC。 |
| `tui.ts` | TUI 插件: `/goal` 命令(提取 → 确认 → 激活)、可滚动弹窗、侧边栏、生命周期 toast。 |
| `rpc.ts` | 共享 RPC 契约(`extract` / `activate` / `control` / `state` + `updated` 事件)。 |
| `prompts.ts` | 全部面向 LLM 的提示词。 |

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
```

没有构建步骤 —— 插件宿主直接消费 TypeScript 源码。本地开发时把插件配置指向本目录, 然后执行 `opencode reload`。

## 许可证

GPL-3.0-only, 见 [LICENSE](./LICENSE)。
