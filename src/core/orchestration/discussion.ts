import type { AppContext } from "../context.js";
import type { Agent, Project, Task } from "../types.js";
import type { User } from "../../db/repositories.js";
import type { AgentRunner } from "../agents/runner.js";
import type { Communicator } from "./communicator.js";
import { extractJson } from "./llmJson.js";
import { protocolFor } from "../organization/collaboration.js";
import { modeDef } from "../organization/modes.js";

/**
 * Moderated discussion (PRD §4.1): 1–3 agents, max 3 rounds by default, early stop on
 * consensus, extendable on user request. Only meaningful positions are shown — no raw logs
 * or private reasoning.
 */
export interface DiscussionInput {
  user: User;
  project: Project | null;
  task: Task; // discussion is attached to a task record for execution tracking
  topic: string;
  context: string;
  agents: Agent[];
  maxRounds?: number;
  cwd: string;
}

export interface DiscussionTurn {
  round: number;
  agentId: string;
  position: string;
  agree: boolean;
  message: string;
}

export interface DiscussionResult {
  rounds: number;
  consensus: boolean;
  summary: string;
  turns: DiscussionTurn[];
}

export class Discussion {
  constructor(
    private ctx: AppContext,
    private runner: AgentRunner,
    private comm: Communicator,
  ) {}

  async run(input: DiscussionInput): Promise<DiscussionResult> {
    const maxRounds = input.maxRounds ?? input.project?.settings.maxDiscussionRounds ?? 3;
    const turns: DiscussionTurn[] = [];
    const startedAt = Date.now();
    const mode = await this.comm.mode(input.user);
    const protocol = protocolFor(mode, await this.ctx.flags.isEnabled("dialogue.style_variant_b", input.user.id), maxRounds);
    await this.comm.say({
      user: input.user,
      project: input.project,
      speaker: { kind: "moderator" },
      listener: { kind: "team" },
      situation: "discussion",
      body: `'${input.topic}' 건으로 ${input.agents.map((a) => a.name).join(", ")}의 의견을 모아볼게요.`,
      machineState: { kind: "discussion.start", taskId: input.task.id, projectId: input.project?.id, data: { agents: input.agents.map((a) => a.id) } },
    });
    let round: number;
    let consensus = false;
    for (round = 1; round <= protocol.maxRounds; round++) {
      const roundTurns: DiscussionTurn[] = [];
      for (const [agentIndex, agent] of input.agents.entries()) {
        const peers = input.agents.filter((a) => a.id !== agent.id);
        const listener = peers.length === 1 ? { kind: "agent" as const, agent: peers[0]! } : { kind: "team" as const };
        const transcript = turns.map((t) => `${this.name(input.agents, t.agentId)}(라운드${t.round}): ${t.position}`).join("\n");
        const prompt = [
          `당신은 AI 개발 조직의 구성원 '${agent.name}' 입니다. 아래 안건에 대해 짧고 실질적인 의견을 내세요.`,
          `안건: ${input.topic}`,
          `\n프로젝트 맥락:\n${input.context}`,
          transcript ? `\n지금까지의 의견:\n${transcript}` : "",
          `\n${protocol.instruction(round, agentIndex)}`,
          `\n${await this.comm.styleFor(input.user, agent, listener, "discussion")}`,
          `\n반드시 다음 JSON만 출력: {"position": "핵심 입장(기술적 사실, ${protocol.positionLength})", "agree": true|false, "message": "동료에게 하는 캐릭터 대사(위 말투 규칙 적용, 2~4문장)"}`,
        ].join("\n");
        const out = await this.runner.run({ agent, task: input.task, project: input.project, purpose: "discuss", prompt, cwd: input.cwd, mode: "readonly", kinds: ["local_cli", "paid_api"], timeoutMs: 5 * 60_000 });
        if (out.status !== "succeeded") {
          await this.comm.say({
            user: input.user,
            project: input.project,
            speaker: { kind: "system" },
            listener: { kind: "user" },
            situation: "error",
            body: `${agent.name}의 의견 수집 실패: ${out.error ?? out.status}`,
            machineState: { kind: "discussion.error", taskId: input.task.id, executionId: out.executionId, status: out.status },
          });
          continue;
        }
        const j = extractJson<{ position?: string; agree?: boolean; message?: string }>(out.text);
        const turn: DiscussionTurn = {
          round,
          agentId: agent.id,
          position: (j?.position ?? out.text).slice(0, 800),
          agree: !!j?.agree,
          message: (j?.message ?? j?.position ?? out.text).slice(0, 1200),
        };
        roundTurns.push(turn);
        turns.push(turn);
        await this.comm.say({
          user: input.user,
          project: input.project,
          speaker: { kind: "agent", agent },
          listener,
          situation: "discussion",
          body: turn.message,
          inCharacter: true,
          machineState: { kind: "discussion.turn", taskId: input.task.id, executionId: out.executionId, data: { round, agree: turn.agree, position: turn.position } },
        });
        if (await this.ctx.flags.isEnabled("relationships.evolve", input.user.id)) {
          for (const p of peers) await this.ctx.repos.relationships.recordInteraction(input.user.id, agent.id, p.id, turn.agree ? "positive" : "neutral");
        }
      }
      // Consensus: everyone (who answered) agrees after the first round, or a single participant.
      const agreed = input.agents.length === 1 || (round > 1 && roundTurns.every((t) => t.agree)) || (round === 1 && roundTurns.length > 1 && roundTurns.slice(1).every((t) => t.agree));
      if (roundTurns.length && round >= Math.min(protocol.minRounds, protocol.maxRounds) && agreed) {
        consensus = true;
        break;
      }
      if (!roundTurns.length) break;
    }
    const rounds = Math.min(round, protocol.maxRounds);
    const finals = new Map<string, DiscussionTurn>();
    for (const t of turns) finals.set(t.agentId, t);
    const summary = [...finals.values()].map((t) => `${this.name(input.agents, t.agentId)}: ${t.position}`).join("\n");
    await this.comm.say({
      user: input.user,
      project: input.project,
      speaker: { kind: "moderator" },
      listener: { kind: "user" },
      situation: "report",
      body: consensus ? `${rounds}라운드 만에 의견이 모였어요.\n${summary}` : `${rounds}라운드 동안 완전한 합의는 없었어요. 쟁점을 정리했어요.\n${summary}\n추가 토론이 필요하면 "토론 연장"이라고 말씀해 주세요.`,
      // Experiment metrics for comparing variant A vs B per worldview (PRD §2.1).
      machineState: { kind: "discussion.end", taskId: input.task.id, data: { rounds, consensus, variant: protocol.variant, mode, baseMode: modeDef(mode).baseMode, durationMs: Date.now() - startedAt, turns: turns.length } },
    });
    return { rounds, consensus, summary, turns };
  }

  private name(agents: Agent[], id: string): string {
    return agents.find((a) => a.id === id)?.name ?? id;
  }
}
