import type { AppContext } from "../context.js";
import type { Agent, MachineState, OrganizationMode, OrgRole, Project } from "../types.js";
import type { User } from "../../db/repositories.js";
import { agentOrgRole, promptFor, render, type Listener, type Speaker } from "../organization/renderer.js";
import type { Situation } from "../organization/dialogue.js";
import { modeDef } from "../organization/modes.js";
import type { Button, SentRef } from "./ports.js";
import { maskKnown } from "../../security/masking.js";
import type { DialogueStylist } from "../organization/stylist.js";

export type SpeakerRef = { kind: "agent"; agent: Agent } | { kind: "moderator" } | { kind: "system" };
export type ListenerRef = { kind: "user" } | { kind: "agent"; agent: Agent } | { kind: "team" } | { kind: "moderator" };

export interface SayInput {
  user: User;
  project?: Project | null;
  speaker: SpeakerRef;
  listener: ListenerRef;
  situation: Situation;
  body: string;
  machineState: MachineState;
  buttons?: Button[][];
  /** Body already in character (LLM output). Skips address prefix and ending conversion. */
  inCharacter?: boolean;
  preformatted?: boolean;
  taskId?: string | null;
}

type ResolvedSpeaker = Speaker & { agentId: string | null };
type ResolvedListener = Listener & { agentId: string | null; ambiguous: boolean };

/**
 * Turns structured events into role-aware character messages, stores the raw event with its
 * machine state in PostgreSQL (source of truth), and delivers it to Telegram via the port.
 */
export class Communicator {
  private stylist: DialogueStylist | null = null;

  constructor(private ctx: AppContext) {}

  setStylist(s: DialogueStylist): void {
    this.stylist = s;
  }

  /** "chat" (default): only conversation-worthy messages; "log": every step, as before. */
  async chatStyle(user: User): Promise<"chat" | "log"> {
    return (await this.ctx.repos.settings.get<string>("user", user.id, CHAT_STYLE_KEY)) === "log" ? "log" : "chat";
  }

  async mode(user: User): Promise<OrganizationMode> {
    return (await this.ctx.repos.users.getProfile(user.id)).mode;
  }

  private async moderatorAgent(user: User): Promise<Agent | null> {
    const id = (await this.ctx.repos.users.getProfile(user.id)).moderatorAgentId;
    return (await this.ctx.repos.agents.find(id)) ?? null;
  }

  async speaker(user: User, ref: SpeakerRef): Promise<ResolvedSpeaker> {
    const mode = await this.mode(user);
    const mod = await this.moderatorAgent(user);
    if (ref.kind === "agent") {
      return { name: ref.agent.name, orgRole: agentOrgRole(ref.agent, mod?.id === ref.agent.id), persona: await this.ctx.repos.personas.find(ref.agent.personaId), agentId: ref.agent.id };
    }
    if (ref.kind === "moderator") {
      if (mod) return { name: mod.name, orgRole: "moderator", persona: await this.ctx.repos.personas.find(mod.personaId), agentId: mod.id };
      return { name: modeDef(mode).moderatorName, orgRole: "moderator", persona: null, agentId: null };
    }
    return { name: "AgentAgency", orgRole: "moderator", persona: null, agentId: null };
  }

  async listener(user: User, ref: ListenerRef): Promise<ResolvedListener> {
    const mode = await this.mode(user);
    if (ref.kind === "user") return { name: user.displayName ?? modeDef(mode).titles.user, orgRole: "user", agentId: null, ambiguous: false };
    if (ref.kind === "agent") {
      const mod = await this.moderatorAgent(user);
      return { name: ref.agent.name, orgRole: agentOrgRole(ref.agent, mod?.id === ref.agent.id), agentId: ref.agent.id, ambiguous: false };
    }
    if (ref.kind === "moderator") return { ...(await this.speaker(user, { kind: "moderator" })), ambiguous: false };
    // Team / multiple recipients: safe public-room register (PRD §2.2).
    return { name: "팀", orgRole: "member", agentId: null, ambiguous: true };
  }

  async affinity(user: User, a: string | null, b: string | null): Promise<number | undefined> {
    if (!a || !b) return undefined;
    return (await this.ctx.repos.relationships.get(user.id, a, b)).affinity;
  }

  /** Style instructions for an agent prompt (expression only). */
  async styleFor(user: User, agent: Agent, listenerRef: ListenerRef, situation: Situation, functionalRole?: string): Promise<string> {
    const sp = { ...(await this.speaker(user, { kind: "agent", agent })), functionalRole };
    const li = await this.listener(user, listenerRef);
    return promptFor({
      mode: await this.mode(user),
      speaker: sp,
      listener: li,
      situation,
      affinity: await this.affinity(user, sp.agentId, li.agentId),
      ambiguousAudience: li.ambiguous,
      styleVariantB: await this.ctx.flags.isEnabled("dialogue.style_variant_b", user.id),
    });
  }

  async say(input: SayInput): Promise<SentRef | null> {
    const mode = await this.mode(input.user);
    const sp = await this.speaker(input.user, input.speaker);
    const li = await this.listener(input.user, input.listener);
    const secrets = await this.ctx.vault.allValuesForMasking(input.user.id);
    let text: string;
    let header: string;
    if (input.inCharacter || input.speaker.kind === "system") {
      text = input.body;
      header = input.speaker.kind === "system" ? "⚙️ AgentAgency" : chatHeader(modeDef(mode).emoji, sp, li);
    } else {
      const renderInput = {
        mode,
        speaker: sp,
        listener: li,
        situation: input.situation,
        affinity: await this.affinity(input.user, sp.agentId, li.agentId),
        ambiguousAudience: li.ambiguous,
        styleVariantB: await this.ctx.flags.isEnabled("dialogue.style_variant_b", input.user.id),
        body: input.body,
        machineState: input.machineState,
      };
      const r = render(renderInput);
      text = r.text;
      header = chatHeader(modeDef(mode).emoji, sp, li);
      const polished = await this.tryPolish(input, renderInput);
      if (polished) text = polished;
    }
    text = maskKnown(text, [...secrets, this.ctx.config.TELEGRAM_BOT_TOKEN, this.ctx.config.GITHUB_TOKEN]);
    const msg = { header, text, buttons: input.buttons, preformatted: input.preformatted };
    let ref: SentRef | null = null;
    // Chat style: step-by-step work logs stay out of the chat (kept in history, the pinned progress
    // message and /status). People only see starts, results, questions and conversation.
    const quiet = QUIET_IN_CHAT.has(input.machineState.kind) && (await this.chatStyle(input.user)) === "chat";
    try {
      if (quiet) throw QUIET;
      ref = input.project && input.project.topicId != null ? await this.ctx.out.postProject(input.project, msg) : await this.ctx.out.postLounge(input.user.telegramUserId, msg);
    } catch (e) {
      if (e !== QUIET) this.ctx.logger.warn({ err: (e as Error).message }, "failed to deliver message");
    }
    const stored = await this.ctx.repos.conversations.add({
      projectId: input.project?.id ?? null,
      taskId: input.taskId ?? input.machineState.taskId ?? null,
      speakerAgentId: sp.agentId,
      listenerRef: li.agentId ?? (input.listener.kind === "user" ? `user:${input.user.id}` : input.listener.kind),
      kind: input.machineState.kind,
      renderedText: `${header}\n${text}`,
      machineState: input.machineState,
      telegramMessageId: ref?.messageId ?? null,
    });
    this.ctx.events.emit("message.posted", { projectId: input.project?.id ?? null, messageId: stored.id });
    return ref;
  }

  /** LLM polish for moderator speech when enabled; null keeps the deterministic template. */
  private async tryPolish(input: SayInput, renderInput: Parameters<typeof promptFor>[0]): Promise<string | null> {
    if (!this.stylist || input.speaker.kind !== "moderator") return null;
    if (!["greeting", "report", "instruction", "error"].includes(input.situation)) return null;
    if (!(await this.ctx.flags.isEnabled("dialogue.llm_renderer", input.user.id))) return null;
    const mod = await this.moderatorAgent(input.user);
    if (!mod || !this.ctx.team.canWork(mod)) return null;
    return this.stylist.polish(input.user, mod, promptFor(renderInput), input.body);
  }

  async orgRoleOf(user: User, agent: Agent): Promise<OrgRole> {
    return (await this.speaker(user, { kind: "agent", agent })).orgRole;
  }
}

export const CHAT_STYLE_KEY = "chat.style";

/** Work-log steps that are not posted in chat style (they stay in history and the pinned message). */
export const QUIET_IN_CHAT = new Set(["task.assigned", "task.planned", "task.implemented", "quality.gate", "review.verdict", "approval.auto", "report.card", "discussion.start"]);
const QUIET = new Error("quiet");

/** Messenger-style header: the speaker's name; "A → B" only when one agent talks to another. */
function chatHeader(emoji: string, sp: { name: string }, li: { name: string; agentId: string | null }): string {
  return li.agentId ? `${emoji} ${sp.name} → ${li.name}` : `${emoji} ${sp.name}`;
}
