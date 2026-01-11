import { type ZodRawShape, type ZodTypeAny, z } from "zod";

type JsonSchema = Record<string, unknown>;
type Literal = string | number | boolean | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLiteral(value: unknown): value is Literal {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry) => typeof entry === "string");
  return items.length === value.length ? (items as string[]) : undefined;
}

function applyStringConstraints(
  schema: JsonSchema,
  base: z.ZodString,
): z.ZodTypeAny {
  let current: z.ZodTypeAny = base;
  const min = typeof schema.minLength === "number" ? schema.minLength : null;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : null;
  if (typeof min === "number") current = (current as z.ZodString).min(min);
  if (typeof max === "number") current = (current as z.ZodString).max(max);
  if (typeof schema.pattern === "string") {
    try {
      current = (current as z.ZodString).regex(new RegExp(schema.pattern));
    } catch {
      // ignore invalid regex patterns
    }
  }
  return current;
}

function applyNumberConstraints(
  schema: JsonSchema,
  base: z.ZodNumber,
): z.ZodTypeAny {
  let current: z.ZodTypeAny = base;
  if (typeof schema.minimum === "number") {
    current = (current as z.ZodNumber).min(schema.minimum);
  }
  if (typeof schema.maximum === "number") {
    current = (current as z.ZodNumber).max(schema.maximum);
  }
  if (typeof schema.exclusiveMinimum === "number") {
    current = (current as z.ZodNumber).gt(schema.exclusiveMinimum);
  }
  if (typeof schema.exclusiveMaximum === "number") {
    current = (current as z.ZodNumber).lt(schema.exclusiveMaximum);
  }
  return current;
}

function applyArrayConstraints(
  schema: JsonSchema,
  base: z.ZodArray<ZodTypeAny>,
): z.ZodTypeAny {
  let current: z.ZodTypeAny = base;
  if (typeof schema.minItems === "number") {
    current = (current as z.ZodArray<ZodTypeAny>).min(schema.minItems);
  }
  if (typeof schema.maxItems === "number") {
    current = (current as z.ZodArray<ZodTypeAny>).max(schema.maxItems);
  }
  return current;
}

function applyCommonMetadata(schema: JsonSchema, base: ZodTypeAny): ZodTypeAny {
  let current = base;
  if (typeof schema.description === "string" && schema.description.trim()) {
    current = current.describe(schema.description.trim());
  }
  if (schema.nullable === true) current = current.nullable();
  return current;
}

function unionOf(variants: ZodTypeAny[]): ZodTypeAny {
  if (variants.length === 0) return z.any();
  if (variants.length === 1) return variants[0] as ZodTypeAny;
  return z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function buildEnumSchema(values: unknown[]): ZodTypeAny {
  const literalValues = values.filter(isLiteral);
  const stringValues = asStringArray(literalValues);
  if (stringValues && stringValues.length > 0) {
    return z.enum(stringValues as [string, ...string[]]);
  }
  const literals = literalValues.map((value) => z.literal(value));
  return unionOf(literals);
}

function toZodType(schema: unknown): ZodTypeAny {
  if (!isRecord(schema)) return z.any();

  if (schema.const !== undefined) {
    const literal = isLiteral(schema.const) ? z.literal(schema.const) : z.any();
    return applyCommonMetadata(schema, literal);
  }

  if (Array.isArray(schema.enum)) {
    return applyCommonMetadata(schema, buildEnumSchema(schema.enum));
  }

  const combined =
    Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)
      ? (schema.anyOf ?? schema.oneOf)
      : null;
  if (combined && Array.isArray(combined)) {
    const variants = combined
      .map((entry) => toZodType(entry))
      .filter(Boolean) as ZodTypeAny[];
    return applyCommonMetadata(schema, unionOf(variants));
  }

  if (Array.isArray(schema.allOf)) {
    const variants = schema.allOf
      .map((entry) => toZodType(entry))
      .filter(Boolean) as ZodTypeAny[];
    if (variants.length === 0) return z.any();
    let merged = variants[0] as ZodTypeAny;
    for (const next of variants.slice(1)) {
      merged = z.intersection(merged, next);
    }
    return applyCommonMetadata(schema, merged);
  }

  const typeValue = schema.type;
  if (Array.isArray(typeValue)) {
    const variants = typeValue.map((entry) =>
      toZodType({ ...schema, type: entry }),
    ) as ZodTypeAny[];
    return applyCommonMetadata(schema, unionOf(variants));
  }

  if (typeValue === "string") {
    return applyCommonMetadata(
      schema,
      applyStringConstraints(schema, z.string()),
    );
  }
  if (typeValue === "integer") {
    return applyCommonMetadata(
      schema,
      applyNumberConstraints(schema, z.number().int()),
    );
  }
  if (typeValue === "number") {
    return applyCommonMetadata(
      schema,
      applyNumberConstraints(schema, z.number()),
    );
  }
  if (typeValue === "boolean") {
    return applyCommonMetadata(schema, z.boolean());
  }
  if (typeValue === "array") {
    const items = schema.items;
    const itemSchema = items ? toZodType(items) : z.any();
    return applyCommonMetadata(
      schema,
      applyArrayConstraints(schema, z.array(itemSchema)),
    );
  }
  if (typeValue === "object") {
    const shape = buildZodShapeFromJsonSchema(schema);
    let obj = z.object(shape);
    if (schema.additionalProperties === false) {
      obj = obj.strict();
    } else if (
      schema.additionalProperties &&
      isRecord(schema.additionalProperties)
    ) {
      obj = obj.catchall(toZodType(schema.additionalProperties));
    }
    return applyCommonMetadata(schema, obj);
  }

  return applyCommonMetadata(schema, z.any());
}

export function buildZodShapeFromJsonSchema(schema: unknown): ZodRawShape {
  if (!isRecord(schema)) return {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredList = Array.isArray(schema.required)
    ? schema.required.filter((entry) => typeof entry === "string")
    : [];
  const required = new Set(requiredList);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    let zodType = toZodType(value);
    if (!required.has(key)) {
      zodType = zodType.optional();
    }
    shape[key] = zodType;
  }
  return shape as ZodRawShape;
}
