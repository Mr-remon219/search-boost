import Ajv from 'ajv'

// DSH deliberately accepts a smaller schema language than MCP/Pi: no bounds,
// type arrays, or schema-valued additionalProperties. Keep the original JSON
// contract enforced locally rather than silently dropping those constraints.
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
const RUNTIME_CONSTRAINTS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties',
])

export function toDshSchema(schema) {
  const result = {}
  const constraints = []
  for (const [key, value] of Object.entries(schema)) {
    if (RUNTIME_CONSTRAINTS.has(key)) {
      constraints.push(`${key}: ${JSON.stringify(value)}`)
    } else if (key === 'properties') {
      result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toDshSchema(child)]))
    } else if (key === 'items') {
      result.items = toDshSchema(value)
    } else if (key === 'anyOf') {
      // Jev keywords accepts a nonempty string array OR a nonempty array of
      // string arrays. Those branches are disjoint, so DSH's exact-one union
      // preserves the contract (empty arrays are invalid in the original too).
      // Do not silently convert arbitrary overlapping anyOf unions.
      if (value.length !== 2 || !value.every(branch => branch.type === 'array' && branch.minItems >= 1)
        || !value.some(branch => branch.items?.type === 'string')
        || !value.some(branch => branch.items?.type === 'array')) {
        throw new TypeError('DSH anyOf translation only supports disjoint nonempty string/nested array branches')
      }
      result.oneOf = value.map(toDshSchema)
    } else if (key === 'oneOf') {
      result.oneOf = value.map(toDshSchema)
    } else if (key === 'additionalProperties' && typeof value === 'object') {
      // DSH validates the object shape; the original value schema is enforced
      // by Ajv before execution/output crosses the host boundary.
      result.additionalProperties = true
    } else if (key === 'type' && Array.isArray(value)) {
      // The adapter only uses disjoint nullable scalar unions. Do not translate
      // overlapping unions (e.g. number/integer) into exact-one semantics.
      if (value.length !== 2 || !value.includes('null') || !value.some((type) => ['string', 'number', 'integer', 'boolean'].includes(type))) {
        throw new TypeError('DSH schema translation only supports nullable scalar type arrays')
      }
      result.oneOf = value.map((type) => ({ type }))
    } else {
      result[key] = structuredClone(value)
    }
  }
  if (constraints.length) {
    result.description = [result.description, `Constraints (checked at execution): ${constraints.join(', ')}.`].filter(Boolean).join(' ')
  }
  return result
}

/** Register host-compatible schemas without weakening input/output validation. */
export function registerDshTool(ctx, definition) {
  const validateInput = ajv.compile(definition.parameters)
  const validateOutput = ajv.compile(definition.output.schema)
  function check(validate, value, kind) {
    if (!validate(value)) {
      // Include paths and failed constraints, never argument values or secrets.
      throw new TypeError(`${definition.name}: invalid ${kind}: ${ajv.errorsText(validate.errors)}`)
    }
  }
  return ctx.tools.register({
    ...definition,
    parameters: toDshSchema(definition.parameters),
    output: { ...definition.output, schema: toDshSchema(definition.output.schema) },
    async execute(args, exec) {
      check(validateInput, args, 'arguments')
      const value = await definition.execute(args, exec)
      check(validateOutput, value, 'output')
      return value
    },
  })
}
