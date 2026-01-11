import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildZodShapeFromJsonSchema } from "./claude-sdk-schema.js";

describe("buildZodShapeFromJsonSchema", () => {
  it("builds required and optional fields with constraints", () => {
    const schema = {
      type: "object",
      properties: {
        action: { enum: ["list", "add"] },
        count: { type: "number", minimum: 1 },
      },
      required: ["action"],
    };

    const shape = buildZodShapeFromJsonSchema(schema);
    const parsed = z.object(shape);

    expect(parsed.safeParse({ action: "list" }).success).toBe(true);
    expect(parsed.safeParse({}).success).toBe(false);
    expect(parsed.safeParse({ action: "add", count: 0 }).success).toBe(false);
    expect(parsed.safeParse({ action: "add", count: 2 }).success).toBe(true);
  });
});
