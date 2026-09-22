/**
 * 轻量 zod → JSON Schema 转换器，仅覆盖工具 schema 用到的形状
 * （object / string / number / boolean / optional / default / enum / describe / min / max）。
 * 用于 /api/rag/tools 元信息输出，不追求完整 zod 语义。
 */
import type { ZodType } from 'zod';

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  items?: JsonSchema;
  [key: string]: unknown;
}

export function zodToJsonSchema(schema: ZodType): JsonSchema {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def ?? {};
  const typeName = String(def.typeName ?? '');
  const result: JsonSchema = {};

  const description = (def.description as string | undefined) ?? (schema.description as string | undefined);
  if (description) result.description = description;

  switch (typeName) {
    case 'ZodObject': {
      result.type = 'object';
      const shape = (def.shape ? (def.shape as () => Record<string, ZodType>)() : {}) as Record<string, ZodType>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        const valueDef = (value as unknown as { _def?: Record<string, unknown> })._def ?? {};
        if (String(valueDef.typeName) !== 'ZodOptional' && String(valueDef.typeName) !== 'ZodDefault') {
          required.push(key);
        }
      }
      result.properties = properties;
      if (required.length) result.required = required;
      break;
    }
    case 'ZodString':
      result.type = 'string';
      break;
    case 'ZodNumber':
      result.type = 'number';
      break;
    case 'ZodBoolean':
      result.type = 'boolean';
      break;
    case 'ZodArray': {
      result.type = 'array';
      const inner = (def.type as ZodType | undefined) ?? (def.element as ZodType | undefined);
      if (inner) result.items = zodToJsonSchema(inner);
      break;
    }
    case 'ZodEnum':
    case 'ZodNativeEnum': {
      result.type = 'string';
      const values = (def.values as unknown[]) ?? [];
      result.enum = values;
      break;
    }
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = def.innerType as ZodType | undefined;
      if (inner) Object.assign(result, zodToJsonSchema(inner));
      if (typeName === 'ZodDefault') {
        const defValue = (def.defaultValue as () => unknown)?.();
        if (defValue !== undefined) result.default = defValue;
      }
      break;
    }
    case 'ZodEffects': {
      const inner = def.schema as ZodType | undefined;
      if (inner) Object.assign(result, zodToJsonSchema(inner));
      break;
    }
    default:
      result.type = 'string';
  }

  const checks = (def.checks as Array<Record<string, unknown>> | undefined) ?? [];
  for (const check of checks) {
    if (check.kind === 'min' || check.kind === 'minLength') result.minimum = Number(check.value);
    if (check.kind === 'max' || check.kind === 'maxLength') result.maximum = Number(check.value);
  }
  return result;
}
