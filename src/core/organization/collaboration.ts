import type { OrganizationMode } from "../types.js";
import { modeDef } from "./modes.js";

/**
 * Collaboration protocols (PRD §2.1 "B 선택형 실험", Phase 4). Variant A is the default protocol.
 * Variant B (flag `dialogue.style_variant_b`) changes how a discussion actually runs per worldview:
 *  - corporate: proposal (conclusion → evidence → risk) then a risk review with a final recommendation
 *  - construction: one short site briefing (do / blocked / need), a second round only on disagreement
 *  - campus: hypothesis vs. an assigned rebuttal, then a consensus round (at least two rounds)
 * Only discussion structure and phrasing change; approvals, quality gates and permissions do not.
 */
export type Variant = "A" | "B";

export interface DiscussionProtocol {
  variant: Variant;
  maxRounds: number;
  minRounds: number;
  positionLength: string;
  instruction(round: number, agentIndex: number): string;
}

export function protocolFor(mode: OrganizationMode, variantB: boolean, requestedMax: number): DiscussionProtocol {
  if (!variantB) {
    return {
      variant: "A",
      maxRounds: requestedMax,
      minRounds: 1,
      positionLength: "1~3문장",
      instruction: (round) => `라운드 ${round}/${requestedMax}. 다른 의견에 동의하면 agree=true. 새 근거 없이 반복하지 마세요.`,
    };
  }
  switch (modeDef(mode).baseMode) {
    case "corporate":
      return {
        variant: "B",
        maxRounds: 2,
        minRounds: 1,
        positionLength: "결론·근거·리스크 각 1문장",
        instruction: (round) =>
          round === 1 ? "보고서형 1라운드(제안): 결론 → 근거 → 리스크 순서로 쓰세요." : "보고서형 2라운드(검토): 다른 제안의 리스크를 짚고 최종 권고를 내리세요. 수용 가능하면 agree=true.",
      };
    case "construction":
      return {
        variant: "B",
        maxRounds: 2,
        minRounds: 1,
        positionLength: "2문장 이내",
        instruction: (round) => (round === 1 ? "현장 브리핑: 할 일 / 막힌 것 / 필요한 도움을 2문장 이내로. 이견이 없으면 agree=true." : "이견만 짧게 조율하세요. 정리되면 agree=true."),
      };
    case "campus":
      return {
        variant: "B",
        maxRounds: 3,
        minRounds: 2,
        positionLength: "1~3문장",
        instruction: (round, agentIndex) => {
          if (round === 1) return agentIndex === 0 ? "토론형 1라운드: 가설(제안)을 세우세요." : "토론형 1라운드: 당신은 반론자입니다. 앞선 가설의 가장 큰 약점을 근거와 함께 반박하세요 (agree=false).";
          return "토론형 합의 라운드: 반론을 반영한 합의안을 내세요. 합의하면 agree=true.";
        },
      };
  }
}
