/**
 * Structured logger contract (pino / bunyan style `(obj, msg)` calls).
 * The SDK never passes credentials, request headers or page content to the logger.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noop = () => {};

export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/** A console-backed logger for examples and local debugging. */
export function consoleLogger(level: "debug" | "info" | "warn" | "error" = "info"): Logger {
  const order = ["debug", "info", "warn", "error"] as const;
  const min = order.indexOf(level);
  const make =
    (lvl: (typeof order)[number]) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      if (order.indexOf(lvl) < min) return;
      const line = `[gabriel-notion] ${lvl.toUpperCase()} ${msg ?? ""} ${JSON.stringify(obj)}`;
      (lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log)(line);
    };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}
