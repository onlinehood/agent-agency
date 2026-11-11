import type { App } from "./app.js";
import { resolveSecret, SECRET_REFS } from "./app.js";
import { TelegramGateway } from "./telegram/gateway.js";
import { NullOutboundPort } from "./core/orchestration/ports.js";
import { startBackupSchedule } from "./backup/service.js";
import type { ControlActions } from "./ops/control.js";
import type { VerificationRecord } from "./executors/registry.js";
import { syncExecutorFlags } from "./executors/flags.js";
import { loadCustomModes } from "./core/organization/customModes.js";
import { SetupService } from "./setup/service.js";

/**
 * Runtime supervisor: owns the App and the Telegram gateway so setup (the terminal CLI through the control channel,
 * or the optional web console) can connect Telegram/GitHub at runtime without editing server files or restarting (PRD §18).
 */
export class Runtime {
  telegram: TelegramGateway | null = null;
  private stopBackups: (() => void) | null = null;

  constructor(readonly app: App) {}

  get ctx() {
    return this.app.ctx;
  }

  async start(): Promise<void> {
    await this.app.start();
    await this.startTelegram().catch((e) => this.ctx.logger.warn({ err: (e as Error).message }, "telegram not started"));
    this.stopBackups = startBackupSchedule(this.ctx);
  }

  async startTelegram(): Promise<boolean> {
    const token = await resolveSecret(this.ctx, this.ctx.config.TELEGRAM_BOT_TOKEN, SECRET_REFS.telegramToken);
    if (!token) return false;
    if (this.telegram) await this.telegram.stop();
    this.telegram = new TelegramGateway(token, this.ctx, this.app.orchestrator);
    this.app.setOutbound(this.telegram);
    await this.telegram.start();
    return true;
  }

  async pauseTelegram(): Promise<void> {
    if (this.telegram) await this.telegram.stop().catch(() => undefined);
    this.telegram = null;
    this.app.setOutbound(new NullOutboundPort());
  }

  /** Apply changes made by the interactive CLI in another process (see ops/control.ts). */
  async applyControl(a: ControlActions): Promise<{ detail: string; telegram: boolean }> {
    const done: string[] = [];
    if (a.telegram === "pause") {
      await this.pauseTelegram();
      done.push("telegram paused");
    } else if (a.telegram === "restart") {
      const ok = await this.startTelegram().catch((e) => {
        this.ctx.logger.warn({ err: (e as Error).message }, "telegram restart failed");
        return false;
      });
      done.push(ok ? "telegram restarted" : "telegram not configured");
    }
    if (a.github) {
      await this.app.reloadGitHub();
      done.push("github reloaded");
    }
    if (a.executors) {
      for (const ad of this.ctx.executors.list()) {
        const rec = await this.ctx.repos.settings.get<VerificationRecord>("system", "", `executor.verification.${ad.id}`);
        if (rec) this.ctx.executors.setVerification(rec);
      }
      await syncExecutorFlags(this.ctx);
      await this.ctx.executors.detectAll();
      done.push("executors reloaded");
    }
    if (a.modes) {
      await loadCustomModes(this.ctx.repos);
      done.push("modes reloaded");
    }
    if (a.greet && this.telegram) {
      await new SetupService(this.app).greet();
      done.push("greeted");
    }
    return { detail: done.join(", ") || "nothing to do", telegram: !!this.telegram };
  }

  async stop(): Promise<void> {
    this.stopBackups?.();
    if (this.telegram) await this.telegram.stop();
    this.app.setOutbound(new NullOutboundPort());
    await this.app.stop();
  }
}
