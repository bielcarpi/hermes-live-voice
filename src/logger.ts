export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (entryLevel: LogLevel, message: string, data?: unknown) => {
    if (LEVELS[entryLevel] < threshold) {
      return;
    }
    const payload = {
      level: entryLevel,
      message,
      time: new Date().toISOString(),
      ...(data === undefined ? {} : { data }),
    };
    const line = JSON.stringify(payload);
    if (entryLevel === "error") {
      console.error(line);
    } else if (entryLevel === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
}
