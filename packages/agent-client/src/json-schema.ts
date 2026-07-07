// Converts raw JSON Schema objects (as a host's own tool registry might use)
// into a Zod raw shape, so those tools can be registered as agent-client
// LocalTools (whose inputSchema is a ZodRawShape — the MCP SDK's high-level
// McpServer.registerTool() only accepts a Zod shape/schema, not raw JSON
// Schema).
//
// Scope is deliberately narrow: only the JSON Schema constructs a typical tool
// registry actually uses (object/string/number/boolean/array/enum/required/
// minItems/maxItems/additionalProperties). Anything else (missing/unrecognized
// `type`) falls back to `z.unknown()` rather than throwing, so a
// hand-authored schema (e.g. from a dynamically defined tool) can't crash
// tool registration.

import { type ZodRawShape, type ZodTypeAny, z } from 'zod'

export interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean | JsonSchemaNode
}

function describe(schema: ZodTypeAny, description?: string): ZodTypeAny {
  return description ? schema.describe(description) : schema
}

function convertObject(node: JsonSchemaNode): ZodTypeAny {
  const shape = objectShape(node)
  const base = z.object(shape)
  if (node.additionalProperties === true) {
    return base.catchall(z.unknown())
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    return base.catchall(convertNode(node.additionalProperties))
  }
  return base
}

function convertArray(node: JsonSchemaNode): ZodTypeAny {
  let schema = z.array(node.items ? convertNode(node.items) : z.unknown())
  if (node.minItems !== undefined) {
    schema = schema.min(node.minItems)
  }
  if (node.maxItems !== undefined) {
    schema = schema.max(node.maxItems)
  }
  return schema
}

function convertNode(node: JsonSchemaNode): ZodTypeAny {
  if (node.enum && node.enum.length > 0) {
    return describe(z.enum(node.enum as [string, ...string[]]), node.description)
  }
  switch (node.type) {
    case 'string':
      return describe(z.string(), node.description)
    case 'number':
      return describe(z.number(), node.description)
    case 'boolean':
      return describe(z.boolean(), node.description)
    case 'array':
      return describe(convertArray(node), node.description)
    case 'object':
      return describe(convertObject(node), node.description)
    default:
      return describe(z.unknown(), node.description)
  }
}

function objectShape(node: JsonSchemaNode): ZodRawShape {
  const properties = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const shape: Record<string, ZodTypeAny> = {}
  for (const [key, propNode] of Object.entries(properties)) {
    const propSchema = convertNode(propNode)
    shape[key] = required.has(key) ? propSchema : propSchema.optional()
  }
  return shape
}

// Top-level entry point: a tool's inputSchema is always a JSON Schema object
// node, converted into the ZodRawShape LocalTool.inputSchema expects.
export function jsonSchemaToZodShape(schema: JsonSchemaNode): ZodRawShape {
  return objectShape(schema)
}
