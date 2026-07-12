import { describe, expect, it } from "vitest";
import { errorToMessage } from "../src/domain/error-message.js";

describe("provider error formatting", () => {
  it("formats nested structured provider errors without falling back to object coercion", () => {
    expect(
      errorToMessage({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "model_not_found",
          message: "The requested realtime model is unavailable.",
        },
      }),
    ).toBe(
      "message=The requested realtime model is unavailable., code=model_not_found, type=invalid_request_error",
    );
  });

  it("returns a safe diagnostic for unknown objects", () => {
    expect(errorToMessage({ unexpected: { secret: "not rendered" } })).toBe(
      "Unknown structured error.",
    );
  });
});
