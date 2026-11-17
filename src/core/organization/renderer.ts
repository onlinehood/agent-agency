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

/* ---------- Hangul helpers for sentence endings ---------- */
const HANGUL_BASE = 0xac00;
const isSyllable = (ch: string | undefined): ch is string => !!ch && ch >= "가" && ch <= "힣";
const jongOf = (ch: string) => (ch.charCodeAt(0) - HANGUL_BASE) % 28;
const jungOf = (ch: string) => Math.floor((ch.charCodeAt(0) - HANGUL_BASE) / 28) % 21;
const withJong = (ch: string, j: number) => String.fromCharCode(ch.charCodeAt(0) - jongOf(ch) + j);
const withJung = (ch: string, v: number) => String.fromCharCode(HANGUL_BASE + (Math.floor((ch.charCodeAt(0) - HANGUL_BASE) / 588) * 21 + v) * 28 + jongOf(ch));
const JONG = { none: 0, rieul: 8, bieup: 17, ssang_siot: 20 } as const;
// Vowel indices (jungseong).
const V = { a: 0, ae: 1, ya: 2, eo: 4, e: 5, yeo: 6, o: 8, wa: 9, wae: 10, oe: 11, u: 13, wo: 14, eu: 18, i: 20 } as const;

/** 해요체 for a stem without a final consonant: 보→봐요, 주→줘요, 기다리→기다려요, 되→돼요, 가→가요, 바뀌→바뀌어요. */
function politeFromOpenStem(stem: string): string {
  const last = stem.slice(-1);
  const head = stem.slice(0, -1);
  if (!isSyllable(last)) return `${stem}어요`;
  const v = jungOf(last);
  if ([V.a, V.eo, V.ae, V.e, V.yeo, V.ya].includes(v as never)) return `${stem}요`;
  const contracted: Record<number, number> = { [V.o]: V.wa, [V.u]: V.wo, [V.i]: V.yeo, [V.eu]: V.eo, [V.oe]: V.wae };
  if (contracted[v] !== undefined) return `${head}${withJung(last, contracted[v]!)}요`;
  return `${stem}어요`;
}

/** 습니다/ㅂ니다 → 해요체. */
function toPolite(body: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^(.*)했습니다$/u.exec(body))) return `${m[1]}했어요`;
  if ((m = /^(.*)것입니다$/u.exec(body))) return `${m[1]}거예요`;
  if ((m = /^(.*?)([가-힣])입니다$/u.exec(body))) return `${m[1]}${m[2]}${jongOf(m[2]!) ? "이에요" : "예요"}`;
  if ((m = /^(.*)합니다$/u.exec(body))) return `${m[1]}해요`;
  if ((m = /^(.*?)([가-힣])습니다$/u.exec(body))) {
    // 있습니다→있어요, 좋습니다→좋아요, 하겠습니다→하겠어요
    const bright = [V.a, V.o].includes(jungOf(m[2]!) as never);
    return `${m[1]}${m[2]}${bright ? "아요" : "어요"}`;
  }
  if ((m = /^(.*?)([가-힣])니다$/u.exec(body)) && jongOf(m[2]!) === JONG.bieup) return politeFromOpenStem(`${m[1]}${withJong(m[2]!, JONG.none)}`);
  return null;
}

/** 해요체 → 합니다체 (only forms it can convert correctly; others stay as they are). */
function toFormal(body: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^(.*)거예요$/u.exec(body))) return `${m[1]}것입니다`;
  if ((m = /^(.*)(이에요|예요)$/u.exec(body))) return `${m[1]}입니다`;
  if ((m = /^(.*)해요$/u.exec(body))) return `${m[1]}합니다`;
  // 할게요→하겠습니다, 드릴게요→드리겠습니다
  if ((m = /^(.*?)([가-힣])게요$/u.exec(body)) && jongOf(m[2]!) === JONG.rieul) return `${m[1]}${withJong(m[2]!, JONG.none)}겠습니다`;
  const contracted: Record<string, string> = { 돼요: "됩니다", 봐요: "봅니다", 줘요: "줍니다", 와요: "옵니다", 가요: "갑니다", 써요: "씁니다" };
  for (const [from, to] of Object.entries(contracted)) if (body.endsWith(from)) return body.slice(0, -from.length) + to;
  if ((m = /^(.*?)([가-힣])(어|아)요$/u.exec(body))) {
    const x = m[2]!;
    // 있어요→있습니다, 했어요→했습니다, 좋아요→좋습니다 / 바뀌어요→바뀝니다
    return jongOf(x) ? `${m[1]}${x}습니다` : `${m[1]}${withJong(x, JONG.bieup)}니다`;
  }
  return null;
}

/** 반말 for the few forms that convert reliably. */
function toCasual(body: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^(.*)했(습니다|어요)$/u.exec(body))) return `${m[1]}했어`;
  if ((m = /^(.*?)([가-힣])(입니다|이에요|예요)$/u.exec(body))) return `${m[1]}${m[2]}${jongOf(m[2]!) ? "이야" : "야"}`;
  if ((m = /^(.*)(합니다|해요)$/u.exec(body))) return `${m[1]}해`;
  return null;
}

/**
 * Convert a neutral sentence ending into the target register. Light-touch and spelling-safe:
 * a form it cannot convert correctly (e.g. irregular stems) is left as written.
 */
export function applyEnding(sentence: string, ending: StyleSpec["ending"]): string {
  const s = sentence.trim();
  if (!s) return s;
  const m = /^(.*?)([.!?…~]*)$/su.exec(s)!;
  const body = m[1]!;
  const punct = m[2] ?? "";
  const out = ending === "습니다" ? toFormal(body) : ending === "요" ? toPolite(body) : toCasual(body);
  return out === null ? s : `${out}${punct}`;
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
    functionalRole: input.speaker.functionalRole,
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
  // Like a messenger: no "CEO님," in front of every line. The header already says who speaks.
  const bodyLines = input.body.split("\n").map((l) => applyEnding(l, style.ending));
  const text = bodyLines.join("\n");
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
