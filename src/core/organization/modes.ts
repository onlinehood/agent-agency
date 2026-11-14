import type { BuiltInMode, OrganizationMode, OrgRole } from "../types.js";

export type Register = "formal" | "polite" | "casual";
/** Relationship key "speaker>listener", e.g. "member>member", "moderator>member", "member>user". */
export type RelationKey = `${OrgRole}>${OrgRole}`;

export interface ModeDefinition {
  mode: OrganizationMode;
  labelKo: string;
  labelEn: string;
  /** Display titles for each organization role. */
  titles: Record<OrgRole, string>;
  /** Default atmosphere description used in prompts. */
  atmosphere: string;
  /** Emoji used in Telegram headers */
  emoji: string;
  /** Default name for the moderator persona in this mode. */
  moderatorName: string;
  /** How a whole team is addressed in multi-recipient messages. */
  teamAddress: string;
  /** Built-in mode whose register matrix, humor and collaboration style this mode inherits. */
  baseMode: BuiltInMode;
  /** Register overrides on top of the base mode (expression only). */
  registerOverrides?: Partial<Record<RelationKey, Register>>;
  custom?: boolean;
  /** How each title talks; falls back to the base mode's voices. {user}/{moderator}/{member} = titles. */
  voice?: Partial<Record<OrgRole, string>>;
  /** One short example of how this worldview sounds (keeps lines short and in character). */
  flavor?: string;
}

export const MODES: Record<BuiltInMode, ModeDefinition> = {
  corporate: {
    mode: "corporate",
    labelKo: "회사",
    labelEn: "Corporate",
    titles: { user: "CEO", moderator: "수석비서", member: "팀장" },
    atmosphere: "정중한 보고·회의·조율 중심의 회사 조직",
    emoji: "🏢",
    moderatorName: "수석비서",
    teamAddress: "팀장님들",
    baseMode: "corporate",
    flavor: "보고는 결론 한 줄, 근거 한 줄. 예: \"결론부터 말씀드리면, 오늘 안에 됩니다.\"",
  },
  construction: {
    mode: "construction",
    labelKo: "건설현장",
    labelEn: "Construction",
    titles: { user: "건물주", moderator: "현장소장", member: "현장 작업자" },
    atmosphere: "현장감 있고 유머가 섞인 실행 중심의 건설 현장",
    emoji: "🏗️",
    moderatorName: "현장소장",
    teamAddress: "다들",
    baseMode: "construction",
    flavor: "현장 무전처럼 짧게. 예: \"골조 끝, 마감 들어갑니다.\" \"자재(테스트) 이상 없음!\"",
  },
  campus: {
    mode: "campus",
    labelKo: "대학 조별과제",
    labelEn: "Campus",
    titles: { user: "교수", moderator: "조교", member: "학생" },
    atmosphere: "조별 토론·질문·발표가 오가는 대학 조별과제",
    emoji: "🎓",
    moderatorName: "조교",
    teamAddress: "여러분",
    baseMode: "campus",
    flavor: "조별과제 단톡방처럼 가볍게. 예: \"제가 발표 자료 맡을게요!\" \"교수님, 제출 완료했습니다.\"",
  },
};

/**
 * Ready-made fun worldviews. They reuse a built-in base for registers and humour and add their
 * own titles, voices and flavour. Expression only — permissions and approvals never change.
 */
export const PRESET_MODES: Record<string, ModeDefinition> = {
  "preset:kitchen": {
    mode: "preset:kitchen",
    labelKo: "레스토랑 주방",
    labelEn: "Kitchen",
    titles: { user: "오너", moderator: "헤드셰프", member: "라인쿡" },
    atmosphere: "주문이 쉴 새 없이 들어오는 바쁜 레스토랑 주방. 짧은 콜과 대답이 오간다",
    emoji: "🍳",
    moderatorName: "헤드셰프",
    teamAddress: "다들",
    baseMode: "construction",
    flavor: "주방 콜처럼 짧게. 예: \"주문 들어갑니다! 계산기 하나!\" \"예스 셰프!\" \"플레이팅(PR) 나갑니다.\" 작업=요리, 테스트=맛보기, 배포=서빙 비유를 가볍게.",
    voice: {
      moderator: "{moderator}답게 짧고 분명한 콜로 지시한다. 누가 어떤 요리(작업)를 맡는지, 언제까지 낼지 말한다. 다그치지 않고 칭찬도 짧게.",
      member: "{member}답게 '예스 셰프!'처럼 짧게 받고, 맡은 요리(작업)의 진행을 한두 마디로 콜한다.",
    },
  },
  "preset:mission": {
    mode: "preset:mission",
    labelKo: "우주 관제센터",
    labelEn: "Mission Control",
    titles: { user: "사령관", moderator: "관제실장", member: "승무원" },
    atmosphere: "발사를 앞둔 우주 관제센터. 침착하고 정확한 무선 교신",
    emoji: "🚀",
    moderatorName: "관제실장",
    teamAddress: "전 승무원",
    baseMode: "corporate",
    flavor: "무선 교신처럼 짧고 정확하게. 예: \"관제, 구현 단계 완료. 이상.\" \"발사(배포) 준비 완료.\" 상태는 GO/NO-GO로.",
    voice: {
      moderator: "{moderator}답게 침착하게 단계별 GO/NO-GO를 확인하고, 다음 절차를 한 줄로 지시한다.",
      member: "{member}답게 교신 형식으로 보고한다: 무엇을 했는지, 상태(GO/NO-GO), 다음 할 일. 끝에 '이상.'을 붙여도 된다.",
    },
  },
  "preset:guild": {
    mode: "preset:guild",
    labelKo: "모험가 길드",
    labelEn: "Adventurers' Guild",
    titles: { user: "길드마스터", moderator: "길드 접수원", member: "모험가" },
    atmosphere: "퀘스트를 받고 던전(코드)으로 떠나는 판타지 모험가 길드",
    emoji: "🐉",
    moderatorName: "길드 접수원",
    teamAddress: "모험가 여러분",
    baseMode: "campus",
    flavor: "퀘스트 보고처럼 짧게. 예: \"퀘스트 수락! 계산기 던전 출발합니다.\" \"보스(버그) 처치 완료, 보상(PR) 챙겼어요.\" 작업=퀘스트, 버그=몬스터, 리뷰=감정 비유를 가볍게.",
    voice: {
      moderator: "{moderator}답게 밝게 퀘스트를 안내하고, 누가 어떤 퀘스트를 맡았는지와 보상(결과)을 정리한다.",
      member: "{member}답게 씩씩하게 퀘스트 진행을 보고한다. 비유는 한 번만, 사실은 정확하게.",
    },
  },
};

export const ALL_MODES: BuiltInMode[] = ["corporate", "construction", "campus"];

/* ------------------------------------------------ custom worldview registry */

const custom = new Map<string, ModeDefinition>();

export function registerCustomModes(defs: ModeDefinition[]): void {
  custom.clear();
  for (const d of defs) custom.set(d.mode, { ...d, custom: true });
}

export function customModes(): ModeDefinition[] {
  return [...custom.values()];
}

export function allModes(): OrganizationMode[] {
  return [...ALL_MODES, ...Object.keys(PRESET_MODES), ...custom.keys()] as OrganizationMode[];
}

/** Accept "kitchen", "주방", "레스토랑 주방" or the full id for /mode. */
export function resolveModeArg(arg: string): OrganizationMode | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  for (const m of allModes()) {
    const d = modeDef(m);
    if (m.toLowerCase() === a || m.toLowerCase().endsWith(`:${a}`) || d.labelKo.toLowerCase() === a || d.labelEn.toLowerCase() === a || d.labelKo.replace(/\s+/g, "").includes(a.replace(/\s+/g, ""))) return m;
  }
  return null;
}

export function isBuiltInMode(v: string): v is BuiltInMode {
  return (ALL_MODES as string[]).includes(v);
}

export function isOrganizationMode(v: string): v is OrganizationMode {
  return isBuiltInMode(v) || v in PRESET_MODES || custom.has(v);
}

/** Definition for any mode; an unknown (e.g. deleted) custom mode falls back to corporate. */
export function modeDef(mode: OrganizationMode | string): ModeDefinition {
  if (isBuiltInMode(mode)) return MODES[mode];
  return PRESET_MODES[mode] ?? custom.get(mode) ?? MODES.corporate;
}

export function modeTitle(mode: OrganizationMode, role: OrgRole): string {
  return modeDef(mode).titles[role];
}
