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
    // Messenger style: no "CEO님," in front; the worldview shows in the register and the header.
    expect(out[0]!.text).toBe("테스트를 모두 통과했습니다.");
    expect(out[1]!.text).toBe("테스트를 모두 통과했어요.");
    expect(out[2]!.text).toBe("테스트를 모두 통과했습니다.");
    for (const o of out) expect(o.machineState).toEqual(facts.machineState);
    expect(out[1]!.speakerLabel).toContain(MODES.construction.titles.member);
  });

  it("addresses a whole team with a group term, not a name", () => {
    const r = render({ mode: "campus", speaker: { name: "조교", orgRole: "moderator" }, listener: { name: "팀", orgRole: "member" }, situation: "instruction", ambiguousAudience: true, body: "배정할게요.", machineState: { kind: "x" } });
    expect(r.text).toBe("배정할게요."); // no "여러분," prefix in messenger style
  });

  it("ending conversion is light-touch", () => {
    expect(applyEnding("끝냈어요.", "반말")).toBe("끝냈어요."); // unknown form untouched
    expect(applyEnding("완료했어요.", "반말")).toBe("완료했어.");
    expect(applyEnding("완료했습니다", "요")).toBe("완료했어요");
  });

  it("ending conversion keeps Korean spelling right (no '바뀌습니다')", () => {
    const formal: Array<[string, string]> = [
      ["표현만 바뀌어요.", "표현만 바뀝니다."],
      ["그대로예요.", "그대로입니다."],
      ["준비가 됐어요", "준비가 됐습니다"],
      ["문제가 없어요!", "문제가 없습니다!"],
      ["결과가 좋아요", "결과가 좋습니다"],
      ["바로 시작할게요.", "바로 시작하겠습니다."],
      ["보고 드릴게요", "보고 드리겠습니다"],
      ["이건 계산기예요", "이건 계산기입니다"],
      ["다음 단계로 가요", "다음 단계로 갑니다"],
      ["승인돼요", "승인됩니다"],
      ["확인해 주세요.", "확인해 주세요."], // request form stays
      ["진행할까요?", "진행할까요?"], // question stays
    ];
    for (const [from, to] of formal) expect(applyEnding(from, "습니다")).toBe(to);
    const polite: Array<[string, string]> = [
      ["표현만 바뀝니다.", "표현만 바뀌어요."],
      ["결과입니다", "결과예요"],
      ["책입니다", "책이에요"],
      ["준비됩니다", "준비돼요"],
      ["잠시 기다립니다", "잠시 기다려요"],
      ["문제 없습니다", "문제 없어요"],
      ["좋습니다", "좋아요"],
    ];
    for (const [from, to] of polite) expect(applyEnding(from, "요")).toBe(to);
    expect(applyEnding("계산기입니다.", "반말")).toBe("계산기야.");
    expect(applyEnding("결과입니다.", "반말")).toBe("결과야.");
    expect(applyEnding("책이에요", "반말")).toBe("책이야");
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
    expect(resolveModeArg("coporate")).toBe("corporate"); // small typo
    expect(resolveModeArg("constrution")).toBe("construction");
    expect(resolveModeArg("xyzzy")).toBeNull();
    const chef = styleInstructions({ mode: "preset:kitchen", speakerRole: "moderator", listenerRole: "member", situation: "instruction" }, "클로", "덱스");
    expect(chef).toContain("헤드셰프답게");
    expect(chef).toContain("예스 셰프");
    expect(modeDef("preset:mission").titles).toEqual({ user: "사령관", moderator: "관제실장", member: "승무원" });
    // Presets inherit a base register matrix: mission control talks to the 사령관 formally.
    expect(resolveFormality({ mode: "preset:mission", speakerRole: "member", listenerRole: "user", situation: "report" })).toBe("formal");
  });
});
