// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * opencode-goal-plugin — server plugin
 *
 * Persistent goal mode for OpenCode v2:
 *  - /goal {text}: an LLM extracts 实现要求(如何实现) and 验收要求(如何验收)
 *    from the raw text; the TUI shows both for confirmation/editing before the
 *    goal becomes "activated" (extraction + activation arrive through RPC).
 *  - Once activated, the goal session is driven by a stop-handling loop:
 *      1. a stop with < min_text_chars of non-whitespace output is treated as
 *         a false stop (high reasoning effort) and directly continued;
 *      2. otherwise a verification round starts in the goal's persistent
 *         independent reviewer (OpenCode's own session machinery: a child
 *         session reused across every round, own context, own model, read-only
 *         permissions). The executing model is never asked to judge its work:
 *           stage 1 (gate): the reviewer only reads the executor's delivery
 *             note — its last assistant output — and decides whether that note
 *             claims completion, admits unfinished work, or argues the goal is
 *             impossible; unfinished work is sent straight back (no detailed
 *             inspection);
 *           stage 2 (detail): the reviewer adjudicates the note's claim against
 *             the real workspace — a completion claim gets a full acceptance
 *             check, an impossibility claim gets an impossibility adjudication
 *             (it may answer IMPOSSIBLE only if no viable path exists) — and
 *             answers VERDICT: PASS / FAIL / IMPOSSIBLE:
 *             PASS       -> the goal is complete,
 *             FAIL       -> the verdict is fed back and the session continues,
 *             IMPOSSIBLE -> the goal is closed as impossible.
 *         The reviewer is never re-created per round (unless its session is
 *         gone), so it keeps a continuous memory of its earlier findings.
 *  - Periodically a btw-style progress report is generated transiently from
 *    the session context (session.generate: does not touch the context).
 *  - Goals persist in plugin storage; after a server restart or plugin reload
 *    every activated goal is recovered and continues executing.
 *
 * Multi-instance safety: the host keeps one plugin instance per location AND
 * leaked generations of previous plugin loads stay alive after a location
 * reload. The registry in plugin storage is therefore the single source of
 * truth, and exactly one instance per location drives goals: the one holding
 * the per-location leadership claim in storage (newest generation steals
 * leadership from older ones; dead leaders go stale and are replaced). RPC
 * mutations are storage-authoritative and work from any instance.
 *
 * Zero runtime package dependencies: only relative imports + type-only
 * external imports (plus a lazy node:fs import for the debug log).
 */

import type { Plugin } from "@opencode/plugin/promise/plugin"
import { GoalRpc } from "./rpc.ts"
import type { GoalRecord, GoalVerifyStage } from "./rpc.ts"
import { P } from "./prompts.ts"

// ── Constants ─────────────────────────────────────────────────────────────

const PLUGIN_ID = "goal.plugin"
const REGISTRY_KEY = "goals.v2"
const LEADER_KEY_PREFIX = "goals.v2.leader."
/** Dedupes settle events (execution.succeeded + session.idle double-fire). */
const SETTLE_DEBOUNCE_MS = 1500
const LEADER_HEARTBEAT_MS = 3_000
const LEADER_STALE_MS = 12_000
const EXEC_FAIL_RETRY_DELAY_MS = 30_000
const DEBUG_LOG = "/tmp/opencode/goal-diag.log"
const MAX_TIMEOUT_MS = 2_147_483_647
/**
 * The verifier may inspect anything but must never repair what it reviews.
 * Every write-class tool (write / edit / patch) asserts the "edit" permission
 * action, so denying it makes the reviewer read-only.
 */
const VERIFIER_PERMISSIONS = [{ action: "edit", resource: "*", effect: "deny" }] as const

// ── Loose shapes (defensive: the host typings drift across previews) ──────

type ModelRef = { providerID: string; id: string; variant?: string }

type ModelRefLoose = { providerID?: string; id?: string; modelID?: string; variant?: string }

type SessionInfoLoose = {
  id?: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRefLoose
  location?: { directory?: string; workspaceID?: string }
}

type SessionMessageLoose = {
  type?: string
  content?: Array<{ type?: string; text?: string }>
  time?: { created?: number; completed?: number }
}

type V2EventLoose = {
  type?: string
  data?: Record<string, unknown>
  location?: { directory?: string; workspaceID?: string }
}

type Registry = {
  goals: GoalRecord[]
  kickoffs: Array<[string, string]>
}

// ── Helpers ───────────────────────────────────────────────────────────────

const clip = (s: unknown, n = 2000): string => {
  const t = String(s ?? "").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const errMsg = (e: unknown): string => {
  if (!e) return "unknown error"
  if (typeof e === "string") return e
  const o = e as Record<string, unknown>
  return String(o.message ?? o.name ?? clip(JSON.stringify(e), 200)) || "unknown error"
}

const nonWsLength = (s: string): number => s.replace(/\s/g, "").length

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
    unrefTimer(timer)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/** Keep plugin timers from holding the process open. */
const unrefTimer = (timer: unknown): void => {
  const maybeUnref = timer as { unref?: () => void }
  if (typeof maybeUnref.unref === "function") maybeUnref.unref()
}

/**
 * Verdict line of the independent verifier subagent. Models decorate it often
 * (`**VERDICT: PASS**`, `> VERDICT: FAIL`, leading `- `), so the line only has
 * to *contain* the verdict, not start with it.
 */
const parseVerifierVerdict = (text: string): "PASS" | "FAIL" | "IMPOSSIBLE" | undefined => {
  for (const line of String(text ?? "").split("\n")) {
    if (!/verdict/i.test(line)) continue
    const m = /verdict\s*[:：]\s*[^A-Za-z]*(PASS|FAIL|IMPOSSIBLE)\b/i.exec(line)
    if (m?.[1]) return m[1].toUpperCase() as "PASS" | "FAIL" | "IMPOSSIBLE"
  }
  return undefined
}

/**
 * Stage-1 gate answer: does the executor's delivery note claim the goal is
 * finished, or argue it is impossible in principle? INCOMPLETE is checked first
 * because it contains COMPLETE.
 */
const parseGateVerdict = (text: string): "INCOMPLETE" | "COMPLETE" | "IMPOSSIBLE" | undefined => {
  for (const line of String(text ?? "").split("\n")) {
    if (!/gate/i.test(line)) continue
    const m = /\bgate\s*[:：]?\s*[^A-Za-z]*(INCOMPLETE|COMPLETE|IMPOSSIBLE)\b/i.exec(line)
    if (m?.[1]) return m[1].toUpperCase() as "INCOMPLETE" | "COMPLETE" | "IMPOSSIBLE"
  }
  const raw = String(text ?? "")
  if (/\bINCOMPLETE\b/i.test(raw)) return "INCOMPLETE"
  if (/\bIMPOSSIBLE\b/i.test(raw)) return "IMPOSSIBLE"
  if (/\bCOMPLETE\b/i.test(raw)) return "COMPLETE"
  return undefined
}

/** Best-effort JSON object extraction from an LLM reply. */
const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  const raw = String(text ?? "").trim()
  const candidates = [raw]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const first = raw.indexOf("{")
  const last = raw.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try next candidate
    }
  }
  return undefined
}

/**
 * Parse an explicit verifier model option: "provider/model" or
 * "provider/model#variant" (an object with the same fields also works).
 */
const parseModelOption = (value: unknown): ModelRef | undefined => {
  if (typeof value === "string") {
    const raw = value.trim()
    if (!raw) return undefined
    const hash = raw.indexOf("#")
    const head = hash >= 0 ? raw.slice(0, hash) : raw
    const variant = hash >= 0 ? raw.slice(hash + 1).trim() : ""
    const slash = head.indexOf("/")
    if (slash <= 0 || slash === head.length - 1) return undefined
    return {
      providerID: head.slice(0, slash).trim(),
      id: head.slice(slash + 1).trim(),
      ...(variant ? { variant } : {}),
    }
  }
  if (value && typeof value === "object") {
    const o = value as ModelRefLoose
    const id = o.id ?? o.modelID
    if (typeof o.providerID === "string" && typeof id === "string" && o.providerID && id) {
      return { providerID: o.providerID, id, ...(o.variant ? { variant: o.variant } : {}) }
    }
  }
  return undefined
}

const modelKey = (m: ModelRef | undefined): string => (m ? `${m.providerID}/${m.id}` : "")

const normalizeGoal = (raw: unknown): GoalRecord | undefined => {
  const g = raw as GoalRecord & { verifierSessionID?: string | null }
  if (!g || typeof g.sessionID !== "string" || typeof g.impl !== "string" || typeof g.accept !== "string") {
    return undefined
  }
  g.status = g.status ?? "activated"
  // Older records carried an "asking" (self-check) phase: it no longer exists.
  g.phase = g.phase === "verifying" ? "verifying" : "working"
  // The verifier used to be re-created every round; that session ID is now the
  // persistent reviewer's ID.
  g.reviewerSessionID = g.reviewerSessionID ?? g.verifierSessionID ?? null
  delete g.verifierSessionID
  g.verifyStage = g.phase === "verifying" ? (g.verifyStage === "gate" ? "gate" : "detail") : null
  g.verifyClaim = g.phase === "verifying" ? (g.verifyClaim === "impossible" ? "impossible" : "done") : null
  g.turns = g.turns ?? 0
  g.stops = g.stops ?? 0
  g.verifications = g.verifications ?? 0
  g.verifyFailures = g.verifyFailures ?? 0
  g.gateRejections = g.gateRejections ?? 0
  g.verifyErrors = g.verifyErrors ?? 0
  g.promptFailures = 0
  g.execFailures = 0
  g.verifierStartedAt = g.verifierStartedAt ?? null
  g.verifyModel = g.verifyModel ?? null
  g.verifyModelSource = g.verifyModelSource ?? null
  g.lastVerifyAt = g.lastVerifyAt ?? null
  g.kickoffSentAt = g.kickoffSentAt ?? null
  g.lastFeedback = g.lastFeedback ?? null
  return g
}

// ── Plugin ────────────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  async setup(ctx: Parameters<Plugin["setup"]>[0]) {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const progressIntervalMs = num(options.progress_interval_minutes, 10) * 60_000
    const minChars = num(options.min_text_chars, 20)
    const verifyTimeoutMs = num(options.verify_timeout_minutes, 30) * 60_000
    const maxPromptFailures = num(options.max_prompt_failures, 3)
    const maxVerifyErrors = num(options.max_verify_errors, 2)
    const maxExecFailures = num(options.max_exec_failures, 3)
    const maxTurns = typeof options.max_turns === "number" && options.max_turns > 0 ? options.max_turns : 0
    /** Subagent agent used for verification (independent session, own model). */
    const verifyAgent =
      typeof options.verify_agent === "string" && options.verify_agent.trim()
        ? options.verify_agent.trim()
        : "general"
    /** Explicit verifier model, "provider/model" or "provider/model#variant". */
    const verifyModelOption = parseModelOption(options.verify_model)

    const locationDir = ctx.location?.directory ?? "?"
    const locationKey = LEADER_KEY_PREFIX + locationDir.replace(/[^a-z0-9]/gi, "_")
    // Generation identity: newer setups steal leadership from older ones.
    const instanceId = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`
    const myGen = Date.now()

    const busySessions = new Set<string>()
    const processing = new Set<string>()
    const progressInFlight = new Set<string>()
    const lastSettleAt = new Map<string, number>()
    const execFailTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** sessionID -> {at, goal} TTL cache for the context reminder hook. */
    const hookCache = new Map<string, { at: number; goal: GoalRecord | null }>()

    let disposed = false
    let isLeader = false

    // ── Debug log (file: plugin console output is not captured by the host) ─

    const log = (message: string) => {
      try {
        const line = `[${new Date().toISOString()}] [${locationDir}] ${message}\n`
        void import("node:fs").then((fs) => {
          try {
            fs.appendFileSync(DEBUG_LOG, line)
          } catch {
            /* ignore */
          }
        })
      } catch {
        /* ignore */
      }
    }

    const logWarn = (message: string, e?: unknown) => {
      log(`WARN ${message}${e ? `: ${errMsg(e)}` : ""}`)
    }

    // ── Leadership (per location, generation-aware) ────────────────────────

    let processingLeads = false

    /**
     * Exactly one instance per location may drive goals. A newer generation
     * (plugin reload) steals leadership immediately; a leader that stops
     * heartbeating goes stale and any survivor takes over. Storage is shared
     * across instances, which makes this the coordination point.
     */
    const refreshLeadership = async (): Promise<boolean> => {
      if (disposed) return false
      try {
        const raw = (await ctx.storage.get(locationKey)) as
          | { id?: string; gen?: number; at?: number }
          | undefined
        const cur =
          raw && typeof raw.gen === "number" && typeof raw.at === "number"
            ? (raw as { id: string; gen: number; at: number })
            : undefined
        const claim = { id: instanceId, gen: myGen, at: Date.now() }
        if (!cur || cur.id === instanceId) {
          await ctx.storage.set(locationKey, claim)
          isLeader = true
        } else if (Date.now() - cur.at > LEADER_STALE_MS) {
          await ctx.storage.set(locationKey, claim)
          isLeader = true
        } else if (typeof cur.gen === "number" && cur.gen < myGen) {
          await ctx.storage.set(locationKey, claim)
          isLeader = true
        } else {
          isLeader = false
        }
        if (isLeader && !processingLeads) {
          processingLeads = true
          log(`leadership acquired (${instanceId})`)
        } else if (!isLeader && processingLeads) {
          processingLeads = false
          log(`leadership lost (${instanceId})`)
        }
      } catch (e) {
        logWarn("leadership refresh failed", e)
      }
      return isLeader
    }

    const heartbeat = setInterval(() => {
      void refreshLeadership()
    }, LEADER_HEARTBEAT_MS)
    unrefTimer(heartbeat)
    void refreshLeadership()

    // ── Registry (storage-authoritative) ───────────────────────────────────

    const readRegistry = async (): Promise<Registry> => {
      try {
        const raw = (await ctx.storage.get(REGISTRY_KEY)) as Partial<Registry> | undefined
        const goals = (raw?.goals ?? []).map(normalizeGoal).filter((g): g is GoalRecord => Boolean(g))
        const kickoffs = (raw?.kickoffs ?? []).filter(
          (pair): pair is [string, string] =>
            Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string",
        )
        return { goals, kickoffs }
      } catch (e) {
        logWarn("registry read failed", e)
        return { goals: [], kickoffs: [] }
      }
    }

    /** Read-modify-write one goal; the mutator may abort by returning false. */
    const mutateGoal = async (
      sessionID: string,
      reason: string,
      mutate: (goal: GoalRecord, kickoffs: Map<string, string>) => boolean | void,
    ): Promise<GoalRecord | undefined> => {
      try {
        const registry = await readRegistry()
        const kickoffs = new Map(registry.kickoffs)
        const index = registry.goals.findIndex((g) => g.sessionID === sessionID)
        const existing = index >= 0 ? registry.goals[index] : undefined
        if (!existing) return undefined
        const goal = existing
        if (mutate(goal, kickoffs) === false) return goal
        goal.updatedAt = Date.now()
        if (index >= 0) registry.goals[index] = goal
        await ctx.storage.set(REGISTRY_KEY, {
          goals: JSON.parse(JSON.stringify(registry.goals)),
          kickoffs: [...kickoffs.entries()],
        } as unknown as Parameters<typeof ctx.storage.set>[1])
        log(`persist(${reason}): ${goal.sessionID} -> ${goal.status}/${goal.phase} turns=${goal.turns}`)
        emitUpdated(goal.sessionID, reason)
        return goal
      } catch (e) {
        logWarn(`registry mutation failed (${reason})`, e)
        return undefined
      }
    }

    const writeRegistry = async (registry: Registry, reason: string, sessionID = "*") => {
      try {
        await ctx.storage.set(REGISTRY_KEY, {
          goals: JSON.parse(JSON.stringify(registry.goals)),
          kickoffs: registry.kickoffs,
        } as unknown as Parameters<typeof ctx.storage.set>[1])
        log(`persist(${reason}): ${registry.goals.length} goal(s)`)
        emitUpdated(sessionID, reason)
      } catch (e) {
        logWarn(`registry write failed (${reason})`, e)
      }
    }

    let rpcEvents:
      | { emit: (name: "updated", data: { sessionID: string; reason: string }) => Promise<void> }
      | undefined

    const emitUpdated = (sessionID: string, reason: string) => {
      void rpcEvents
        ?.emit("updated", { sessionID, reason })
        .catch((e: unknown) => logWarn("rpc emit failed", e))
    }

    // ── Session helpers ────────────────────────────────────────────────────

    const defaultModelRef = async (): Promise<ModelRef | undefined> => {
      try {
        const d = (await ctx.model.default()) as unknown as { data?: ModelRefLoose } | ModelRefLoose
        const m = ((d as { data?: ModelRefLoose })?.data ?? d) as ModelRefLoose
        const id = m?.id ?? m?.modelID
        if (m?.providerID && id) {
          return { providerID: m.providerID, id, ...(m.variant ? { variant: m.variant } : {}) }
        }
      } catch {
        /* no default model */
      }
      return undefined
    }

    const sessionModelRef = async (sessionID: string): Promise<ModelRef | undefined> => {
      try {
        const info = (await ctx.session.get({ sessionID })) as SessionInfoLoose
        const m = info?.model
        const id = m?.id ?? m?.modelID
        if (m?.providerID && id) {
          return { providerID: m.providerID, id, ...(m.variant ? { variant: m.variant } : {}) }
        }
      } catch {
        /* fall through to the default model */
      }
      return defaultModelRef()
    }

    /**
     * Last assistant text + completion time of a session transcript. `count`
     * is the number of assistant messages, used to tell whether a freshly
     * prompted reviewer actually produced new output.
     */
    const lastAssistant = async (
      sessionID: string,
    ): Promise<{ text: string; completedAt: number; count: number } | undefined> => {
      try {
        const messages = (await ctx.session.context({ sessionID })) as SessionMessageLoose[]
        const assistant = messages.filter((m) => m?.type === "assistant")
        const m = assistant[assistant.length - 1]
        if (!m) return undefined
        const text = (m.content ?? [])
          .filter((part) => part?.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
          .trim()
        return {
          text,
          completedAt: m.time?.completed ?? m.time?.created ?? 0,
          count: assistant.length,
        }
      } catch (e) {
        logWarn(`failed to read transcript of ${sessionID}`, e)
      }
      return undefined
    }

    /** Total assistant messages; 0 when unreadable. */
    const assistantCount = async (sessionID: string): Promise<number> => {
      try {
        const messages = (await ctx.session.context({ sessionID })) as SessionMessageLoose[]
        return messages.filter((m) => m?.type === "assistant").length
      } catch {
        return 0
      }
    }

    /**
     * True when this instance hosts the session's location. Session events are
     * delivered server-wide to every instance; only the owner may drive.
     */
    const sessionOwnership = new Map<string, boolean>()
    const ownershipInFlight = new Map<string, Promise<boolean>>()
    const locationMatches = (
      observed: { directory?: unknown; workspaceID?: unknown } | null | undefined,
    ): boolean => {
      if (!observed || !ctx.location) return false
      if (typeof observed.directory !== "string" || observed.directory !== ctx.location.directory) return false
      const own = typeof ctx.location.workspaceID === "string" ? ctx.location.workspaceID : null
      const seen = typeof observed.workspaceID === "string" ? observed.workspaceID : null
      return own === seen
    }
    const ownsSession = async (sessionID: string): Promise<boolean> => {
      if (!ctx.location) return true
      const cached = sessionOwnership.get(sessionID)
      if (cached !== undefined) return cached
      const inFlight = ownershipInFlight.get(sessionID)
      if (inFlight) return inFlight
      const resolution = (async () => {
        try {
          const info = (await ctx.session.get({ sessionID })) as SessionInfoLoose
          const owned = locationMatches(info?.location)
          sessionOwnership.set(sessionID, owned)
          return owned
        } catch {
          // Unresolvable: treat as foreign without caching so a transient
          // lookup failure recovers on the next event.
          return false
        } finally {
          ownershipInFlight.delete(sessionID)
        }
      })()
      ownershipInFlight.set(sessionID, resolution)
      return resolution
    }

    // ── Prompt delivery with failure accounting ───────────────────────────

    const notifySynthetic = async (sessionID: string, text: string) => {
      try {
        await ctx.session.synthetic({ sessionID, text, delivery: "queue" })
      } catch {
        /* best effort */
      }
    }

    /** Send a loop prompt; consecutive admission failures auto-pause the goal. */
    const sendPrompt = async (goal: GoalRecord, text: string, reason: string): Promise<boolean> => {
      try {
        log(`prompt -> ${goal.sessionID} (${reason})`)
        await ctx.session.prompt({ sessionID: goal.sessionID, text })
        await mutateGoal(goal.sessionID, `prompt:${reason}`, (g) => {
          g.promptFailures = 0
        })
        return true
      } catch (e) {
        const message = errMsg(e)
        const failures = goal.promptFailures + 1
        if (failures >= maxPromptFailures) {
          await mutateGoal(goal.sessionID, "auto-paused", (g) => {
            g.status = "paused"
            g.closeReason = `连续 ${failures} 次 prompt 投递失败 (${clip(message, 300)})`
          })
          await notifySynthetic(goal.sessionID, P.pausedNotice(`连续 ${failures} 次 prompt 投递失败`))
        } else {
          await mutateGoal(goal.sessionID, `prompt-failed:${reason}`, (g) => {
            g.promptFailures = failures
          })
        }
        return false
      }
    }

    const cancelExecFailTimer = (sessionID: string) => {
      const timer = execFailTimers.get(sessionID)
      if (timer) {
        clearTimeout(timer)
        execFailTimers.delete(sessionID)
      }
    }

    // ── The stop-handling loop (leader + owner only) ───────────────────────

    /** Reads the goal fresh from storage. */
    const getGoal = async (sessionID: string): Promise<GoalRecord | undefined> =>
      (await readRegistry()).goals.find((g) => g.sessionID === sessionID)

    /** Auto-pause helper: stops the loop and tells the executor why. */
    const pauseGoal = async (sessionID: string, reason: string) => {
      await mutateGoal(sessionID, "auto-paused", (g) => {
        if (g.status !== "activated") return false
        g.status = "paused"
        g.closeReason = clip(reason, 600)
        g.phase = "working"
        g.verifyStage = null
        g.verifyClaim = null
        g.verifierStartedAt = null
      })
      await notifySynthetic(sessionID, P.pausedNotice(reason))
    }

    // ── Persistent independent reviewer ────────────────────────────────────

    /**
     * Resolves the model the independent reviewer runs on when it has to be
     * created. The reviewer is always a separate session with its own context;
     * its model is never picked automatically:
     *   - `verify_model` (plugin option) when given,
     *   - otherwise the goal session's model.
     */
    const resolveVerifyModel = async (
      sessionID: string,
    ): Promise<{ model: ModelRef | undefined; source: "option" | "session" }> => {
      if (verifyModelOption) return { model: verifyModelOption, source: "option" }
      return { model: await sessionModelRef(sessionID), source: "session" }
    }

    type ReviewerHandle = {
      id: string
      model: ModelRef | undefined
      source: "option" | "session" | null
      created: boolean
    }

    /**
     * One reviewer session per goal, reused for every verification round. It is
     * a child session of the goal session (OpenCode's native subagent
     * machinery: own context, own model, read-only permissions) that is never
     * discarded between rounds, so the reviewer keeps a continuous memory of
     * the workspace and its earlier findings instead of re-reading everything.
     */
    const ensureReviewerSession = async (sessionID: string, goal: GoalRecord): Promise<ReviewerHandle> => {
      if (goal.reviewerSessionID) {
        try {
          const info = (await ctx.session.get({ sessionID: goal.reviewerSessionID })) as SessionInfoLoose
          if (info?.id) {
            const m = info.model
            const id = m?.id ?? m?.modelID
            const model =
              m?.providerID && id
                ? { providerID: m.providerID, id, ...(m.variant ? { variant: m.variant } : {}) }
                : undefined
            return {
              id: goal.reviewerSessionID,
              model,
              source: (goal.verifyModelSource as ReviewerHandle["source"]) ?? null,
              created: false,
            }
          }
        } catch {
          // Session is gone (deleted / host reset): create a fresh one below.
          log(`reviewer session ${goal.reviewerSessionID} is gone; recreating`)
        }
      }
      const resolved = await resolveVerifyModel(sessionID)
      const model = resolved.model
      const createInput = {
        // parentID makes this a native child/subagent session; the generated
        // typing lags behind the server, hence the cast.
        parentID: sessionID,
        title: `[goal-review] ${clip(goal.accept.replace(/\s+/g, " "), 40)}`,
        agent: verifyAgent,
        ...(model ? { model } : {}),
        metadata: { source: "goal-plugin", kind: "review", goalSessionID: sessionID },
        permissions: VERIFIER_PERMISSIONS,
      } as unknown as Parameters<typeof ctx.session.create>[0]
      const created = (await ctx.session.create(createInput)) as SessionInfoLoose
      const id = created?.id
      if (!id) throw new Error("reviewer session creation returned no id")
      return { id, model, source: resolved.source, created: true }
    }

    /** The executor's delivery note: its last assistant message. */
    const deliveryNote = async (sessionID: string): Promise<string> =>
      (await lastAssistant(sessionID))?.text ?? ""

    /**
     * Waits for the reviewer to finish the prompt just admitted. A session that
     * was prompted again still carries its old transcript, so the answer only
     * counts when the assistant message count grew past `before`.
     */
    const waitForNewOutput = async (
      reviewerID: string,
      before: number,
    ): Promise<{ text: string; completedAt: number; count: number } | undefined> => {
      await withTimeout(ctx.session.wait({ sessionID: reviewerID }), verifyTimeoutMs, "verification")
      let tail = await lastAssistant(reviewerID)
      if (tail && tail.count > before) return tail
      // wait() can resolve before the queued prompt is admitted; a short grace
      // period avoids judging the stale transcript of the previous round.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        unrefTimer(timer)
      })
      tail = await lastAssistant(reviewerID)
      return tail && tail.count > before ? tail : undefined
    }

    /**
     * Issues the current verification stage (gate or detail) in the persistent
     * reviewer session and consumes its answer. Runs asynchronously: the goal
     * session stays idle meanwhile, so the review never leaks into the
     * executing model's context.
     */
    const runStage = async (sessionID: string, reviewerID: string) => {
      const goal = await getGoal(sessionID)
      if (!goal || goal.status !== "activated" || goal.phase !== "verifying" || !goal.verifyStage) return
      const stage = goal.verifyStage
      // Stamp the stage start BEFORE prompting: recovery uses it to tell a
      // fresh stage answer from the transcript of the previous round.
      let started = false
      await mutateGoal(sessionID, `verify-${stage}-start`, (g) => {
        if (g.status !== "activated" || g.phase !== "verifying" || g.verifyStage !== stage) return false
        started = true
        g.verifierStartedAt = Date.now()
      })
      if (!started) return
      const current = await getGoal(sessionID)
      if (!current || current.verifyStage !== stage) return
      const note = await deliveryNote(sessionID)
      const prompt =
        stage === "gate"
          ? P.gateReview(note)
          : current.verifyClaim === "impossible"
            ? P.verifierImpossibleReview(current, note, current.verifications + 1, verifyAgent)
            : P.verifierReview(current, note, current.verifications + 1, verifyAgent)
      const before = await assistantCount(reviewerID)
      try {
        log(`verify ${sessionID}: stage=${stage} reviewer=${reviewerID}`)
        await ctx.session.prompt({ sessionID: reviewerID, text: prompt })
        const tail = await waitForNewOutput(reviewerID, before)
        const text = tail?.text ?? ""
        if (stage === "gate") {
          await processStageResult(sessionID, "gate", { gate: parseGateVerdict(text), text })
        } else {
          await processStageResult(sessionID, "detail", { verdict: parseVerifierVerdict(text), text })
        }
      } catch (e) {
        logWarn(`verification stage ${stage} failed for ${sessionID}`, e)
        try {
          await ctx.session.interrupt({ sessionID: reviewerID })
        } catch {
          /* already settled or gone */
        }
        await processStageResult(sessionID, stage, { text: errMsg(e), failed: true })
      }
    }

    /** No conclusion from a verification stage: count it and continue/pause. */
    const finishVerificationError = async (
      sessionID: string,
      stage: GoalVerifyStage,
      current: GoalRecord,
      text: string,
    ) => {
      const errors = current.verifyErrors + 1
      let won = false
      await mutateGoal(sessionID, "verify-error", (g) => {
        if (g.phase !== "verifying" || g.verifyStage !== stage) return false
        won = true
        g.phase = "working"
        g.verifyStage = null
        g.verifyClaim = null
        g.verifyErrors = errors
        g.lastVerifyAt = Date.now()
        g.lastFeedback = clip(text, 2000)
        g.verifierStartedAt = null
      })
      if (!won) return
      if (maxVerifyErrors > 0 && errors >= maxVerifyErrors) {
        await pauseGoal(sessionID, `连续 ${errors} 次独立验收无结论: ${clip(text, 300)}`)
        return
      }
      await sendPrompt(current, P.verifyErrorContinue(text), "verify-error")
    }

    /**
     * Consumes the result of one verification stage. Leader-only and
     * phase/stage-checked: exactly one instance may transition the goal out of
     * a stage, so a reload during verification cannot double-drive the
     * follow-up prompt.
     */
    const processStageResult = async (
      sessionID: string,
      stage: GoalVerifyStage,
      result: {
        gate?: "INCOMPLETE" | "COMPLETE" | "IMPOSSIBLE"
        verdict?: "PASS" | "FAIL" | "IMPOSSIBLE"
        /** Infrastructure failure (prompt/timeout/crash), not an off-format answer. */
        failed?: boolean
        text: string
      },
    ) => {
      if (!(await refreshLeadership())) return
      const current = await getGoal(sessionID)
      if (!current || current.status !== "activated" || current.phase !== "verifying") return
      if (current.verifyStage !== stage) return
      log(
        `verification ${stage} result: ${stage === "gate" ? (result.gate ?? "(none)") : (result.verdict ?? "(none)")}`,
      )

      if (stage === "gate") {
        if (result.failed) {
          // Infrastructure failure (prompt/timeout/crash): the round did not
          // conclude.
          await finishVerificationError(sessionID, "gate", current, result.text)
          return
        }
        if (result.gate === "INCOMPLETE") {
          // The delivery note itself admits unfinished work: send it straight
          // back. No detailed inspection — that is the whole point of the gate.
          let rejected = false
          await mutateGoal(sessionID, "gate-reject", (g) => {
            if (g.phase !== "verifying" || g.verifyStage !== "gate") return false
            rejected = true
            g.phase = "working"
            g.verifyStage = null
            g.verifyClaim = null
            g.verifyFailures += 1
            g.gateRejections += 1
            g.verifyErrors = 0
            g.lastVerifyAt = Date.now()
            g.lastFeedback = clip(result.text, 3000)
            g.verifierStartedAt = null
            g.turns += 1
          })
          if (rejected) await sendPrompt(current, P.gateRejectedFeedback(result.text), "gate-reject")
          return
        }
        if (!result.gate && !result.text.trim()) {
          // Nothing at all came back: the round did not conclude.
          await finishVerificationError(sessionID, "gate", current, result.text)
          return
        }
        // COMPLETE, IMPOSSIBLE, or an off-format answer (not worth an error
        // round: the detailed inspection is authoritative anyway): advance to
        // stage 2 in the SAME reviewer session, which already remembers earlier
        // rounds.
        if (!result.gate) log(`gate answered off-format for ${sessionID}; falling through to detail`)
        let advanced = false
        await mutateGoal(sessionID, result.gate ? "gate-pass" : "gate-pass-offformat", (g) => {
          if (g.phase !== "verifying" || g.verifyStage !== "gate") return false
          advanced = true
          g.verifyStage = "detail"
          // An impossibility claim is adjudicated separately in stage 2; it is
          // never a reason to send the executor straight back to work.
          g.verifyClaim = result.gate === "IMPOSSIBLE" ? "impossible" : "done"
          g.verifierStartedAt = Date.now()
        })
        if (!advanced) return
        const reviewerID = (await getGoal(sessionID))?.reviewerSessionID
        if (reviewerID) await runStage(sessionID, reviewerID)
        return
      }

      // ── detailed inspection ──
      if (result.verdict === "PASS") {
        let won = false
        await mutateGoal(sessionID, "complete", (g) => {
          if (g.phase !== "verifying" || g.verifyStage !== "detail") return false
          won = true
          g.status = "complete"
          g.phase = "working"
          g.verifyStage = null
          g.verifyClaim = null
          g.closedAt = Date.now()
          g.closeReason = clip(result.text, 2000)
          g.verifications += 1
          g.verifyErrors = 0
          g.lastVerifyAt = Date.now()
          g.verifierStartedAt = null
        })
        if (won) await sendPrompt(current, P.completeNotice(result.text), "complete")
        return
      }
      if (result.verdict === "IMPOSSIBLE") {
        let won = false
        await mutateGoal(sessionID, "impossible", (g) => {
          if (g.phase !== "verifying" || g.verifyStage !== "detail") return false
          won = true
          g.status = "impossible"
          g.phase = "working"
          g.verifyStage = null
          g.verifyClaim = null
          g.closedAt = Date.now()
          g.closeReason = clip(result.text, 600)
          g.verifications += 1
          g.verifyErrors = 0
          g.lastVerifyAt = Date.now()
          g.verifierStartedAt = null
        })
        if (won) await sendPrompt(current, P.impossibleNotice(result.text), "impossible")
        return
      }
      if (result.verdict === "FAIL") {
        let won = false
        await mutateGoal(sessionID, "verify-fail", (g) => {
          if (g.phase !== "verifying" || g.verifyStage !== "detail") return false
          won = true
          g.phase = "working"
          g.verifyStage = null
          g.verifyClaim = null
          g.verifications += 1
          g.verifyFailures += 1
          g.verifyErrors = 0
          g.lastVerifyAt = Date.now()
          g.lastFeedback = clip(result.text, 3000)
          g.verifierStartedAt = null
          g.turns += 1
        })
        if (won) {
          const feedback =
            current.verifyClaim === "impossible"
              ? P.impossibleRejectedFeedback(result.text)
              : P.verifyFailFeedback(result.text)
          await sendPrompt(current, feedback, "verify-fail")
        }
        return
      }
      // No verdict: the reviewer crashed, timed out or answered off-format.
      await finishVerificationError(sessionID, "detail", current, result.text)
    }

    /**
     * Starts a verification round: claim the working → verifying transition,
     * make sure the goal's persistent reviewer exists, then run stage 1 (the
     * delivery-note gate). The reviewer is never re-created per round unless
     * its session vanished.
     */
    const startVerification = async (sessionID: string) => {
      const goal = await getGoal(sessionID)
      if (!goal || goal.status !== "activated" || goal.phase !== "working") return
      // Claim the phase before touching the reviewer so a concurrent settle (or
      // a plugin reload) can never start a second round.
      let claimed = false
      await mutateGoal(sessionID, "verify-claim", (g) => {
        if (g.status !== "activated" || g.phase !== "working") return false
        claimed = true
        g.phase = "verifying"
        g.verifyStage = "gate"
        g.verifyClaim = "done"
        g.verifierStartedAt = Date.now()
      })
      if (!claimed) return
      const claimedGoal = await getGoal(sessionID)
      if (!claimedGoal) return

      let reviewer: ReviewerHandle
      try {
        reviewer = await ensureReviewerSession(sessionID, claimedGoal)
      } catch (e) {
        logWarn("reviewer session unavailable", e)
        await processStageResult(sessionID, "gate", {
          text: `reviewer session: ${errMsg(e)}`,
          failed: true,
        })
        return
      }
      let attached = false
      await mutateGoal(sessionID, "reviewer-attach", (g) => {
        if (g.status !== "activated" || g.phase !== "verifying") return false
        attached = true
        g.reviewerSessionID = reviewer.id
        g.verifyModel = reviewer.model ? modelKey(reviewer.model) : g.verifyModel
        g.verifyModelSource = reviewer.source ?? g.verifyModelSource
      })
      if (!attached) return
      log(
        `verify ${sessionID} via reviewer ${reviewer.id}${reviewer.created ? " (created)" : " (reused)"} model=${reviewer.model ? modelKey(reviewer.model) : "(session)"}`,
      )
      void runStage(sessionID, reviewer.id).catch((e: unknown) => logWarn("verification crashed", e))
    }

    /**
     * The session settled (execution.succeeded / session.idle) while a goal is
     * activated. This is the driver. Leader + owner only.
     */
    const onSettled = async (sessionID: string, source: string) => {
      if (!(await refreshLeadership())) return
      if (!(await ownsSession(sessionID))) return
      const goal = await getGoal(sessionID)
      log(`settle ${sessionID} (${source}) goal=${goal ? `${goal.status}/${goal.phase}` : "none"}`)
      if (!goal || goal.status !== "activated") return
      if (goal.phase === "verifying") return
      if (processing.has(sessionID)) return
      const now = Date.now()
      if (now - (lastSettleAt.get(sessionID) ?? 0) < SETTLE_DEBOUNCE_MS) return
      lastSettleAt.set(sessionID, now)
      processing.add(sessionID)
      try {
        const last = await lastAssistant(sessionID)
        // A settle that carries no new assistant output is a leftover event of
        // the run the last verification already judged: do not verify again.
        if (goal.lastVerifyAt && (last?.completedAt ?? 0) > 0 && (last?.completedAt ?? 0) <= goal.lastVerifyAt) {
          log(`stale settle ${sessionID}: no new output since the last verification`)
          return
        }
        const short = nonWsLength(last?.text ?? "") < minChars
        await mutateGoal(sessionID, short ? "short-stop" : "stop", (g) => {
          g.stops += 1
          if (short) g.turns += 1
        })
        if (maxTurns > 0 && short && goal.turns + 1 >= maxTurns) {
          await pauseGoal(sessionID, `已达到最大自动续行次数 ${maxTurns}`)
          return
        }
        if (short) {
          await sendPrompt(goal, P.shortStopContinue(minChars), "short-stop")
          return
        }
        // A substantial stop: the delivery note goes to the goal's persistent
        // independent reviewer (stage 1 gate, then stage 2 detail). The
        // executing model is never asked to judge its own work.
        await startVerification(sessionID)
      } catch (e) {
        logWarn(`settle handling failed for ${sessionID} (${source})`, e)
      } finally {
        processing.delete(sessionID)
      }
    }

    // ── btw-style progress sweep (leader only) ─────────────────────────────

    const runProgressSweep = async () => {
      if (!(await refreshLeadership())) return
      const { goals } = await readRegistry()
      for (const goal of goals) {
        if (goal.status !== "activated") continue
        if (progressInFlight.has(goal.sessionID)) continue
        if (busySessions.has(goal.sessionID)) continue
        if (!(await ownsSession(goal.sessionID))) continue
        progressInFlight.add(goal.sessionID)
        try {
          const out = await ctx.session.generate({
            sessionID: goal.sessionID,
            prompt: P.progress(),
          })
          const text = out?.text?.trim()
          if (text) {
            await mutateGoal(goal.sessionID, "progress", (g) => {
              if (g.status !== "activated") return false
              g.progress = clip(text, 4000)
              g.progressAt = Date.now()
            })
          }
        } catch {
          // transient generate unavailable (e.g. provider hiccup) — skip round
        } finally {
          progressInFlight.delete(goal.sessionID)
        }
      }
    }

    const progressTimer = setInterval(() => {
      void runProgressSweep().catch((e: unknown) => logWarn("progress sweep failed", e))
    }, progressIntervalMs)
    unrefTimer(progressTimer)

    // ── Event subscription ─────────────────────────────────────────────────

    const eventController = new AbortController()

    const decodeEvent = (raw: unknown): V2EventLoose | undefined => {
      let ev = raw
      if (typeof ev === "string") {
        try {
          ev = JSON.parse(ev)
        } catch {
          return undefined
        }
      }
      const candidate = ev as V2EventLoose
      if (!candidate || typeof candidate.type !== "string") return undefined
      return candidate
    }

    const handleEvent = async (event: V2EventLoose) => {
      const data = event.data ?? {}
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return
      // Envelope location is authoritative when present (caches ownership);
      // settle events carry no envelope, so ownership resolves via the
      // session's actual location.
      if (event.location) {
        sessionOwnership.set(sessionID, locationMatches(event.location))
      } else if (!(await ownsSession(sessionID))) {
        return
      }
      switch (event.type) {
        case "session.execution.started": {
          busySessions.add(sessionID)
          cancelExecFailTimer(sessionID)
          break
        }
        case "session.status": {
          const status = data.status as Record<string, unknown> | undefined
          const type = String(status?.type ?? "")
          if (type === "busy") {
            busySessions.add(sessionID)
            cancelExecFailTimer(sessionID)
          } else if (type === "idle") {
            busySessions.delete(sessionID)
            void onSettled(sessionID, "session.status")
          }
          break
        }
        case "session.execution.succeeded":
        case "session.idle": {
          busySessions.delete(sessionID)
          // Reset the execution-failure counter only when it is non-zero, so
          // ordinary settles do not write the registry.
          await mutateGoal(sessionID, "exec-recovered", (g) => {
            if (g.execFailures > 0) {
              g.execFailures = 0
              return true
            }
            return false
          })
          void onSettled(sessionID, event.type)
          break
        }
        case "session.execution.failed": {
          busySessions.delete(sessionID)
          const goal = await getGoal(sessionID)
          if (!goal || goal.status !== "activated") break
          const failures = goal.execFailures + 1
          if (failures >= maxExecFailures) {
            const message = String(
              (data.error as Record<string, unknown> | undefined)?.message ?? data.error ?? "execution failed",
            )
            await mutateGoal(sessionID, "auto-paused", (g) => {
              g.status = "paused"
              g.closeReason = `连续 ${failures} 次执行失败 (${clip(message, 300)})`
            })
            await notifySynthetic(sessionID, P.pausedNotice(`连续 ${failures} 次执行失败`))
            break
          }
          await mutateGoal(sessionID, "exec-failed", (g) => {
            g.execFailures = failures
          })
          emitUpdated(sessionID, "execution-failed")
          cancelExecFailTimer(sessionID)
          const timer = setTimeout(() => {
            execFailTimers.delete(sessionID)
            void (async () => {
              if (!(await refreshLeadership())) return
              if (!(await ownsSession(sessionID))) return
              const current = await getGoal(sessionID)
              if (!current || current.status !== "activated") return
              if (busySessions.has(sessionID)) return
              await sendPrompt(current, P.execFailContinue(), "exec-fail-retry")
            })()
          }, EXEC_FAIL_RETRY_DELAY_MS)
          unrefTimer(timer)
          execFailTimers.set(sessionID, timer)
          break
        }
        case "session.execution.interrupted": {
          // A user interrupt is intentional: never auto-continue from it.
          busySessions.delete(sessionID)
          cancelExecFailTimer(sessionID)
          break
        }
        case "session.deleted": {
          busySessions.delete(sessionID)
          cancelExecFailTimer(sessionID)
          sessionOwnership.delete(sessionID)
          const registry = await readRegistry()
          if (registry.goals.some((g) => g.sessionID === sessionID)) {
            registry.goals = registry.goals.filter((g) => g.sessionID !== sessionID)
            registry.kickoffs = registry.kickoffs.filter(([id]) => id !== sessionID)
            await writeRegistry(registry, "deleted")
          }
          break
        }
        default:
          break
      }
    }

    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: eventController.signal })) {
          if (disposed) break
          const event = decodeEvent(raw)
          if (!event) continue
          try {
            await handleEvent(event)
          } catch (e) {
            logWarn("event handling failed", e)
          }
        }
      } catch (e) {
        const err = e as Record<string, unknown>
        if (err?.name === "AbortError" || eventController.signal.aborted) return
        logWarn("event subscription failed", e)
      }
    })()

    // ── Restart / reload recovery (leader only) ────────────────────────────

    /**
     * Re-drives every activated goal owned by this location after a restart or
     * plugin reload: waits for any surviving run to settle, then continues the
     * loop (or re-attaches to a verifier that is still running). Only the
     * location leader runs this: leaked older generations would otherwise
     * duplicate the recovery prompts.
     */
    const recoverGoals = async () => {
      if (!(await refreshLeadership())) return
      const { goals } = await readRegistry()
      for (const goal of goals) {
        if (goal.status !== "activated") continue
        try {
          if (!(await ownsSession(goal.sessionID))) continue
          // Resolves immediately when the session is settled; otherwise waits
          // for the surviving run to finish (plugin reload case).
          await withTimeout(ctx.session.wait({ sessionID: goal.sessionID }), 10 * 60_000, "recovery wait")
        } catch {
          continue
        }
        const current = await getGoal(goal.sessionID)
        if (!current || current.status !== "activated") continue
        try {
          if (current.phase === "verifying") {
            // Re-attach to the persistent reviewer: its server-side run usually
            // survives a plugin reload, and a restart may have completed it.
            // Only a stage that produced no output for this round is re-issued.
            const stage: GoalVerifyStage = current.verifyStage ?? "detail"
            const reviewerID = current.reviewerSessionID
            if (reviewerID) {
              const startedAt = current.verifierStartedAt ?? 0
              let consumed = false
              try {
                const before = await lastAssistant(reviewerID)
                const alreadyDone = Boolean(before && startedAt > 0 && before.completedAt >= startedAt)
                if (!alreadyDone) {
                  // Running reviewers must not be judged from a partial
                  // transcript. Bounded by the leftover timeout.
                  const remaining = Math.max(60_000, verifyTimeoutMs - (Date.now() - (startedAt || Date.now())))
                  await withTimeout(ctx.session.wait({ sessionID: reviewerID }), remaining, "recovery verification")
                }
                const after = await lastAssistant(reviewerID)
                if (after && startedAt > 0 && after.completedAt >= startedAt) {
                  const text = after.text
                  if (stage === "gate") {
                    await processStageResult(goal.sessionID, "gate", { gate: parseGateVerdict(text), text })
                  } else {
                    await processStageResult(goal.sessionID, "detail", { verdict: parseVerifierVerdict(text), text })
                  }
                  consumed = true
                }
              } catch (e) {
                logWarn(`recovery verification re-attach failed for ${goal.sessionID}`, e)
                try {
                  await ctx.session.interrupt({ sessionID: reviewerID })
                } catch {
                  /* already settled or gone */
                }
              }
              if (consumed) continue
              // The stage produced nothing: re-issue it in the same reviewer
              // session (the prompt may never have been admitted before the
              // reload). Its memory is intact, so this is cheap.
              await runStage(goal.sessionID, reviewerID)
              continue
            }
            // The reviewer session is gone: reset and verify again from stage 1.
            await mutateGoal(goal.sessionID, "recovery-reset", (g) => {
              if (g.phase !== "verifying") return false
              g.phase = "working"
              g.verifyStage = null
              g.verifyClaim = null
              g.reviewerSessionID = null
              g.verifierStartedAt = null
            })
            current.phase = "working"
            await startVerification(goal.sessionID)
            continue
          }
          const registry = await readRegistry()
          const kickoff = registry.kickoffs.find(([id]) => id === goal.sessionID)?.[1]
          if (!current.kickoffSentAt && current.turns === 0 && kickoff) {
            // Spawned but the kickoff was never admitted: re-deliver it verbatim.
            await mutateGoal(goal.sessionID, "recovery-kickoff", (g) => {
              g.turns += 1
              g.kickoffSentAt = Date.now()
            })
            await sendPrompt(current, kickoff, "recovery-kickoff")
            continue
          }
          await sendPrompt(current, P.recoveryContinue(current), "recovery")
        } catch (e) {
          logWarn(`goal recovery failed for ${goal.sessionID}`, e)
        }
      }
    }

    void recoverGoals().catch((e: unknown) => logWarn("goal recovery crashed", e))

    // ── System reminder on every model call of an activated goal ───────────

    const registrations: Array<{ dispose: () => Promise<void> }> = []

    try {
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          try {
            const ev = event as unknown as Record<string, unknown>
            const kind = (ev as { kind?: string }).kind
            if (kind && kind !== "primary") return
            const sessionID = (ev as { sessionID?: unknown }).sessionID
            if (typeof sessionID !== "string") return
            // Only the owning location's leader injects: leaked generations of
            // this hook would otherwise stack duplicate reminders.
            if (!(await refreshLeadership())) return
            if (!(await ownsSession(sessionID))) return
            const cached = hookCache.get(sessionID)
            let goal: GoalRecord | null | undefined
            if (cached && Date.now() - cached.at < 5_000) {
              goal = cached.goal
            } else {
              goal = (await getGoal(sessionID)) ?? null
              hookCache.set(sessionID, { at: Date.now(), goal })
            }
            if (!goal || goal.status !== "activated") return
            const system = (ev as { system?: unknown }).system
            if (!Array.isArray(system)) return
            system.push({ type: "text", text: P.systemReminder(goal) })
          } catch {
            /* never break the host on a reminder */
          }
        }),
      )
    } catch (e) {
      logWarn("context hook unavailable", e)
    }

    // ── RPC ────────────────────────────────────────────────────────────────

    let rpcRegistration: { dispose: () => Promise<void> } | undefined

    /** Storage-authoritative RPC mutations work from any instance. */
    const extractRequirements = async (
      sessionID: string,
      text: string,
    ): Promise<{ ok: true; impl: string; accept: string } | { ok: false; error: string }> => {
      try {
        const model = await sessionModelRef(sessionID)
        const out = await ctx.generate.text({
          prompt: P.extraction(text),
          ...(model ? { model } : {}),
        })
        const parsed = parseJsonObject(out?.text ?? "")
        const impl = typeof parsed?.impl === "string" ? parsed.impl.trim() : ""
        const accept = typeof parsed?.accept === "string" ? parsed.accept.trim() : ""
        if (!impl || !accept) {
          return { ok: false, error: `提取结果不完整(需要 impl 与 accept 两个字段)。模型输出: ${clip(out?.text, 300)}` }
        }
        return { ok: true, impl, accept }
      } catch (e) {
        return { ok: false, error: errMsg(e) }
      }
    }

    try {
      const reg = await ctx.rpc.register(GoalRpc, {
        extract: async (input: unknown) => {
          const { sessionID, text } = (input ?? {}) as { sessionID?: string; text?: string }
          if (!sessionID || !text?.trim()) return { ok: false, error: "sessionID 与 text 必填" }
          const result = await extractRequirements(sessionID, text)
          if (!result.ok) return { ok: false, error: result.error }
          return { ok: true, impl: result.impl, accept: result.accept }
        },
        activate: async (input: unknown) => {
          const { sessionID, impl, accept } = (input ?? {}) as {
            sessionID?: string
            impl?: string
            accept?: string
          }
          if (!sessionID || !impl?.trim() || !accept?.trim()) {
            return { ok: false, message: "sessionID、impl、accept 必填" }
          }
          const existing = (await readRegistry()).goals.find((g) => g.sessionID === sessionID)
          if (existing?.status === "activated") {
            return { ok: false, message: "该会话已有激活中的 goal,请先 /goal pause 或 /goal clear" }
          }
          // Resolve the verifier model up front so the UI can show it.
          const resolved = await resolveVerifyModel(sessionID)
          const goal: GoalRecord = {
            sessionID,
            status: "activated",
            phase: "working",
            impl: impl.trim(),
            accept: accept.trim(),
            progress: null,
            progressAt: null,
            turns: 0,
            stops: 0,
            verifications: 0,
            verifyFailures: 0,
            gateRejections: 0,
            verifyErrors: 0,
            promptFailures: 0,
            execFailures: 0,
            reviewerSessionID: null,
            verifyStage: null,
            verifyClaim: null,
            verifierStartedAt: null,
            verifyModel: resolved.model ? modelKey(resolved.model) : null,
            verifyModelSource: resolved.source,
            lastVerifyAt: null,
            kickoffSentAt: Date.now(),
            lastFeedback: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            closedAt: null,
            closeReason: null,
          }
          const registry = await readRegistry()
          registry.goals = registry.goals.filter((g) => g.sessionID !== sessionID)
          registry.goals.push(goal)
          registry.kickoffs = registry.kickoffs.filter(([id]) => id !== sessionID)
          registry.kickoffs.push([sessionID, P.kickoff(goal)])
          await writeRegistry(registry, "activated", sessionID)
          // The kickoff prompt is delivered directly (prompt sending needs no
          // leadership; the leader picks the goal up from storage on settle).
          const sent = await sendPrompt(goal, P.kickoff(goal), "kickoff")
          const verifyLabel = resolved.model ? modelKey(resolved.model) : "会话默认模型"
          return {
            ok: true,
            message: sent
              ? `goal 已激活,执行开始;验收模型: ${verifyLabel} (独立子会话)。`
              : "goal 已激活,但启动 prompt 投递失败,请检查会话。",
          }
        },
        control: async (input: unknown) => {
          const { sessionID, action } = (input ?? {}) as {
            sessionID?: string
            action?: "pause" | "resume" | "clear"
          }
          if (!sessionID || !action) return { ok: false, message: "sessionID 与 action 必填" }
          const goal = (await readRegistry()).goals.find((g) => g.sessionID === sessionID)
          if (!goal) return { ok: false, message: "该会话没有 goal" }
          if (action === "pause") {
            if (goal.status !== "activated") return { ok: false, message: `当前状态 ${goal.status},无需暂停` }
            await mutateGoal(sessionID, "paused", (g) => {
              g.status = "paused"
              g.closeReason = "用户暂停"
              g.phase = "working"
              g.verifyStage = null
              g.verifyClaim = null
              g.verifierStartedAt = null
            })
            cancelExecFailTimer(sessionID)
            return { ok: true, message: "goal 已暂停 (paused);/goal resume 恢复" }
          }
          if (action === "resume") {
            if (goal.status !== "paused") return { ok: false, message: `当前状态 ${goal.status},无法恢复` }
            await mutateGoal(sessionID, "resumed", (g) => {
              g.status = "activated"
              g.closeReason = null
              g.phase = "working"
              g.promptFailures = 0
              g.execFailures = 0
              g.verifyErrors = 0
            })
            const current = await getGoal(sessionID)
            if (current) await sendPrompt(current, P.userResumed(current), "resumed")
            return { ok: true, message: "goal 已恢复 (activated),继续执行" }
          }
          // clear
          const registry = await readRegistry()
          registry.goals = registry.goals.filter((g) => g.sessionID !== sessionID)
          registry.kickoffs = registry.kickoffs.filter(([id]) => id !== sessionID)
          await writeRegistry(registry, "cleared", sessionID)
          cancelExecFailTimer(sessionID)
          return { ok: true, message: "goal 已清除" }
        },
        state: async (input: unknown) => {
          const { sessionID } = (input ?? {}) as { sessionID?: string }
          if (!sessionID) return { goal: null }
          const goal = (await readRegistry()).goals.find((g) => g.sessionID === sessionID) ?? null
          return { goal: JSON.parse(JSON.stringify(goal)) as GoalRecord | null }
        },
      })
      rpcRegistration = reg as { dispose: () => Promise<void> }
      rpcEvents = (reg as unknown as {
        events: { emit: (name: "updated", data: { sessionID: string; reason: string }) => Promise<void> }
      }).events
    } catch (e) {
      logWarn("rpc registration failed (TUI will not work)", e)
    }

    if (rpcRegistration) registrations.push(rpcRegistration)

    log(`setup complete (${instanceId}); registry has ${(await readRegistry()).goals.length} goal(s)`)

    // ── Cleanup ────────────────────────────────────────────────────────────

    return async () => {
      disposed = true
      log(`cleanup (${instanceId})`)
      // Step down so a surviving instance takes over immediately.
      try {
        const raw = (await ctx.storage.get(locationKey)) as { id?: string } | undefined
        if (raw?.id === instanceId) {
          await ctx.storage.set(locationKey, { id: instanceId, gen: myGen, at: 0 })
        }
      } catch {
        /* best effort */
      }
      eventController.abort()
      clearInterval(heartbeat)
      clearInterval(progressTimer)
      for (const timer of execFailTimers.values()) clearTimeout(timer)
      execFailTimers.clear()
      for (const registration of registrations) await registration.dispose()
    }
  },
}
