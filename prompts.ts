// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * All LLM-facing prompt text for the goal plugin driver.
 *
 * Loop-driven prompts are wrapped in <goal-plugin> tags so the executing agent
 * can distinguish plugin-driven turns from real user input.
 *
 * Acceptance is decided exclusively by the persistent independent reviewer:
 * stage 1 (gateReview) screens the executor's delivery note, stage 2
 * (verifierReview) inspects the workspace in detail. The executing model is
 * never asked to judge its own work.
 */

import type { GoalRecord } from "./rpc.ts"

const clip = (s: string, n: number): string => {
  const t = String(s ?? "").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const section = (title: string, body: string, max = 4000): string =>
  `【${title}】\n${clip(body, max)}`

export const P = {
  // ── /goal extraction (ctx.generate.text, no session context) ────────────

  extraction(text: string): string {
    return [
      "你是信息抽取器。从下面的目标描述中提取两部分内容:",
      "- impl: 如何实现(实现要求)——描述中关于实现方式、技术方案、实现步骤的部分",
      "- accept: 如何验收(验收要求)——描述中关于如何判定完成、验收标准、指标与效果的部分",
      "验收要求不止是最终效果指标,还应包含对实现方式本身的要求(即代码是否依据实现要求实现)。",
      "如果原文某部分没有明确写出,请根据整体目标归纳出该部分,不得留空。",
      "只输出一个 JSON 对象(不要 markdown 代码块,不要任何多余文字):",
      '{"impl": "...", "accept": "..."}',
      "",
      "原文:",
      "<<<",
      clip(text, 20000),
      ">>>",
    ].join("\n")
  },

  // ── activation ───────────────────────────────────────────────────────────

  kickoff(goal: { impl: string; accept: string }): string {
    return [
      "<goal-plugin>",
      "你已被指定一个持久 GOAL,由 goal 插件持续驱动,直到通过独立验收。goal 状态会显示在用户侧栏,重启后会自动恢复执行。",
      "",
      section("实现要求(如何实现)", goal.impl),
      "",
      section("验收要求(如何验收)", goal.accept),
      "",
      "执行规则:",
      "1. 持续执行,直到你确信已满足验收要求。不要在任务中途给出总结性停顿。",
      "2. 你每次停下且输出具有实质内容时,插件会让一位常驻的独立验收员(独立会话、独立上下文,跨轮保留检查记忆)先阅读你这条交付说明:只要说明里自己承认还有未完成项、待办或遗留问题,它会立刻把它退回给你继续;只有说明声称已经完成,才会进入逐项详细验收。",
      "3. 详细验收会实际检查工作成果:不止核对最终指标效果,还会审查代码是否依据实现要求实现。",
      "4. 你不能自己宣布完成:PASS 才算完成;FAIL 时验收员结论会作为反馈发给你,你据此继续完善。",
      "5. 若你确信目标在原理上不可能达成,不要伪造成果,也不要停在原地说不可能:请在交付说明中明确论证为什么不可能(具体是哪条约束导致、你已排除了哪些方案)。插件会把你的论证交给常驻验收员裁决,它独立确认后才会把 GOAL 标记为 IMPOSSIBLE;若它认为仍有可行路径,会把结论和方向反馈给你。",
      "</goal-plugin>",
      "",
      "请开始执行。",
    ].join("\n")
  },

  // ── working phase ────────────────────────────────────────────────────────

  shortStopContinue(minChars: number): string {
    return [
      "<goal-plugin>",
      `你这次停下的正文极短(非空白字符不足 ${minChars} 字),这通常是输出配置造成的虚假停止。`,
      "请继续执行当前 GOAL 任务,不要停。",
      "</goal-plugin>",
    ].join("\n")
  },

  // ── verification outcomes (feedback for the executing session) ───────────

  /**
   * Stage-1 gate went against the executor: its own delivery note admitted
   * unfinished work. Cheap rejection, no detailed inspection happened.
   */
  gateRejectedFeedback(gateText: string): string {
    return [
      "<goal-plugin>",
      "交付说明初筛未通过:你这次停下前的最后一条输出本身表明工作尚未完成。常驻验收员的初筛结论:",
      "",
      clip(gateText, 2000),
      "",
      "请继续执行当前 GOAL,把上述未完成项做完后再停下;详细验收只会在交付说明声称完成后才开始。",
      "</goal-plugin>",
    ].join("\n")
  },

  verifyFailFeedback(verdictText: string): string {
    return [
      "<goal-plugin>",
      "独立验收未通过。验收员结论:",
      "",
      clip(verdictText, 4000),
      "",
      "请针对上述结论继续完善实现(注意:验收不止核对最终指标效果,还审查代码是否依据实现要求实现)。你下次停下时会重新触发独立验收。",
      "</goal-plugin>",
    ].join("\n")
  },

  /**
   * The executor claimed impossibility and the reviewer refuted it: it must try
   * the viable paths the reviewer pointed out instead of re-stating the claim.
   */
  impossibleRejectedFeedback(verdictText: string): string {
    return [
      "<goal-plugin>",
      "验收员裁决:目标并非不可能完成,你的不可能性论证不成立。结论:",
      "",
      clip(verdictText, 4000),
      "",
      "请按上述结论指出的可行路径继续尝试,不要只是重复「不可能」;只有真正存在原理性障碍时,新的不可能性论证才会被接受。",
      "</goal-plugin>",
    ].join("\n")
  },

  verifyErrorContinue(error: string): string {
    return [
      "<goal-plugin>",
      `独立验收流程出错(${clip(error, 400)}),本轮未得到结论。请继续执行;你下次停下时会重新触发独立验收。`,
      "</goal-plugin>",
    ].join("\n")
  },

  completeNotice(verdictText: string): string {
    return [
      "<goal-plugin>",
      "独立验收通过,GOAL 已完成。验收员结论:",
      "",
      clip(verdictText, 2000),
      "</goal-plugin>",
    ].join("\n")
  },

  impossibleNotice(verdictText: string): string {
    return [
      "<goal-plugin>",
      "独立验收员判定该目标不可能完成,GOAL 已标记为 impossible。",
      "",
      clip(verdictText, 2000),
      "",
      "用户可用 /goal clear 清除该 goal。",
      "</goal-plugin>",
    ].join("\n")
  },

  // ── recovery / failures ──────────────────────────────────────────────────

  recoveryContinue(goal: GoalRecord): string {
    return [
      "<goal-plugin>",
      "服务/插件发生重启,你的 GOAL 仍然有效(状态与要求如下),请从中断处继续执行。停下时会被独立验收。",
      "",
      section("实现要求(如何实现)", goal.impl, 2000),
      "",
      section("验收要求(如何验收)", goal.accept, 2000),
      "</goal-plugin>",
    ].join("\n")
  },

  execFailContinue(): string {
    return [
      "<goal-plugin>",
      "上一轮执行失败(系统重试后仍失败)。请从中断处继续执行当前 GOAL。",
      "</goal-plugin>",
    ].join("\n")
  },

  pausedNotice(reason: string): string {
    return [
      "<goal-plugin>",
      `GOAL 已自动暂停: ${clip(reason, 600)}`,
      "问题排除后可用 /goal resume 恢复。",
      "</goal-plugin>",
    ].join("\n")
  },

  userResumed(goal: GoalRecord): string {
    return [
      "<goal-plugin>",
      "GOAL 已由用户恢复(activated)。请继续执行;停下时会被独立验收。",
      "",
      section("实现要求(如何实现)", goal.impl, 2000),
      "",
      section("验收要求(如何验收)", goal.accept, 2000),
      "</goal-plugin>",
    ].join("\n")
  },

  // ── system reminder injected on every model call of an activated goal ────

  systemReminder(goal: GoalRecord): string {
    const phaseHint =
      goal.phase === "verifying"
        ? goal.verifyStage === "gate"
          ? "当前正在初筛你的交付说明(常驻验收员只读你最后一条输出,判断你声称完成、主张不可能、还是仍有未完成项),你无需自查、不要宣布完成。"
          : goal.verifyClaim === "impossible"
            ? "当前正在裁决你提出的不可能性论证(由常驻验收员在自己的会话里核实),你无需自查、不要宣布完成。"
            : "当前正在逐项详细验收(由常驻验收员在自己的会话里检查),你无需自查、不要宣布完成。"
        : "持续执行直到确信满足验收要求;每次停下都会先初筛你的交付说明:声称完成后进入详细验收,主张不可能时进入不可能性裁决。"
    return [
      "<goal-plugin-reminder>",
      `持久 GOAL 处于 ${goal.status} 状态(${goal.turns} 次自动续行,${goal.stops} 次停下)。${phaseHint}`,
      section("实现要求", goal.impl, 800),
      section("验收要求", goal.accept, 800),
      "</goal-plugin-reminder>",
    ].join("\n")
  },

  // ── persistent independent reviewer ──────────────────────────────────────

  /**
   * Stage 1 of a verification round: the reviewer only reads the executor's
   * delivery note (its last assistant output) and classifies it as claiming
   * completion, admitting unfinished work, or arguing in-principle impossibility.
   * No tools, no workspace inspection: unfinished work is sent straight back,
   * which saves the expensive detailed pass.
   */
  gateReview(note: string): string {
    return [
      "你是本 GOAL 的常驻独立验收员:同一个 GOAL 的每一轮验收都由你在本会话中完成,你的检查记忆会跨轮保留。执行 agent 看不到你的会话,只会收到你的结论;你不负责修复,也不得修改任何文件。",
      "",
      "【验收第 1 步(共 2 步):交付说明初筛】",
      "",
      "执行 agent 本次停下前给出的最后一条输出,就是它的交付说明:",
      "",
      "<<<",
      clip(note || "(执行 agent 本次停下时没有给出任何正文)", 6000),
      ">>>",
      "",
      "只判断一件事:这条交付说明本身声称的是哪一种状态?本步只依据这条说明的字面内容,不要用你此前轮次的记忆去补充它没说的事情。",
      "- 如果它主张目标在原理上不可能达成,并给出了具体理由/约束(不是只说「做不到」「太难了」「卡住了」),输出:",
      "GATE: IMPOSSIBLE",
      "再用 1-3 行概括它的不可能性论证。",
      "- 否则,如果它承认仍有未完成项、遗留问题、待办、后续计划,或出现「尚未…」「还存在如下问题…」「下一步还需要…」「待验证…」之类的表述,输出:",
      "GATE: INCOMPLETE",
      "再用 1-3 行指出它承认了哪些未完成项。",
      "- 只有它明确表示工作已经完成、可以交付验收时,才输出:",
      "GATE: COMPLETE",
      "",
      "注意:若说明同时承认未完成项又论证不可能,按不可能性论证处理(GATE: IMPOSSIBLE),由第 2 步裁决。",
      "本步骤禁止使用任何工具:不要读文件、不要执行命令、不要开始逐项核对,也不要输出 VERDICT。只输出 GATE 结论(附简短说明)。",
    ].join("\n")
  },

  /**
   * Stage 2 of a verification round: the detailed inspection, issued in the
   * same persistent reviewer session. It runs only after the delivery note was
   * judged to claim completion. Earlier findings stay in the session memory,
   * but evidence touched by the executor must be re-checked.
   */
  verifierReview(goal: GoalRecord, note: string, round: number, agent: string): string {
    return [
      "【验收第 2 步(共 2 步):逐项对照详细验收】",
      "",
      `你是本 GOAL 的常驻独立验收员(agent: ${agent}),已经历此前各轮验收和刚才的初筛。你在本会话中保留了此前各轮的检查记录:此前亲自检查过、且此后未被改动的证据可以直接沿用,不必重新通读工作区;但执行 agent 可能已经改动了工作区——凡可能被改动或你此前没检查过的项,必须重新检查,拿不准时按已改动处理(可用 git status / git diff / 文件时间戳定位变化)。`,
      "你与执行 agent 各自独立,没有任何理由替它辩护;即使你与它使用同一个模型,也必须自己重新检查取证,不得沿用它的任何结论。",
      "",
      section("实现要求(执行 agent 应如何实现)", goal.impl),
      "",
      section("验收要求(如何验收)", goal.accept),
      "",
      section("执行 agent 的交付说明(仅作线索,不构成证据)", note, 3000),
      "",
      `【本轮:第 ${round} 轮详细验收】`,
      "",
      "验收要求说明:验收不止是核对最终的指标效果,还必须审查代码/产物是否依据实现要求实现(实现方式、结构、机制是否符合要求)。对话记录中的任何完成声明都不构成证据。",
      "",
      "验收方式(必须实际检查,禁止只凭线索推理):",
      "1. 用 read / glob / grep / list 等工具查看当前工作目录中的真实代码与产物;必要时用 shell 运行构建、测试或验证命令。",
      "2. 逐项核对验收要求与实现要求:沿用此前亲自检查过的结论时写明「沿用第 N 轮检查」;本轮新检查的写明证据(文件、行号、命令输出)。",
      "3. 不得修改任何文件(你的写入权限已被禁用):你只负责判定,不负责修复。",
      "4. 若验收要求中存在无法自动核验的人工项,按最严格的合理解释判断,并在理由中说明该假设。",
      "",
      "判定标准:",
      "- PASS:全部验收要求均满足,且有你自己检查得到的证据。",
      "- FAIL:任一项未满足、证据不足、或未依据实现要求实现。",
      "- IMPOSSIBLE:只有在目标从原理上无法达成(不是困难、不是当前方案走不通)时才可使用。",
      "",
      "输出格式(严格遵守):",
      "结论行必须单独占一行,内容只能是下列三者之一:",
      "VERDICT: PASS",
      "VERDICT: FAIL",
      "VERDICT: IMPOSSIBLE",
      "不要加粗、不要放进代码块、不要加引号或其它字符。其余内容(逐项依据:检查了什么、发现了什么、对应哪一条要求)写在结论行之后。",
    ].join("\n")
  },

  /**
   * Stage 2 variant: the executor did not claim completion — it argued the goal
   * is impossible in principle and gave its reasons in the delivery note. The
   * reviewer adjudicates that claim (it must not just accept it), and may answer
   * IMPOSSIBLE only after independently confirming no viable path exists.
   */
  verifierImpossibleReview(goal: GoalRecord, note: string, round: number, agent: string): string {
    return [
      "【验收第 2 步(共 2 步):不可能性论证裁决】",
      "",
      `你是本 GOAL 的常驻独立验收员(agent: ${agent}),已经历此前各轮验收和刚才的初筛。初筛判断:执行 agent 没有声称完成,而是主张目标在原理上不可能达成。`,
      "你在本会话中的既有检查记录(包括已经排除或尝试过的方案)可以复用,不必重复验证已确认的事实;但执行 agent 可能改动了环境,凡可能变化的前提都要重新确认。",
      "",
      section("实现要求(执行 agent 应如何实现)", goal.impl),
      "",
      section("验收要求(如何验收)", goal.accept),
      "",
      section("执行 agent 的不可能性论证(交付说明原文)", note, 6000),
      "",
      `【本轮:第 ${round} 轮不可能性裁决】`,
      "",
      "你的任务不是核对完成度,而是严格裁决这个不可能性主张:",
      "1. 弄清它的论证具体依赖哪些约束或事实(哪一步在原理上做不了),再独立验证这些约束是否真实存在、是否真的无法绕开。",
      "2. 主动寻找可行方案:换实现路径、换工具/库、换数据或环境、利用要求本身允许的范围。只有在原理上不可能(不是困难、不是当前方案走不通、不是成本高)时才判 IMPOSSIBLE。",
      "3. 若存在可行路径,判 FAIL,并明确指出它误判在哪里、应该尝试什么具体方案;它会把你的结论作为继续执行的反馈。",
      "4. 不得修改任何文件(你的写入权限已被禁用);需要时可以读取代码、运行命令来验证其论证。",
      "",
      "判定标准:",
      "- IMPOSSIBLE:论证成立,且你独立确认不存在任何可行路径。",
      "- FAIL:论证不成立,或存在可行路径。",
      "- PASS:仅在你裁决过程中发现目标其实已经完成时使用。",
      "",
      "输出格式(严格遵守):",
      "结论行必须单独占一行,内容只能是下列三者之一:",
      "VERDICT: PASS",
      "VERDICT: FAIL",
      "VERDICT: IMPOSSIBLE",
      "不要加粗、不要放进代码块、不要加引号或其它字符。其余内容(论证是否成立、你验证了什么、可行路径是什么)写在结论行之后。",
    ].join("\n")
  },

  // ── btw-style progress report (transient session.generate) ──────────────

  progress(): string {
    return [
      "(进度报告,不影响对话历史)请基于当前对话状态,用中文简洁汇报 GOAL 执行进度,200-300 字左右:",
      "1. 已完成了什么;",
      "2. 当前困难是什么;",
      "3. 接下来计划做什么。",
      "直接输出汇报正文,不要客套、不要列表编号以外的格式修饰。",
    ].join("\n")
  },
}
