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
  },
  construction: {
    mode: "construction",
    labelKo: "노가다",
    labelEn: "Construction",
    titles: { user: "건물주", moderator: "십장", member: "현장 작업자" },
    atmosphere: "현장감 있고 유머가 섞인 실행 중심의 공사 현장",
    emoji: "🏗️",
    moderatorName: "십장",
    teamAddress: "다들",
    baseMode: "construction",
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
  return [...ALL_MODES, ...custom.keys()] as OrganizationMode[];
}

export function isBuiltInMode(v: string): v is BuiltInMode {
  return (ALL_MODES as string[]).includes(v);
}

export function isOrganizationMode(v: string): v is OrganizationMode {
  return isBuiltInMode(v) || custom.has(v);
}

/** Definition for any mode; an unknown (e.g. deleted) custom mode falls back to corporate. */
export function modeDef(mode: OrganizationMode | string): ModeDefinition {
  if (isBuiltInMode(mode)) return MODES[mode];
  return custom.get(mode) ?? MODES.corporate;
}

export function modeTitle(mode: OrganizationMode, role: OrgRole): string {
  return modeDef(mode).titles[role];
}
