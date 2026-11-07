import type { JsonSchema } from '@pi-meme/plugin-sdk/rpc'

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'additionalItems',
  'enum',
  'const',
  'anyOf',
  'allOf',
  'oneOf',
  'not',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  '$schema',
])

/** 外部 schema 不能在 Host 执行正则、format、引用或无界组合求值。 */
export function validateJsonSchema(schema: JsonSchema, value: unknown): boolean {
  let definitions = 4096
  function inspect(node: unknown, depth = 0): void {
    if (--definitions < 0 || depth > 32 || !object(node)) throw new Error('invalid-schema: schema 无效或过深')
    if (Object.keys(node).some((key) => !keywords.has(key)))
      throw new Error('invalid-schema: SDK 4 只支持内联 JSON Schema，不支持正则、format 或引用')
    if (
      node.type !== undefined &&
      !(typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type : []).every((type) =>
        types.includes(type),
      )
    )
      throw new Error('invalid-schema: type 无效')
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'minProperties',
      'maxProperties',
    ]) {
      if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key])))
        throw new Error('invalid-schema: 数值限制无效')
    }
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) || !node.required.every((key) => typeof key === 'string'))
    )
      throw new Error('invalid-schema: required 无效')
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 256))
      throw new Error('invalid-schema: enum 无效')
    if (node.properties !== undefined) {
      if (!object(node.properties)) throw new Error('invalid-schema: properties 无效')
      for (const child of Object.values(node.properties)) inspect(child, depth + 1)
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (node[key] === undefined) continue
      if (!Array.isArray(node[key]) || !node[key].length || node[key].length > 32)
        throw new Error('invalid-schema: schema 组合无效')
      for (const child of node[key]) inspect(child, depth + 1)
    }
    for (const key of ['additionalProperties', 'additionalItems']) {
      if (node[key] !== undefined && typeof node[key] !== 'boolean') inspect(node[key], depth + 1)
    }
    if (node.not !== undefined) inspect(node.not, depth + 1)
    if (node.items !== undefined) {
      if (Array.isArray(node.items)) for (const child of node.items) inspect(child, depth + 1)
      else inspect(node.items, depth + 1)
    }
  }
  inspect(schema)
  let budget = 100000
  const equal = (left: unknown, right: unknown): boolean => {
    if (--budget < 0) throw new Error('invalid-schema: schema 求值超过限制')
    if (left === right) return true
    if (Array.isArray(left) && Array.isArray(right))
      return left.length === right.length && left.every((item, i) => equal(item, right[i]))
    if (!object(left) || !object(right)) return false
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    )
  }
  const match = (node: Record<string, unknown>, item: unknown): boolean => {
    if (--budget < 0) throw new Error('invalid-schema: schema 求值超过限制')
    if (node.type !== undefined) {
      const expected = Array.isArray(node.type) ? node.type : [node.type]
      if (
        !expected.some((type) =>
          type === 'null'
            ? item === null
            : type === 'array'
              ? Array.isArray(item)
              : type === 'object'
                ? object(item)
                : type === 'integer'
                  ? Number.isInteger(item)
                  : (type === 'string' && typeof item === 'string') ||
                    (type === 'number' && typeof item === 'number') ||
                    (type === 'boolean' && typeof item === 'boolean'),
        )
      )
        return false
    }
    if (Object.hasOwn(node, 'const') && !equal(item, node.const)) return false
    if (Array.isArray(node.enum) && !node.enum.some((candidate) => equal(item, candidate))) return false
    for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
      const choices = node[key] as Record<string, unknown>[] | undefined
      if (!choices) continue
      if (key === 'anyOf' && !choices.some((choice) => match(choice, item))) return false
      if (key === 'allOf' && !choices.every((choice) => match(choice, item))) return false
      if (key === 'oneOf' && choices.filter((choice) => match(choice, item)).length !== 1) return false
    }
    if (object(node.not) && match(node.not, item)) return false
    if (typeof item === 'number') {
      if (
        (typeof node.minimum === 'number' && item < node.minimum) ||
        (typeof node.maximum === 'number' && item > node.maximum) ||
        (typeof node.exclusiveMinimum === 'number' && item <= node.exclusiveMinimum) ||
        (typeof node.exclusiveMaximum === 'number' && item >= node.exclusiveMaximum)
      )
        return false
    }
    if (typeof item === 'string') {
      const length = [...item].length
      if (
        (typeof node.minLength === 'number' && length < node.minLength) ||
        (typeof node.maxLength === 'number' && length > node.maxLength)
      )
        return false
    }
    if (Array.isArray(item)) {
      if (
        (typeof node.minItems === 'number' && item.length < node.minItems) ||
        (typeof node.maxItems === 'number' && item.length > node.maxItems)
      )
        return false
      for (let i = 0; i < item.length; i++) {
        const child = Array.isArray(node.items) ? (node.items[i] ?? node.additionalItems) : node.items
        if (child === false || (object(child) && !match(child, item[i]))) return false
      }
    }
    if (object(item)) {
      const keys = Object.keys(item)
      if (
        (typeof node.minProperties === 'number' && keys.length < node.minProperties) ||
        (typeof node.maxProperties === 'number' && keys.length > node.maxProperties)
      )
        return false
      if (Array.isArray(node.required) && !node.required.every((key) => Object.hasOwn(item, key))) return false
      const properties = object(node.properties) ? node.properties : {}
      for (const key of keys) {
        const child = Object.hasOwn(properties, key) ? properties[key] : node.additionalProperties
        if (child === false || (object(child) && !match(child, item[key]))) return false
      }
    }
    return true
  }
  return match(schema, value)
}
