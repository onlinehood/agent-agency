import type { Agent, RequestClassification } from "../types.js";

/**
 * Rule-based request understanding (PRD §5-1). Clear instructions become tasks, loose ideas go
 * to the candidate list, questions are answered, and only important ambiguity triggers a question.
 * An LLM moderator may refine this, but the rule layer is always available and deterministic.
 */
export interface Classified {
  classification: RequestClassification;
  mentionedAgentIds: string[];
  repoRef?: string;
  projectName?: string;
  /** Work type hint for new projects (Phase 4: research agency). */
  workType?: "coding" | "research";
  cleanedText: string;
  confidence: number;
}

const GITHUB_URL = /(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?(?=\s|$)/i;

export function extractMentions(text: string, agents: Agent[]): { ids: string[]; cleaned: string } {
  const ids: string[] = [];
  let cleaned = text;
  // Longest names first so "클로드2" wins over "클로드"
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of sorted) {
    const re = new RegExp(`@${escapeRe(a.name)}(?![\\p{L}\\p{N}_])`, "giu");
    if (re.test(cleaned)) {
      ids.push(a.id);
      cleaned = cleaned.replace(re, a.name);
    }
  }
  return { ids, cleaned: cleaned.trim() };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NEW_PROJECT = /(새|신규)\s*(프로젝트|앱|서비스|사이트|저장소|리서치|조사)|프로젝트\s*(를|을)?\s*(만들|생성|시작)|new project|start a project|create (a )?(new )?(project|app)/i;
const IMPORT = /(가져와|가져오|불러와|불러오|연결해|import|연동해)/i;
const IDEA = /(아이디어|나중에|언젠가|하면 어떨까|하면 좋겠|어떨까요|있으면 좋|idea|maybe later|someday|nice to have)/i;
const TASK_VERB = /(추가|구현|만들|고쳐|수정|개선|변경|바꿔|삭제|제거|리팩터|작성|테스트|배포|업데이트|연동|적용|해줘|해 줘|해주세요|부탁|fix|add|implement|create|build|refactor|update|remove|write|change|migrate)/i;
const QUESTION = /(\?|？|뭐야|뭔가요|인가요|나요|까요|어떻게|왜|언제|무엇|what|why|how|when|which)/i;

export function classify(text: string, agents: Agent[], opts: { inProjectTopic: boolean }): Classified {
  const { ids, cleaned } = extractMentions(text, agents);
  const t = cleaned.trim();
  if (/^\/status\b/i.test(t)) return { classification: "status", mentionedAgentIds: ids, cleanedText: t, confidence: 1 };
  if (/^\//.test(t)) return { classification: "command", mentionedAgentIds: ids, cleanedText: t, confidence: 1 };

  const gh = GITHUB_URL.exec(t);
  if (gh && (IMPORT.test(t) || !opts.inProjectTopic)) {
    return { classification: "import_project", mentionedAgentIds: ids, repoRef: `${gh[1]}/${gh[2]}`, cleanedText: t, confidence: 0.9 };
  }

  if (!opts.inProjectTopic && NEW_PROJECT.test(t)) {
    const m = /["“'‘「]([^"”'’」]{2,40})["”'’」]/.exec(t);
    return { classification: "new_project", mentionedAgentIds: ids, projectName: m?.[1], workType: detectWorkType(t), cleanedText: t, confidence: 0.85 };
  }

  const isIdea = IDEA.test(t);
  const isTask = TASK_VERB.test(t);
  const isQuestion = QUESTION.test(t) && !/(해줘|해 줘|해주세요|부탁)/.test(t);

  if (isIdea && !/(해줘|해 줘|해주세요|지금|바로|당장)/.test(t)) return { classification: "idea", mentionedAgentIds: ids, cleanedText: t, confidence: 0.7 };
  if (isQuestion && !isTask) return { classification: "question", mentionedAgentIds: ids, cleanedText: t, confidence: 0.7 };
  if (isTask) return { classification: opts.inProjectTopic ? "task_request" : "task_request", mentionedAgentIds: ids, cleanedText: t, confidence: isQuestion ? 0.5 : 0.8 };
  if (isQuestion) return { classification: "question", mentionedAgentIds: ids, cleanedText: t, confidence: 0.6 };
  return { classification: "unknown", mentionedAgentIds: ids, cleanedText: t, confidence: 0.3 };
}

const RESEARCH = /(조사|리서치|시장\s*분석|분석\s*보고서|보고서|동향|비교\s*분석|research|report|survey|market analysis)/i;
const SOFTWARE = /(앱|어플|사이트|웹|서비스|api|코드|프로그램|봇|백엔드|프론트|app|website|backend|frontend|cli)/i;

/** Research projects are reports; anything that mentions software to build stays coding. */
export function detectWorkType(text: string): "coding" | "research" {
  return RESEARCH.test(text) && !SOFTWARE.test(text) ? "research" : "coding";
}

export function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || `project-${Date.now().toString(36)}`;
}
