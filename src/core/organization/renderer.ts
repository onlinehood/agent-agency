import type { Agent, MachineState, OrganizationMode, OrgRole, Persona } from "../types.js";
import { modeDef } from "./modes.js";
import { resolveStyle, styleInstructions, type DialogueContext, type Situation, type StyleSpec } from "./dialogue.js";

/**
 * Dialogue Renderer (PRD §6.1-3).
 * Produces user-facing character text from structured facts and keeps the
 * machine-readable state separate. Deterministic templates are used for system
 * messages so that the renderer cost stays low and facts cannot be altered.
 */

export interface RenderedMessage {
  /** Telegram-ready text (Markdown-free plain text; formatting applied by gateway) */
  text: string;
  /** Speaker label shown in the header */
  speakerLabel: string;
  /** Listener label shown in the header */
  listenerLabel: string;
  style: StyleSpec;
  machineState: MachineState;
}

export interface Speaker {
  name: string;
  orgRole: OrgRole;
  functionalRole?: string;
  persona?: Persona | null;
}

export interface Listener {
  name: string;
  orgRole: OrgRole;
}

export interface RenderInput {
  mode: OrganizationMode;
  speaker: Speaker;
  listener: Listener;
  situation: Situation;
  affinity?: number;
  ambiguousAudience?: boolean;
  styleVariantB?: boolean;
  /** Plain factual body (already composed, e.g. by LLM or template). */
  body: string;
  machineState: MachineState;
}

/** Convert a neutral sentence ending into the target register. Only a light-touch, safe transformation. */
export function applyEnding(sentence: string, ending: StyleSpec["ending"]): string {
  let s = sentence.trim();
  if (!s) return s;
  if (ending === "습니다") {
    s = s.replace(/했어요([.!?]?)$/u, "했습니다$1").replace(/이에요([.!?]?)$/u, "입니다$1").replace(/예요([.!?]?)$/u, "입니다$1").replace(/해요([.!?]?)$/u, "합니다$1").replace(/어요([.!?]?)$/u, "습니다$1");
  } else if (ending === "요") {
    s = s.replace(/했습니다([.!?]?)$/u, "했어요$1").replace(/입니다([.!?]?)$/u, "이에요$1").replace(/합니다([.!?]?)$/u, "해요$1");
  } else {
    s = s.replace(/했습니다([.!?]?)$/u, "했어$1").replace(/했어요([.!?]?)$/u, "했어$1").replace(/입니다([.!?]?)$/u, "이야$1").replace(/이에요([.!?]?)$/u, "이야$1").replace(/합니다([.!?]?)$/u, "해$1").replace(/해요([.!?]?)$/u, "해$1");
  }
  return s;
}

export function toDialogueContext(input: Omit<RenderInput, "body" | "machineState">): DialogueContext {
  return {
    mode: input.mode,
    speakerRole: input.speaker.orgRole,
    listenerRole: input.listener.orgRole,
    situation: input.situation,
    affinity: input.affinity,
    persona: input.speaker.persona ?? null,
    ambiguousAudience: input.ambiguousAudience,
    styleVariantB: input.styleVariantB,
  };
}

export function speakerLabel(mode: OrganizationMode, speaker: Speaker): string {
  const title = modeDef(mode).titles[speaker.orgRole];
  const fr = speaker.functionalRole ? ` · ${speaker.functionalRole}` : "";
  return `${speaker.name} (${title}${fr})`;
}

export function listenerLabel(mode: OrganizationMode, listener: Listener): string {
  const title = modeDef(mode).titles[listener.orgRole];
  return `${listener.name} (${title})`;
}


export function render(input: RenderInput): RenderedMessage {
  const ctx = toDialogueContext(input);
  const style = resolveStyle(ctx);
  const addr = input.ambiguousAudience ? modeDef(input.mode).teamAddress : style.addressTerm.replace("{name}", input.listener.name);
  const bodyLines = input.body.split("\n").map((l) => applyEnding(l, style.ending));
  const text = `${addr}, ${bodyLines.join("\n")}`;
  return {
    text,
    speakerLabel: speakerLabel(input.mode, input.speaker),
    listenerLabel: listenerLabel(input.mode, input.listener),
    style,
    machineState: input.machineState,
  };
}

/** Build the LLM-facing style prompt for an agent speaking to a listener. */
export function promptFor(input: Omit<RenderInput, "body" | "machineState">): string {
  const ctx = toDialogueContext(input);
  return styleInstructions(ctx, input.speaker.name, input.listener.name);
}

export function agentOrgRole(agent: Pick<Agent, "organizationRole">, isModerator: boolean): OrgRole {
  if (agent.organizationRole !== "auto") return agent.organizationRole;
  return isModerator ? "moderator" : "member";
}

/** Standard templates (neutral polite register; renderer adapts endings). */
export const templates = {
  taskAssigned: (task: string) => `'${task}' 작업을 맡게 되었어요. 바로 시작할게요.`,
  taskDone: (task: string) => `'${task}' 작업을 마쳤어요. 테스트와 리뷰 결과를 확인해 주세요.`,
  blocked: (task: string, reason: string) => `'${task}' 작업이 막혔어요. 사유: ${reason}`,
  approvalNeeded: (summary: string) => `승인이 필요해요. ${summary}`,
  discussionOpen: (topic: string) => `'${topic}' 건으로 의견을 모아볼게요.`,
  handoff: (task: string, next: string) => `'${task}' 작업을 ${next}에게 넘길게요. 핵심 맥락을 정리해 두었어요.`,
  greeting: (mode: OrganizationMode) => `${modeDef(mode).labelKo} 모드로 준비됐어요. 무엇을 도와드릴까요?`,
};
