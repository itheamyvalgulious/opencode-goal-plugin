// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * opencode-goal-plugin — TUI plugin
 *
 * - /goal slash command (interactive):
 *     /goal {text}   → LLM extracts 实现要求/验收要求, shown for confirmation
 *                      and editing, then activated on the server
 *     /goal          → shows current goal status
 *     /goal pause | resume | clear
 * - Sidebar (sidebar.content slot): goal status, goal content (collapsed by
 *   default), latest progress (expanded by default); sections toggle on click.
 *
 * Data comes from the GoalRpc RPC surface of the server plugin; updates arrive
 * through the RPC "updated" event. Rendered with OpenTUI primitives so no JSX
 * transform is required.
 */

import type { Plugin as TuiPluginNS } from "@opencode/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { GoalRpc } from "./rpc.ts"
import type { GoalRecord, GoalStatus } from "./rpc.ts"

// ── Constants ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<GoalStatus, string> = {
  activated: "activated",
  paused: "paused",
  complete: "complete",
  impossible: "impossible",
}

const WRAP_COLUMNS = 44

// ── Element helpers ───────────────────────────────────────────────────────

type ElementChild = string | number | boolean | null | undefined | object | (() => ElementChild)

const element = (tag: string, props: Record<string, unknown>, children: ElementChild[] = []) => {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value)
  }
  // Insert the complete child list in one Solid operation: calling insert()
  // per child without an anchor makes the reconciler replace siblings.
  insert(node, children)
  return node
}

const text = (props: Record<string, unknown>, children: ElementChild[] = []) =>
  element("text", props, children)

const box = (props: Record<string, unknown>, children: ElementChild[] = []) =>
  // Non-painting, content-sized: the host owns the panel background/layout.
  element("box", { shouldFill: false, flexGrow: 0, ...props }, children)

// ── Theme helpers ─────────────────────────────────────────────────────────

export type Palette = {
  text: unknown
  textMuted: unknown
  error: unknown
  warning: unknown
  success: unknown
}

export const isColorLike = (value: unknown): boolean => {
  if (typeof value === "string" || typeof value === "number") return true
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    return typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number"
  }
  return false
}

const getPath = (root: Record<string, unknown>, path: readonly string[]): unknown => {
  let cur: unknown = root
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

const resolveLeaf = (
  root: Record<string, unknown>,
  paths: readonly (readonly string[])[],
  mode: "dark" | "light",
): unknown => {
  for (const path of paths) {
    let v = getPath(root, path)
    if (v === undefined || v === null) continue
    if (typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      if ("dark" in o || "light" in o) {
        v = o[mode] ?? o.dark ?? o.light
        if (v === undefined || v === null) continue
      }
    }
    if (isColorLike(v)) return v
  }
  return undefined
}

export const paletteOf = (theme: unknown, mode: "dark" | "light"): Palette => {
  const root = (theme && typeof theme === "object" ? theme : {}) as Record<string, unknown>
  const current = root.current
  const map = (
    current && typeof current === "object" ? (current as Record<string, unknown>) : root
  ) as Record<string, unknown>
  const pick = (paths: readonly (readonly string[])[]): unknown => resolveLeaf(map, paths, mode)
  const base = pick([
    ["text", "base"],
    ["text"],
    ["text", "default"],
  ])
  return {
    text: base,
    textMuted: pick([["text", "muted"], ["textMuted"], ["text", "subdued"]]) ?? base,
    error: pick([["text", "feedback", "error"], ["error"]]) ?? base,
    warning: pick([["text", "feedback", "warning"], ["warning"]]) ?? base,
    success: pick([["text", "feedback", "success"], ["success"]]) ?? base,
  }
}

const statusColor = (pal: Palette, status: GoalStatus): unknown => {
  switch (status) {
    case "activated":
      return pal.warning
    case "complete":
      return pal.success
    case "impossible":
      return pal.error
    default:
      return pal.textMuted
  }
}

// ── Text formatting ───────────────────────────────────────────────────────

const clip = (value: unknown, max: number): string => {
  const s = String(value ?? "")
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

const charWidth = (ch: string): number => {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x1100 && (
    code <= 0x115f || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals .. Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6)
  )
    ? 2
    : 1
}

/** Display-width aware line wrap for the narrow sidebar. */
const wrapText = (s: unknown, columns = WRAP_COLUMNS): string => {
  const out: string[] = []
  for (const rawLine of String(s ?? "").split("\n")) {
    let line = rawLine.replace(/\s+$/, "")
    if (!line.trim()) {
      out.push("")
      continue
    }
    while (true) {
      let width = 0
      let cut = 0
      for (const ch of line) {
        width += charWidth(ch)
        if (width > columns) break
        cut += ch.length
      }
      if (width <= columns) {
        out.push(line)
        break
      }
      out.push(line.slice(0, cut))
      line = line.slice(cut)
    }
  }
  return out.join("\n")
}

const fmtTime = (ts: number | null | undefined): string => {
  if (!ts) return ""
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── Slots ─────────────────────────────────────────────────────────────────

type SlotProps = { sessionID: string }
type SlotRender = (props: SlotProps) => unknown
type SlotDispose = () => void

const noopDispose: SlotDispose = () => {}

function registerSlotV2(context: TuiPluginNS.Context, name: string, render: SlotRender): SlotDispose {
  const slot = context.ui.slot as unknown as (...args: unknown[]) => unknown
  const dispose = slot.length <= 1 ? slot({ append: name, render }) : slot(name, render)
  return typeof dispose === "function" ? (dispose as SlotDispose) : noopDispose
}

// ── Sidebar ───────────────────────────────────────────────────────────────

/** Per-session expand/collapse signals, persisting across remounts. */
type ToggleState = {
  contentOpen(): boolean
  progressOpen(): boolean
  toggleContent(): void
  toggleProgress(): void
}
const toggleStates = new Map<string, ToggleState>()

const toggleState = (sessionID: string): ToggleState => {
  let state = toggleStates.get(sessionID)
  if (!state) {
    const [contentOpen, setContentOpen] = createSignal(false) // goal content: collapsed by default
    const [progressOpen, setProgressOpen] = createSignal(true) // latest progress: expanded by default
    state = {
      contentOpen,
      progressOpen,
      toggleContent: () => setContentOpen((v) => !v),
      toggleProgress: () => setProgressOpen((v) => !v),
    }
    toggleStates.set(sessionID, state)
  }
  return state
}

function GoalSidebar(context: TuiPluginNS.Context, props: SlotProps) {
  const rpc = context.client.rpc(GoalRpc)

  const [goal, setGoal] = createSignal<GoalRecord | null>(null)

  let alive = true
  let fetching = false
  let refetchQueued = false

  const fetchGoal = async (targetSessionID: string) => {
    if (!alive || !targetSessionID) return
    if (fetching) {
      refetchQueued = true
      return
    }
    fetching = true
    try {
      const out = (await rpc.state({ sessionID: targetSessionID })) as { goal: GoalRecord | null }
      if (alive) setGoal(out?.goal ?? null)
    } catch {
      // server plugin not loaded — keep showing the last state
    } finally {
      fetching = false
      if (alive && refetchQueued) {
        refetchQueued = false
        void fetchGoal(props.sessionID)
      }
    }
  }

  createEffect(() => {
    const id = props.sessionID
    if (id) void fetchGoal(id)
  })

  // Server-side state changes (goal lifecycle, progress sweep, prompts).
  const offEvent = rpc.events.on("updated", (ev) => {
    if (ev.data?.sessionID === props.sessionID) void fetchGoal(props.sessionID)
  })

  // Session lifecycle for instant reactive updates.
  const eventCleanups: Array<() => void> = []
  if (context.data?.on) {
    const onEvent = () => {
      void fetchGoal(props.sessionID)
    }
    eventCleanups.push(
      context.data.on("session.idle", onEvent),
      context.data.on("session.execution.succeeded", onEvent),
      context.data.on("session.execution.failed", onEvent),
      context.data.on("session.status", onEvent),
    )
  }

  onCleanup(() => {
    alive = false
    offEvent()
    for (const dispose of eventCleanups) dispose()
  })

  const modeOf = (): "dark" | "light" => (context.themeMode === "light" ? "light" : "dark")
  const livePalette = (): Palette => paletteOf(context.theme, modeOf())

  return box({}, [
    () => {
      const g = goal()
      if (!g) return null
      const pal = livePalette()
      const st = toggleState(props.sessionID)

      const header = box({ width: "100%", overflow: "hidden" }, [
        text(
          { fg: statusColor(pal, g.status), bold: true },
          [`◆ Goal · ${STATUS_LABEL[g.status] ?? g.status}`],
        ),
        text(
          { fg: pal.textMuted },
          [`  turns:${g.turns} stops:${g.stops} verify:${g.verifications}${g.gateRejections ? ` 初筛退回:${g.gateRejections}` : ""}${g.progressAt ? ` · 进度 ${fmtTime(g.progressAt)}` : ""}`],
        ),
        text(
          { fg: pal.textMuted },
          [
            `  ${phaseLabel(g)}${g.verifyModel ? ` · 验收 ${g.verifyModel}` : ""}`,
          ],
        ),
      ])

      const contentToggle = text(
        { fg: pal.text, onMouseDown: () => st.toggleContent() },
        [st.contentOpen() ? "▾ Goal 内容" : "▸ Goal 内容"],
      )
      const contentBody = st.contentOpen()
        ? [
            text({ fg: pal.textMuted }, [wrapText(`实现要求:\n${g.impl}`)]),
            text({ fg: pal.textMuted }, [wrapText(`验收要求:\n${g.accept}`)]),
          ]
        : []

      const progressToggle = text(
        { fg: pal.text, onMouseDown: () => st.toggleProgress() },
        [st.progressOpen() ? "▾ 最新进度" : "▸ 最新进度"],
      )
      const progressBody = st.progressOpen()
        ? [
            g.progress
              ? text({ fg: pal.textMuted }, [wrapText(g.progress)])
              : text({ fg: pal.textMuted }, ["(暂无进度报告)"]),
            g.closeReason
              ? text({ fg: pal.textMuted }, [wrapText(`结论: ${clip(g.closeReason, 400)}`)])
              : null,
          ]
        : []

      return box(
        { width: "100%", overflow: "hidden", flexDirection: "column", paddingLeft: 0 },
        [
          header,
          contentToggle,
          ...contentBody,
          progressToggle,
          ...progressBody,
        ].filter((child) => child !== null && child !== undefined),
      )
    },
  ])
}

// ── Scrollable dialog ─────────────────────────────────────────────────────

/**
 * The host's dialog.alert renders its message as one unclipped text node, so a
 * long goal/acceptance is cut off and cannot be scrolled. Long content is shown
 * through dialog.show() with our own scrollbox instead.
 */
type ScrollNode = {
  scrollBy?: (delta: number, unit?: string) => void
  scrollTo?: (position: number) => void
  focus?: () => void
}

type ScrollDialogState = { scroll?: ScrollNode; finish?: () => void }
const scrollDialog: ScrollDialogState = {}

type ScrollDialogOptions = {
  title: string
  body: string
  hint?: string
  size?: "medium" | "large" | "xlarge"
}

const closeScrollDialog = () => {
  scrollDialog.scroll = undefined
  scrollDialog.finish = undefined
}

const renderScrollDialog = (
  context: TuiPluginNS.Context,
  opts: ScrollDialogOptions,
  finish: () => void,
): JSX.Element => {
  const pal = paletteOf(context.theme, context.themeMode === "light" ? "light" : "dark")
  const terminalHeight = (): number => {
    const h = (context.renderer as unknown as { height?: number } | undefined)?.height
    return typeof h === "number" && h > 0 ? h : 32
  }
  const viewport = Math.max(8, Math.floor(terminalHeight() * 0.68) - 6)
  const scroll = element(
    "scrollbox",
    {
      maxHeight: viewport,
      flexShrink: 1,
      contentOptions: { minHeight: 0 },
      scrollbarOptions: { visible: true },
      horizontalScrollbarOptions: { visible: false },
      scrollX: false,
    },
    [
      box({ paddingRight: 1 }, [
        text({ fg: pal.textMuted, wrapMode: "char" }, [opts.body]),
      ]),
    ],
  )
  scrollDialog.scroll = scroll as ScrollNode
  // Focus makes ↑/↓/pageup/pagedown work even without the keymap layer.
  setTimeout(() => {
    try {
      ;(scroll as ScrollNode).focus?.()
    } catch {
      /* focus is best effort */
    }
  }, 0)
  return box({ width: "100%", flexDirection: "column", gap: 1 }, [
    box({ flexDirection: "row", justifyContent: "space-between", flexShrink: 0 }, [
      text({ fg: pal.text, bold: true }, [opts.title]),
      text({ fg: pal.textMuted, onMouseUp: finish }, ["esc"]),
    ]),
    scroll,
    text({ fg: pal.textMuted }, [opts.hint ?? "↑/↓ 翻页滚动 · pgup/pgdn · enter 关闭"]),
  ]) as unknown as JSX.Element
}

/** Shows a scrollable, full-content dialog and resolves when it is closed. */
const showScrollDialog = (
  context: TuiPluginNS.Context,
  opts: ScrollDialogOptions,
): Promise<void> =>
  new Promise<void>((resolve) => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onClose = () => {
      closed = true
      if (timer) clearTimeout(timer)
      closeScrollDialog()
      resolve()
    }
    const finish = () => {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      closeScrollDialog()
      // dialog.clear() fires the onClose callback above, which resolves us.
      context.ui.dialog.clear()
    }
    scrollDialog.finish = finish
    context.ui.dialog.show(() => renderScrollDialog(context, opts, finish), onClose)
    // show() resets the dialog size to "medium"; widen it once it is active.
    timer = setTimeout(() => {
      if (closed) return
      context.ui.dialog.set({ size: opts.size ?? "xlarge" })
    }, 0)
  })

/** Scroll/close keybindings for the scrollable dialogs (modal, passive). */
const scrollDialogCommands = [
  {
    bind: "up",
    title: "Goal dialog: scroll up",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.scroll) return false
      scrollDialog.scroll.scrollBy?.(-1)
      return
    },
  },
  {
    bind: "down",
    title: "Goal dialog: scroll down",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.scroll) return false
      scrollDialog.scroll.scrollBy?.(1)
      return
    },
  },
  {
    bind: "pageup",
    title: "Goal dialog: previous page",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.scroll) return false
      scrollDialog.scroll.scrollBy?.(-10)
      return
    },
  },
  {
    bind: "pagedown",
    title: "Goal dialog: next page",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.scroll) return false
      scrollDialog.scroll.scrollBy?.(10)
      return
    },
  },
  {
    bind: "home",
    title: "Goal dialog: scroll to top",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.scroll) return false
      scrollDialog.scroll.scrollTo?.(0)
      return
    },
  },
  {
    bind: "end",
    title: "Goal dialog: scroll to bottom",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.scroll) return false
      scrollDialog.scroll.scrollTo?.(Number.MAX_SAFE_INTEGER)
      return
    },
  },
  {
    bind: "return",
    title: "Goal dialog: close",
    group: "Dialog",
    run: () => {
      if (!scrollDialog.finish) return false
      scrollDialog.finish()
      return
    },
  },
]

// ── /goal command flow ────────────────────────────────────────────────────


const currentSessionID = (context: TuiPluginNS.Context): string | undefined => {
  try {
    const route = context.ui.router.current() as { type?: string; sessionID?: string }
    if (route?.type === "session" && route.sessionID) return route.sessionID
  } catch {
    /* ignore */
  }
  return undefined
}

const VERIFY_SOURCE_LABEL: Record<string, string> = {
  option: "配置指定",
  session: "随主会话",
  // legacy records from the auto-selection era
  default: "默认模型",
  agent: "验收 agent 模型",
  auto: "自动选择",
}

const phaseLabel = (g: GoalRecord): string => {
  if (g.status === "complete") return "已完成"
  if (g.status === "impossible") return "已判定不可能"
  if (g.status === "paused") return "已暂停"
  if (g.phase !== "verifying") return "执行中"
  if (g.verifyStage === "gate") return "验收初筛中(读交付说明)"
  return g.verifyClaim === "impossible" ? "不可能性裁决中" : "详细验收中"
}

const goalSummary = (g: GoalRecord): string =>
  [
    `状态: ${STATUS_LABEL[g.status] ?? g.status}${g.closeReason ? ` (${clip(g.closeReason, 200)})` : ""}`,
    `阶段: ${phaseLabel(g)}`,
    `自动续行: ${g.turns} 次 · 停下: ${g.stops} 次`,
    `独立验收: ${g.verifications} 次(未通过 ${g.verifyFailures} · 初筛退回 ${g.gateRejections ?? 0} · 无结论 ${g.verifyErrors})`,
    `验收模型: ${g.verifyModel ?? "(未解析)"}${
      g.verifyModelSource ? ` · ${VERIFY_SOURCE_LABEL[g.verifyModelSource] ?? g.verifyModelSource}` : ""
    }`,
    "",
    "实现要求:",
    g.impl,
    "",
    "验收要求:",
    g.accept,
    "",
    g.progress ? `最新进度 (${fmtTime(g.progressAt)}):\n${g.progress}` : "暂无进度报告",
  ].join("\n")

const CONTROL_ACTIONS = new Set(["pause", "resume", "clear"])

async function handleGoalCommand(context: TuiPluginNS.Context, raw: string) {
  const rpc = context.client.rpc(GoalRpc)
  const sessionID = currentSessionID(context)
  if (!sessionID) {
    context.ui.toast.show({ title: "Goal", message: "需要在一个会话中运行 /goal", variant: "error" })
    return
  }
  const arg = raw.trim()

  // /goal — status view
  if (!arg) {
    try {
      const out = (await rpc.state({ sessionID })) as { goal: GoalRecord | null }
      await showScrollDialog(context, {
        title: "Goal 状态",
        body: out?.goal
          ? goalSummary(out.goal)
          : "当前会话没有 goal。\n\n用法:\n/goal <目标描述> — 设定 goal(描述需包含如何实现与如何验收)\n/goal pause | resume | clear — 控制 goal",
      })
    } catch (e) {
      context.ui.toast.show({ title: "Goal", message: `读取状态失败: ${String((e as Error)?.message ?? e)}`, variant: "error" })
    }
    return
  }

  // /goal pause | resume | clear
  const lower = arg.toLowerCase()
  if (CONTROL_ACTIONS.has(lower)) {
    try {
      const out = (await rpc.control({ sessionID, action: lower as "pause" | "resume" | "clear" })) as {
        ok: boolean
        message: string
      }
      context.ui.toast.show({ title: "Goal", message: out.message, variant: out.ok ? "success" : "error", duration: 4000 })
    } catch (e) {
      context.ui.toast.show({ title: "Goal", message: `操作失败: ${String((e as Error)?.message ?? e)}`, variant: "error" })
    }
    return
  }

  // /goal {text} — extract, confirm, activate
  context.ui.toast.show({ title: "Goal", message: "正在提取实现要求与验收要求…", variant: "info" })
  let extracted: { impl: string; accept: string }
  try {
    const out = (await rpc.extract({ sessionID, text: arg })) as {
      ok: boolean
      impl?: string
      accept?: string
      error?: string
    }
    if (!out?.ok || !out.impl || !out.accept) {
      context.ui.toast.show({ title: "Goal", message: `提取失败: ${out?.error ?? "未知错误"}`, variant: "error", duration: 6000 })
      return
    }
    extracted = { impl: out.impl, accept: out.accept }
  } catch (e) {
    context.ui.toast.show({ title: "Goal", message: `提取失败: ${String((e as Error)?.message ?? e)}`, variant: "error" })
    return
  }

  // Confirmation / editing loop
  for (;;) {
    await showScrollDialog(context, {
      title: "Goal 提取结果",
      hint: "↑/↓ 滚动 · enter 关闭 · 关闭后选择 激活 / 修改 / 取消",
      body: `【实现要求(如何实现)】\n${extracted.impl}\n\n【验收要求(如何验收)】\n${extracted.accept}`,
    })
    const choice = await context.ui.dialog.select({
      title: "确认 Goal",
      placeholder: "选择操作",
      options: [
        { title: "确认并激活", value: "activate", description: "goal 进入 activated 状态并开始执行" },
        { title: "修改实现要求", value: "editImpl", description: clip(extracted.impl, 100) },
        { title: "修改验收要求", value: "editAccept", description: clip(extracted.accept, 100) },
        { title: "取消", value: "cancel", description: "不创建 goal" },
      ],
    })
    if (!choice || choice === "cancel") return
    if (choice === "editImpl" || choice === "editAccept") {
      const isImpl = choice === "editImpl"
      const value = await context.ui.dialog.prompt({
        title: isImpl ? "修改实现要求" : "修改验收要求",
        description: "输入替换后的完整内容(留空取消修改)",
        value: isImpl ? extracted.impl : extracted.accept,
      })
      if (value != null && value.trim()) {
        if (isImpl) extracted.impl = value.trim()
        else extracted.accept = value.trim()
      }
      continue
    }
    // activate
    try {
      const out = (await rpc.activate({
        sessionID,
        impl: extracted.impl,
        accept: extracted.accept,
      })) as { ok: boolean; message: string }
      context.ui.toast.show({ title: "Goal", message: out.message, variant: out.ok ? "success" : "error", duration: 6000 })
    } catch (e) {
      context.ui.toast.show({ title: "Goal", message: `激活失败: ${String((e as Error)?.message ?? e)}`, variant: "error" })
    }
    return
  }
}

// ── Toasts on goal lifecycle changes ──────────────────────────────────────

const toastForReason = (
  reason: string,
): { message: string; variant: "success" | "warning" | "error" } | undefined => {
  if (reason === "complete") return { message: "Goal 已完成并通过独立验收", variant: "success" }
  if (reason === "impossible") return { message: "Goal 被独立复核判定为不可能完成", variant: "error" }
  if (reason === "auto-paused") return { message: "Goal 已自动暂停(连续失败)", variant: "warning" }
  if (reason === "execution-failed") return { message: "Goal 会话执行失败,将自动重试", variant: "error" }
  return undefined
}

// ── Plugin definition ─────────────────────────────────────────────────────

export default {
  id: "goal.tui",
  setup(context) {
    // Sidebar
    const offSidebar = registerSlotV2(context, "sidebar.content", (props) =>
      GoalSidebar(context, props),
    )

    // /goal slash command
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "goal.command",
          title: "Goal: 设定/控制持久目标",
          slash: { name: "goal", arguments: true },
          run: (input?: string) => {
            void handleGoalCommand(context, input ?? "").catch((e: unknown) => {
              context.ui.toast.show({ title: "Goal", message: `命令出错: ${String((e as Error)?.message ?? e)}`, variant: "error" })
            })
          },
        },
      ],
    }))

    // Scroll/close bindings for the scrollable goal dialogs. They only act when
    // one of our dialogs is open and otherwise fall through to other layers.
    context.keymap.layer(() => ({
      mode: "modal",
      priority: 2,
      commands: scrollDialogCommands,
    }))

    // Lifecycle toasts (complete / impossible / auto-paused / execution failed)
    const rpc = context.client.rpc(GoalRpc)
    const offUpdated = rpc.events.on("updated", (ev) => {
      const toast = toastForReason(String(ev.data?.reason ?? ""))
      if (!toast) return
      const sessionID = typeof ev.data?.sessionID === "string" ? ev.data.sessionID : undefined
      context.ui.toast.show({
        title: "Goal",
        message: toast.message,
        variant: toast.variant,
        duration: 6000,
        ...(sessionID ? { sessionID } : {}),
      })
    })

    return () => {
      offSidebar()
      offUpdated()
    }
  },
} satisfies TuiPluginNS.Definition
