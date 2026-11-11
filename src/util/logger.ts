import pino from "pino";
import { maskSecrets } from "../security/masking.js";

const level = process.env.LOG_LEVEL ?? "info";

/**
 * Application logger. Every log line passes through secret masking so that
 * tokens never reach stdout/log files even when a developer logs a config object.
 */
export const logger = pino({
  level,
  formatters: {
    log(obj) {
      return JSON.parse(maskSecrets(JSON.stringify(obj)));
    },
  },
  hooks: {
    logMethod(args, method) {
      const masked = args.map((a) => (typeof a === "string" ? maskSecrets(a) : a)) as Parameters<typeof method>;
      return method.apply(this, masked);
    },
  },
});

export type Logger = typeof logger;
