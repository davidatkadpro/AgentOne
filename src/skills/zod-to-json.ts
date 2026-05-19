import { z } from 'zod'

/**
 * Minimal Zod → JSON Schema converter for the subset we need to advertise
 * tools to OpenAI-compatible APIs. Avoids a runtime dependency on
 * `zod-to-json-schema` (which is large and supports much more than we need).
 *
 * Supported: string, number, boolean, literal, enum, array, object, optional,
 * nullable, default, describe. Anything else falls back to `{}` (no
 * constraint), which lets the model send freeform args.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convert(schema)
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: { typeName?: string; description?: string } })._def
  const description = def.description
  const base = convertInner(schema)
  if (description && !('description' in base)) base.description = description
  return base
}

function convertInner(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    return { type: 'string' }
  }
  if (schema instanceof z.ZodNumber) {
    return { type: 'number' }
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }
  if (schema instanceof z.ZodLiteral) {
    const value = (schema as z.ZodLiteral<unknown>)._def.value
    return { const: value }
  }
  if (schema instanceof z.ZodEnum) {
    const values = (schema as z.ZodEnum<[string, ...string[]]>)._def.values
    return { type: 'string', enum: [...values] }
  }
  if (schema instanceof z.ZodArray) {
    const element = (schema as z.ZodArray<z.ZodTypeAny>)._def.type
    return { type: 'array', items: convert(element) }
  }
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      const child = value as z.ZodTypeAny
      properties[key] = convert(child)
      if (!isOptional(child)) required.push(key)
    }
    const out: Record<string, unknown> = {
      type: 'object',
      properties,
    }
    if (required.length > 0) out.required = required
    return out
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = (schema as z.ZodOptional<z.ZodTypeAny>)._def.innerType
    return convert(inner)
  }
  if (schema instanceof z.ZodDefault) {
    const inner = (schema as z.ZodDefault<z.ZodTypeAny>)._def.innerType
    const def = (schema as z.ZodDefault<z.ZodTypeAny>)._def
    const out = convert(inner)
    try {
      out.default = def.defaultValue()
    } catch {
      /* skip default if evaluator throws */
    }
    return out
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema as z.ZodUnion<z.ZodUnionOptions>)._def.options
    return { anyOf: options.map(convert) }
  }
  return {}
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodNullable
  )
}
