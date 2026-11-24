import { describe, expect, it } from "vitest";
import { SDK_NAME } from "../src/index.js";

describe("package skeleton", () => {
  it("exports its name", () => {
    expect(SDK_NAME).toBe("gabriel-notion");
  });
});
