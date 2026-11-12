import type { BuiltInMode, OrganizationMode, OrgRole, Persona, PersonaPreset } from "../types.js";
import { modeDef } from "./modes.js";

/**
 * Role-aware dialogue policy (PRD §2.2).
 *
 * Input:  worldview + speaker + listener + situation + affinity + persona
 * Output: a StyleSpec that only affects *expression*. It never touches permissions,
 *         quality gates, task assignment or approvals.
 */

export type Formality = "formal" | "polite" | "casual";

export type Situation =
  | "report" // 결과/진행 보고
  | "discussion" // 토론/의견 교환
  | "request_help" // 질문·도움 요청
  | "instruction" // 지시
  | "approval_request" // 승인 요청
  | "greeting"
  | "error" // 장애/실패 보고
  | "handoff"; // 인계

export interface DialogueContext {
  mode: OrganizationMode;
  speakerRole: OrgRole;
  listenerRole: OrgRole;
  situation: Situation;
  /** 0..1 */
  affinity?: number;
  persona?: Persona | null;
  /** When a message targets several listeners, the explicit listener wins; if unclear this is true. */
  ambiguousAudience?: boolean;
  /** Experimental B-style: collaboration style varies per mode (flag gated). */
  styleVariantB?: boolean;
  /** Task role in the current work (leader, implementer, reviewer, tester), when known. */
  functionalRole?: string;
}

export interface StyleSpec {
  formality: Formality;
  /** How the speaker addresses the listener */
  addressTerm: string;
  /** How the speaker refers to themselves */
  selfTerm: string;
  tone: string[];
  humor: number; // 0..1
  /** Hard rules (always included in prompts) */
  rules: string[];
  /** B-variant collaboration style hint, empty unless enabled */
  collaborationStyle: string | null;
  /** Sentence-ending hint for deterministic templates */
  ending: "습니다" | "요" | "반말";
  /** How someone in this worldview title talks (e.g. 현장소장, 조교). */
  roleVoice: string | null;
  /** How the task role talks (leader, implementer, reviewer, tester). */
  taskVoice: string | null;
  /** Speech habits of the persona preset. */
  personaVoice: string | null;
}

const PERSONA_TONE: Record<PersonaPreset, string[]> = {
  careful: ["꼼꼼함", "근거 중심", "확인을 거듭하는 완벽주의"],
  bold: ["과감함", "빠른 결단", "실행 우선"],
  friendly: ["다정함", "격려", "쉬운 설명"],
  analytical: ["구조적", "수치와 비교 중심", "담백함"],
  mentor: ["차분한 안내", "맥락 설명", "질문을 되묻는 태도"],
  pragmatic: ["실용적", "핵심만", "트레이드오프 명시"],
};

/** Speech habits per persona preset — how the character sounds, on top of PERSONA_TONE. */
const PERSONA_SPEECH: Record<PersonaPreset, string> = {
  careful: "단정하기 전에 확인한 근거를 밝히고, 확실하지 않은 것은 '확인이 필요합니다'라고 분명히 표시한다.",
  bold: "문장을 짧게 끊고 결론부터 말한다. 망설이는 표현 대신 '바로 진행하겠습니다'처럼 단호하게 말한다.",
  friendly: "상대의 수고를 먼저 알아주고 쉬운 말로 설명한다. 감탄사나 이모지는 가끔만 쓴다.",
  analytical: "항목을 나눠 비교하고 가능한 한 숫자로 말한다. 감정 표현은 줄이고 담백하게 말한다.",
  mentor: "결론과 함께 '왜' 그런지 이유를 한 줄 덧붙이고, 필요하면 상대가 생각해 볼 질문을 하나 던진다.",
  pragmatic: "핵심만 짧게 말한다. 선택지가 있으면 장단점을 한 줄씩 붙이고 추천안을 정한다.",
};

/**
 * How each worldview title talks. {user}/{moderator}/{member} become the worldview's titles, so a
 * custom worldview built on a base mode gets the same voice under its own names.
 */
const ROLE_VOICE: Record<BuiltInMode, Partial<Record<OrgRole, string>>> = {
  corporate: {
    moderator: "{moderator}답게 차분하고 정돈된 말투. 결정 사항·일정·담당자를 깔끔하게 정리하고, {member}들에게는 정중하지만 분명하게 요청한다.",
    member: "{member}답게 책임감 있는 말투. 맡은 일의 진행·결과·리스크를 근거와 숫자로 보고하고, 다른 {member}에게는 예의를 갖춰 협조를 구한다.",
  },
  construction: {
    moderator: "{moderator}답게 짧고 시원시원하게 지시한다. 오늘 할 공정, 품질·안전 기준, 마감을 분명히 하고, 작업자의 수고를 알아준다. 거친 말이나 욕설은 쓰지 않는다.",
    member: "{member}답게 소탈하고 시원시원한 말투. '확인했습니다', '바로 들어가겠습니다'처럼 행동 중심으로 말하고, 공정·마감·자재 같은 현장 비유를 가볍게 섞는다(과하지 않게).",
  },
  campus: {
    moderator: "{moderator}답게 친절하고 차분하게 안내한다. 과제 기준과 일정을 정리해 주고, {member}들의 의견을 고르게 모으며, {user}님께는 공손하게 보고한다.",
    member: "{member}답게 성실하고 의욕 있는 말투. 근거를 들어 의견을 내고, 모르는 것은 솔직하게 질문하며, 조원의 의견을 존중한다.",
  },
};

/** How each task role talks in the current work. */
const TASK_VOICE: Record<string, string> = {
  leader: "리더로서 목표·우선순위·결정을 먼저 말하고, 누가 무엇을 언제까지 할지 정리한다.",
  implementer: "구현 담당으로서 무엇을 바꿨고 어떻게 확인했는지(테스트·실행 결과)를 구체적으로 말하고, 남은 일은 솔직하게 밝힌다.",
  reviewer: "리뷰어로서 근거(파일·위치·재현 방법)를 들어 문제를 짚고 고칠 방향을 제안한다. 잘된 점도 하나는 구체적으로 인정하고, 지적은 사람이 아니라 코드에 대해 한다.",
  tester: "테스트 담당으로서 재현 절차, 기대 결과와 실제 결과를 나눠서 말한다.",
};

export const HARD_RULES: string[] = [
  "말투는 표현에만 영향을 주며 기술적 사실·실행 결과·테스트 결과를 바꾸거나 꾸며내지 않는다.",
  "모욕·비하·차별·욕설 남발을 하지 않는다.",
  "조직 내 역할과 예의를 유지한다.",
  "실행 상태(성공/실패/대기)는 캐릭터 대사가 아니라 구조화된 상태 데이터가 기준이다.",
];

function clamp01(n: number | undefined, d = 0.2): number {
  if (n === undefined || !Number.isFinite(n)) return d;
  return Math.max(0, Math.min(1, n));
}

/**
 * Resolve formality from the relationship matrix in PRD §2.2.
 */
export function resolveFormality(ctx: DialogueContext): Formality {
  const { speakerRole, listenerRole } = ctx;
  const def = modeDef(ctx.mode);
  // Custom worldviews inherit the base mode's matrix; overrides below are expression-only.
  const mode = def.baseMode;
  const affinity = clamp01(ctx.affinity);
  const informalAllowed = ctx.persona?.toneBounds?.informalAllowed ?? true;

  if (ctx.ambiguousAudience) return "polite"; // safe public-room register

  const override = def.registerOverrides?.[`${speakerRole}>${listenerRole}`];
  if (override) {
    if (override !== "casual") return override;
    if (!informalAllowed) return "polite";
    // Peers still warm up gradually even when the worldview allows informal speech.
    if (speakerRole === "member" && listenerRole === "member") return affinity >= 0.35 ? "casual" : "polite";
    return "casual";
  }

  // Anyone speaking to the user (CEO/건물주/교수)
  if (listenerRole === "user") {
    if (mode === "construction") return "polite"; // 친근한 존댓말
    return "formal"; // 정중한 존댓말
  }

  // Speaking to moderator
  if (listenerRole === "moderator") {
    if (speakerRole === "user") return "polite";
    return "polite"; // 자연스러운 존댓말
  }

  // Moderator → member
  if (speakerRole === "moderator" && listenerRole === "member") {
    if (mode === "construction") return "casual"; // 현장식 직접 지시 (모욕 금지)
    if (mode === "campus") return "polite";
    return "polite";
  }

  // user → member
  if (speakerRole === "user") return "polite";

  // member ↔ member
  if (speakerRole === "member" && listenerRole === "member") {
    if (mode === "corporate") return "polite"; // 동료 간 존댓말
    if (!informalAllowed) return "polite";
    // campus / construction: casual permitted, more likely as affinity grows
    return affinity >= 0.35 ? "casual" : "polite";
  }

  return "polite";
}

export function resolveStyle(ctx: DialogueContext): StyleSpec {
  const def = modeDef(ctx.mode);
  const formality = resolveFormality(ctx);
  const affinity = clamp01(ctx.affinity);
  const persona = ctx.persona ?? null;
  const personaTone = persona ? PERSONA_TONE[persona.preset] : [];
  const maxHumor = persona?.toneBounds?.humor ?? 1;

  let humor = 0;
  if (def.baseMode === "construction") humor = 0.5;
  if (def.baseMode === "campus") humor = 0.3;
  if (def.baseMode === "corporate") humor = 0.1;
  if (ctx.listenerRole === "user") humor *= 0.5;
  if (ctx.situation === "error" || ctx.situation === "approval_request") humor *= 0.3;
  humor = Math.min(humor + affinity * 0.2, maxHumor);

  const addressTerm = addressTermFor(ctx.mode, ctx.speakerRole, ctx.listenerRole, formality);
  const selfTerm = selfTermFor(ctx.mode, ctx.speakerRole, formality);

  const tone: string[] = [def.atmosphere, ...personaTone];
  switch (ctx.situation) {
    case "report":
      tone.push("결과와 근거를 먼저, 그 다음 세부사항");
      break;
    case "discussion":
      tone.push("상대 의견을 인용하고 동의/반대 지점을 명확히");
      break;
    case "request_help":
      tone.push("무엇이 막혔는지와 필요한 도움을 구체적으로");
      break;
    case "instruction":
      tone.push("해야 할 일·기준·마감이 분명하게");
      break;
    case "approval_request":
      tone.push("위험도·범위·대안을 간결히 제시하고 결정을 요청");
      break;
    case "error":
      tone.push("감정 표현보다 원인·영향·다음 조치");
      break;
    case "handoff":
      tone.push("다음 담당자가 바로 이어갈 수 있는 맥락 요약");
      break;
    case "greeting":
      tone.push("짧고 자연스럽게");
      break;
  }
  if (affinity > 0.6 && ctx.listenerRole === "member") tone.push("오래 함께 일한 동료 같은 편안함");

  const rules = [...HARD_RULES];
  if (persona?.customRules) rules.push(`사용자 지정 성격 지침: ${persona.customRules}`);

  let collaborationStyle: string | null = null;
  if (ctx.styleVariantB) {
    collaborationStyle = {
      corporate: "결론 → 근거 → 리스크 → 요청사항 순의 보고서형 협업",
      construction: "오늘 할 일/막힌 것/도움 필요 순의 짧은 현장 브리핑형 협업",
      campus: "가설 제시 → 반론 → 합의 순의 토론형 협업",
    }[def.baseMode];
  }

  const ending: StyleSpec["ending"] = formality === "formal" ? "습니다" : formality === "polite" ? "요" : "반말";

  const voice = ROLE_VOICE[def.baseMode]?.[ctx.speakerRole];
  const roleVoice = voice ? voice.replace(/\{(user|moderator|member)\}/g, (_, r: OrgRole) => def.titles[r]) : null;
  const taskVoice = ctx.functionalRole ? (TASK_VOICE[ctx.functionalRole] ?? null) : null;
  const personaVoice = persona ? PERSONA_SPEECH[persona.preset] : null;

  return { formality, addressTerm, selfTerm, tone, humor, rules, collaborationStyle, ending, roleVoice, taskVoice, personaVoice };
}

export function addressTermFor(mode: OrganizationMode, speaker: OrgRole, listener: OrgRole, formality: Formality): string {
  const d = modeDef(mode);
  const t = d.titles;
  if (listener === "user") {
    return `${t.user}님`;
  }
  if (listener === "moderator") {
    return `${t.moderator}님`;
  }
  // member listener
  if (speaker === "moderator" && d.baseMode === "construction" && !d.custom) return "{name}";
  if (formality === "casual") return "{name}";
  if (mode === "corporate") return "{name} 팀장님";
  return "{name} 님";
}

export function selfTermFor(mode: OrganizationMode, speaker: OrgRole, formality: Formality): string {
  if (speaker === "user") return "나";
  if (formality === "casual") return "나";
  return "저";
}

/**
 * Natural-language instructions for the LLM prompt. Kept short to limit renderer cost (PRD §13).
 */
export function styleInstructions(ctx: DialogueContext, speakerName: string, listenerName: string): string {
  const s = resolveStyle(ctx);
  const def = modeDef(ctx.mode);
  const addr = ctx.ambiguousAudience ? def.teamAddress : s.addressTerm.replace("{name}", listenerName);
  const lines = [
    `[세계관] ${def.labelKo} 모드 (${def.atmosphere}). 당신은 '${speakerName}'(${def.titles[ctx.speakerRole]}) 이고 '${listenerName}'(${def.titles[ctx.listenerRole]})에게 말합니다.`,
    `[말투] ${formalityKo(s.formality)}. 상대 호칭: "${addr}". 자기 지칭: "${s.selfTerm}". 유머 허용도: ${Math.round(s.humor * 100)}%. 아래 예시 표현도 이 말투(존댓말/반말)에 맞춰 바꿔 쓴다.`,
    `[톤] ${s.tone.join(", ")}.`,
  ];
  if (s.roleVoice) lines.push(`[직책다운 말투] ${s.roleVoice}`);
  if (s.taskVoice) lines.push(`[맡은 역할] ${s.taskVoice}`);
  if (s.personaVoice) lines.push(`[성격다운 말투] ${s.personaVoice}`);
  if (s.collaborationStyle) lines.push(`[협업 스타일] ${s.collaborationStyle}`);
  lines.push(`[규칙] ${s.rules.join(" ")}`);
  return lines.join("\n");
}

export function formalityKo(f: Formality): string {
  switch (f) {
    case "formal":
      return "격식 있는 존댓말(~습니다)";
    case "polite":
      return "자연스러운 존댓말(~요)";
    case "casual":
      return "친근한 반말(모욕·비하 금지)";
  }
}
