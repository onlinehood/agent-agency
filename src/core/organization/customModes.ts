import { z } from "zod";
import type { Repos } from "../../db/repositories.js";
import { isBuiltInMode, registerCustomModes, type ModeDefinition, type RelationKey } from "./modes.js";
import type { BuiltInMode } from "../types.js";

/**
 * User-defined worldviews (Phase 4 "사용자 정의 세계관"). Stored installation-wide in settings and
 * loaded into the mode registry. A custom worldview changes expression only: titles, atmosphere,
 * emoji, team address and per-relationship register. Hard dialogue rules (no fabrication, no
 * insults) and every policy (approvals, quality gate, permissions, cost) are untouched.
 */
const KEY = "custom_modes";
const text = (max: number) => z.string().trim().min(1).max(max);
const register = z.enum(["formal", "polite", "casual"]);

export const CustomModeInput = z.object({
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "영문 소문자·숫자·하이픈 2~31자"),
  labelKo: text(20),
  emoji: z.string().trim().min(1).max(8),
  atmosphere: text(80),
  baseMode: z.enum(["corporate", "construction", "campus"]),
  titles: z.object({ user: text(12), moderator: text(12), member: text(12) }),
  moderatorName: text(12).optional(),
  teamAddress: text(12),
  registerOverrides: z.partialRecord(z.enum(["member>member", "member>user", "moderator>member", "member>moderator", "moderator>user"]), register).optional(),
});
export type CustomModeInput = z.infer<typeof CustomModeInput>;

export function toDefinition(i: CustomModeInput): ModeDefinition {
  return {
    mode: `custom:${i.slug}`,
    labelKo: i.labelKo,
    labelEn: i.slug,
    titles: i.titles,
    atmosphere: i.atmosphere,
    emoji: i.emoji,
    moderatorName: i.moderatorName ?? i.titles.moderator,
    teamAddress: i.teamAddress,
    baseMode: i.baseMode as BuiltInMode,
    registerOverrides: i.registerOverrides as Partial<Record<RelationKey, "formal" | "polite" | "casual">> | undefined,
    custom: true,
  };
}

export async function listCustomModeInputs(repos: Repos): Promise<CustomModeInput[]> {
  return (await repos.settings.get<CustomModeInput[]>("system", "", KEY)) ?? [];
}

export async function loadCustomModes(repos: Repos): Promise<ModeDefinition[]> {
  const defs: ModeDefinition[] = [];
  for (const raw of await listCustomModeInputs(repos)) {
    const p = CustomModeInput.safeParse(raw);
    if (p.success) defs.push(toDefinition(p.data));
  }
  registerCustomModes(defs);
  return defs;
}

export async function saveCustomMode(repos: Repos, input: unknown): Promise<ModeDefinition> {
  const parsed = CustomModeInput.parse(input);
  if (isBuiltInMode(parsed.slug)) throw new Error("기본 세계관 이름은 사용할 수 없습니다.");
  const list = (await listCustomModeInputs(repos)).filter((m) => m.slug !== parsed.slug);
  if (list.length >= 20) throw new Error("사용자 정의 세계관은 최대 20개입니다.");
  list.push(parsed);
  await repos.settings.set("system", "", KEY, list);
  await loadCustomModes(repos);
  return toDefinition(parsed);
}

/** Delete a custom worldview; users currently on it fall back to its base mode. */
export async function deleteCustomMode(repos: Repos, slug: string): Promise<number> {
  const list = await listCustomModeInputs(repos);
  const target = list.find((m) => m.slug === slug);
  if (!target) return 0;
  await repos.settings.set("system", "", KEY, list.filter((m) => m.slug !== slug));
  const affected = await repos.db.query<{ user_id: string }>("UPDATE organization_profiles SET mode=$1, updated_at=now() WHERE mode=$2 RETURNING user_id", [target.baseMode, `custom:${slug}`]);
  await loadCustomModes(repos);
  return affected.length;
}
