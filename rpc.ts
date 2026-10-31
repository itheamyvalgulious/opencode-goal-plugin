// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Shared RPC contract between the server plugin (index.ts) and the TUI plugin
 * (tui.ts) of opencode-goal-plugin.
 *
 * Plain JSON-Schema data only: this module must stay free of runtime package
 * imports so both entrypoints can load it under the plugin host runtimes.
 */

export type GoalStatus = "activated" | "paused" | "complete" | "impossible"

/**
 * Driver phase of an activated goal.
 *
 * working   — the goal session owns the work
 * verifying — the persistent independent reviewer is reviewing the result
 */
export type GoalPhase = "working" | "verifying"

/**
 * Step of a verification round.
 *
 * gate   — the reviewer only reads the executor's delivery note and decides
 *          whether the note claims completion or impossibility (cheap, no tools)
 * detail — the reviewer adjudicates that claim against the real workspace
 */
export type GoalVerifyStage = "gate" | "detail"

/**
 * What stage 2 of a verification round has to adjudicate.
 *
 * done       — the delivery note claims the goal is finished
 * impossible — the delivery note argues the goal is impossible in principle
 */
export type GoalVerifyClaim = "done" | "impossible"

export type GoalRecord = {
  sessionID: string
  status: GoalStatus
  phase: GoalPhase
  /** 实现要求 (how to implement). */
  impl: string
  /** 验收要求 (how to accept). */
  accept: string
  /** Latest btw-style progress report (from transient session.generate). */
  progress: string | null
  progressAt: number | null
  /** Auto-continuations sent by the plugin. */
  turns: number
  /** Session settle events observed while activated. */
  stops: number
  /** Completed verification rounds (detailed inspections). */
  verifications: number
  /** Verification rounds that ended in FAIL (detailed or delivery-note gate). */
  verifyFailures: number
  /** Delivery notes rejected by the stage-1 gate (no detailed inspection run). */
  gateRejections: number
  /** Consecutive verifier failures (no verdict / timeout / crash). */
  verifyErrors: number
  /** Consecutive prompt admission failures (auto-pause guard). */
  promptFailures: number
  /** Consecutive execution failures (auto-pause guard). */
  execFailures: number
  /**
   * The persistent independent reviewer session. It is created once per goal
   * and reused for every verification round, so the reviewer keeps its own
   * continuous memory of the workspace instead of re-reading everything.
   */
  reviewerSessionID: string | null
  /** Current verification step while phase=verifying (null otherwise). */
  verifyStage: GoalVerifyStage | null
  /** What stage 2 adjudicates: the note's completion claim or its impossibility claim. */
  verifyClaim: GoalVerifyClaim | null
  /** When the current verification stage was (re)issued. */
  verifierStartedAt: number | null
  /** "provider/model" the persistent reviewer session runs on. */
  verifyModel: string | null
  /** How verifyModel was resolved when the reviewer was created: option / session. */
  verifyModelSource: string | null
  /** When the last verification concluded (stale-settle guard). */
  lastVerifyAt: number | null
  /** When the kickoff prompt was admitted (recovery re-delivery guard). */
  kickoffSentAt: number | null
  /** Last verifier output (FAIL feedback / verdict). */
  lastFeedback: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
  closeReason: string | null
}

export type GoalExtractInput = {
  sessionID: string
  text: string
}

export type GoalExtractOutput = {
  ok: boolean
  impl?: string
  accept?: string
  error?: string
}

export type GoalActivateInput = {
  sessionID: string
  impl: string
  accept: string
}

export type GoalActivateOutput = {
  ok: boolean
  message: string
}

export type GoalControlInput = {
  sessionID: string
  action: "pause" | "resume" | "clear"
}

export type GoalControlOutput = {
  ok: boolean
  message: string
}

export type GoalStateInput = {
  sessionID: string
}

export type GoalStateOutput = {
  goal: GoalRecord | null
}

export type GoalUpdatedEvent = {
  sessionID: string
  reason: string
}

/**
 * Portable RPC definition (JSON Schema flavor). The server registers it with
 * `ctx.rpc.register(GoalRpc, handlers)`; the TUI calls it through
 * `context.client.rpc(GoalRpc)`.
 */
export const GoalRpc = {
  id: "goal-plugin",
  methods: {
    extract: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "Session used to resolve the model for extraction." },
          text: { type: "string", description: "Raw /goal text containing 如何实现 and 如何验收." },
        },
        required: ["sessionID", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          impl: { type: "string" },
          accept: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    activate: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          impl: { type: "string" },
          accept: { type: "string" },
        },
        required: ["sessionID", "impl", "accept"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["ok", "message"],
        additionalProperties: false,
      },
    },
    control: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          action: { type: "string", enum: ["pause", "resume", "clear"] },
        },
        required: ["sessionID", "action"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["ok", "message"],
        additionalProperties: false,
      },
    },
    state: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          goal: {},
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sessionID", "reason"],
        additionalProperties: false,
      },
    },
  },
} as const
