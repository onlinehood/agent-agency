import { describe, it, expect } from "vitest";
import { resolveFormality, resolveStyle, styleInstructions } from "../src/core/organization/dialogue.js";
import { render, applyEnding } from "../src/core/organization/renderer.js";
import { MODES, PRESET_MODES, allModes, modeDef, resolveModeArg } from "../src/core/organization/modes.js";
import { autopilotIntent, autopilotCovers } from "../src/core/approvals/autopilot.js";

describe("role-aware dialogue (PRD §2.2)", () => {
  it("matches the relationship matrix", () => {
    expect(resolveFormality({ mode: "campus", speakerRole: "member", listenerRole: "user", situation: "report" })).toBe("formal");
    expect(resolveFormality({ mode: "campus", speakerRole: "member", listenerRole: "moderator", situation: "request_help" })).toBe("polite");
    expect(resolveFormality({ mode: "campus", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.5 })).toBe("casual");
    expect(resolveFormality({ mode: "corporate", speakerRole: "member", listenerRole: "user", situation: "report" })).toBe("formal");
    expect(resolveFormality({ mode: "corporate", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.9 })).toBe("polite");
    expect(resolveFormality({ mode: "construction", speakerRole: "member", listenerRole: "user", situation: "report" })).toBe("polite");
    expect(resolveFormality({ mode: "construction", speakerRole: "moderator", listenerRole: "member", situation: "instruction" })).toBe("casual");
    expect(resolveFormality({ mode: "construction", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.4 })).toBe("casual");
  });

  it("the construction worldview is called 건설현장 with a 현장소장", () => {
    expect(MODES.construction.labelKo).toBe("건설현장");
    expect(MODES.construction.titles.moderator).toBe("현장소장");
    expect(JSON.stringify(MODES)).not.toMatch(/노가다|십장/);
  });

  it("each title, task role and personality gets its own way of talking", () => {
    const site = styleInstructions({ mode: "construction", speakerRole: "moderator", listenerRole: "member", situation: "instruction" }, "클로", "덱스");
    expect(site).toContain("[직책다운 말투] 현장소장답게");
    expect(site).toContain("욕설은 쓰지 않는다");
    const ta = resolveStyle({ mode: "campus", speakerRole: "moderator", listenerRole: "user", situation: "report" });
    expect(ta.roleVoice).toContain("교수님께는 공손하게");
    const review = styleInstructions(
      { mode: "corporate", speakerRole: "member", listenerRole: "member", situation: "discussion", functionalRole: "reviewer", persona: { id: "p", preset: "bold", customRules: null, toneBounds: {} } },
      "클로",
      "덱스",
    );
    expect(review).toContain("[맡은 역할] 리뷰어로서");
    expect(review).toContain("[성격다운 말투] 문장을 짧게 끊고 결론부터");
    expect(review).toContain("팀장답게");
    // No task role known → no task line; the user never gets a voice.
    expect(styleInstructions({ mode: "corporate", speakerRole: "member", listenerRole: "user", situation: "report" }, "a", "b")).not.toContain("[맡은 역할]");
    expect(resolveStyle({ mode: "corporate", speakerRole: "user", listenerRole: "member", situation: "instruction" }).roleVoice).toBeNull();
  });

  it("uses a safe public register when the audience is ambiguous", () => {
    expect(resolveFormality({ mode: "construction", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 1, ambiguousAudience: true })).toBe("polite");
  });

  it("affinity changes expression gradually but persona can forbid informal speech", () => {
    expect(resolveFormality({ mode: "campus", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.1 })).toBe("polite");
    expect(resolveFormality({ mode: "campus", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.9, persona: { id: "p", preset: "careful", customRules: null, toneBounds: { informalAllowed: false } } })).toBe("polite");
  });

  it("always carries the hard rules (no fabrication, no insults)", () => {
    const s = resolveStyle({ mode: "construction", speakerRole: "moderator", listenerRole: "member", situation: "instruction" });
    expect(s.rules.join(" ")).toContain("꾸며내지");
    expect(s.rules.join(" ")).toContain("모욕");
    expect(s.collaborationStyle).toBeNull();
    expect(resolveStyle({ mode: "campus", speakerRole: "member", listenerRole: "member", situation: "discussion", styleVariantB: true }).collaborationStyle).toContain("토론");
  });

  it("renders the same fact differently per worldview without changing the machine state", () => {
    const facts = { body: "테스트를 모두 통과했어요.", machineState: { kind: "quality.gate", status: "passed" } };
    const out = (["corporate", "construction", "campus"] as const).map((mode) =>
      render({ mode, speaker: { name: "클로드", orgRole: "member" }, listener: { name: "대표", orgRole: "user" }, situation: "report", ...facts }),
    );
    expect(out[0]!.text).toContain("CEO님");
    expect(out[0]!.text).toContain("통과했습니다");
    expect(out[1]!.text).toContain("건물주님");
    expect(out[2]!.text).toContain("교수님");
    for (const o of out) expect(o.machineState).toEqual(facts.machineState);
    expect(out[1]!.speakerLabel).toContain(MODES.construction.titles.member);
  });

  it("addresses a whole team with a group term, not a name", () => {
    const r = render({ mode: "campus", speaker: { name: "조교", orgRole: "moderator" }, listener: { name: "팀", orgRole: "member" }, situation: "instruction", ambiguousAudience: true, body: "배정할게요.", machineState: { kind: "x" } });
    expect(r.text.startsWith("여러분,")).toBe(true);
  });

  it("ending conversion is light-touch", () => {
    expect(applyEnding("끝냈어요.", "반말")).toBe("끝냈어요."); // unknown form untouched
    expect(applyEnding("완료했어요.", "반말")).toBe("완료했어.");
    expect(applyEnding("완료했습니다", "요")).toBe("완료했어요");
  });

  it("recognises 자동 진행 requests without catching feature requests or risky actions", () => {
    expect(autopilotIntent("자동으로 진행해")).toBe("on");
    expect(autopilotIntent("끝까지 알아서 해줘")).toBe("on");
    expect(autopilotIntent("승인 없이 진행해")).toBe("on");
    expect(autopilotIntent("자동 승인 꺼줘")).toBe("off");
    expect(autopilotIntent("단계마다 확인해줘")).toBe("off");
    expect(autopilotIntent("자동 승인 기능 추가해줘")).toBeNull();
    expect(autopilotIntent("로그인 화면 만들어줘")).toBeNull();
    expect(autopilotCovers("pr_merge")).toBe(true);
    for (const risky of ["deploy_production", "prod_db_change", "permanent_delete", "destructive_operation", "paid_api_usage", "cost_increase", "security_change", "upgrade"] as const) expect(autopilotCovers(risky)).toBe(false);
  });

  it("every line is asked to be short, with the worldview's own flavour", () => {
    const site = styleInstructions({ mode: "construction", speakerRole: "member", listenerRole: "user", situation: "report" }, "덱스", "건물주");
    expect(site).toContain("[길이] 기본 1~3문장");
    expect(site).toContain("[말맛] 현장 무전처럼 짧게");
  });

  it("ready-made fun worldviews: kitchen, mission control, guild", () => {
    expect(Object.keys(PRESET_MODES)).toEqual(["preset:kitchen", "preset:mission", "preset:guild"]);
    for (const m of Object.keys(PRESET_MODES)) expect(allModes()).toContain(m);
    expect(resolveModeArg("주방")).toBe("preset:kitchen");
    expect(resolveModeArg("kitchen")).toBe("preset:kitchen");
    expect(resolveModeArg("우주 관제센터")).toBe("preset:mission");
    expect(resolveModeArg("길드")).toBe("preset:guild");
    expect(resolveModeArg("건설현장")).toBe("construction");
    const chef = styleInstructions({ mode: "preset:kitchen", speakerRole: "moderator", listenerRole: "member", situation: "instruction" }, "클로", "덱스");
    expect(chef).toContain("헤드셰프답게");
    expect(chef).toContain("예스 셰프");
    expect(modeDef("preset:mission").titles).toEqual({ user: "사령관", moderator: "관제실장", member: "승무원" });
    // Presets inherit a base register matrix: mission control talks to the 사령관 formally.
    expect(resolveFormality({ mode: "preset:mission", speakerRole: "member", listenerRole: "user", situation: "report" })).toBe("formal");
  });
});
