import type { OrganizationMode, OrgRole, Persona, PersonaPreset } from "../types.js";
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
}

const PERSONA_TONE: Record<PersonaPreset, string[]> = {
  careful: ["꼼꼼함", "근거 중심", "확인을 거듭하는 완벽주의"],
  bold: ["과감함", "빠른 결단", "실행 우선"],
  friendly: ["다정함", "격려", "쉬운 설명"],
  analytical: ["구조적", "수치와 비교 중심", "담백함"],
  mentor: ["차분한 안내", "맥락 설명", "질문을 되묻는 태도"],
  pragmatic: ["실용적", "핵심만", "트레이드오프 명시"],
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

  return { formality, addressTerm, selfTerm, tone, humor, rules, collaborationStyle, ending };
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
    `[말투] ${formalityKo(s.formality)}. 상대 호칭: "${addr}". 자기 지칭: "${s.selfTerm}". 유머 허용도: ${Math.round(s.humor * 100)}%.`,
    `[톤] ${s.tone.join(", ")}.`,
  ];
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
