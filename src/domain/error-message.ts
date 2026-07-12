const ERROR_FIELDS = ["message", "code", "type", "param"] as const;

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const record = error as Record<string, unknown>;
  if (record.error && record.error !== error) {
    const nested = errorToMessage(record.error);
    if (nested !== "Unknown structured error.") {
      return nested;
    }
  }

  const details = ERROR_FIELDS.flatMap((field) => {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return [`${field}=${value.trim().slice(0, 500)}`];
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return [`${field}=${String(value)}`];
    }
    return [];
  });
  return details.length > 0 ? details.join(", ") : "Unknown structured error.";
}
