import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level) in LEVELS ? (config.logLevel as Level) : "info"];

function emit(level: Level, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra === undefined) {
    console.log(line);
  } else {
    console.log(line, extra);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit("debug", message, extra),
  info: (message: string, extra?: unknown) => emit("info", message, extra),
  warn: (message: string, extra?: unknown) => emit("warn", message, extra),
  error: (message: string, extra?: unknown) => emit("error", message, extra),
};
