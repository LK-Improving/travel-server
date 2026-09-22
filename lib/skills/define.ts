// Skill 构造助手（对齐 Python app/skills/base.py 的 Skill 协议）。
import type { ZodType, ZodTypeDef } from 'zod';
import type { Skill, SkillExecutionContext } from './base';

/**
 * 第三个泛型位放 unknown：带 .default() 的 schema 其 Input 与 Output 不同
 * （输入可省略、输出必有值），卡成 ZodType<T> 会让所有默认值字段的 Skill 编译不过。
 */
export function defineSkill<TInput, TOutput>(spec: {
  name: string;
  version: string;
  description: string;
  inputModel: ZodType<TInput, ZodTypeDef, unknown>;
  outputModel: ZodType<TOutput, ZodTypeDef, unknown>;
  inputJsonSchema?: Record<string, unknown>;
  outputJsonSchema?: Record<string, unknown>;
  run: (input: TInput, context?: SkillExecutionContext) => Promise<TOutput>;
}): Skill<TInput, TOutput> {
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    inputModel: spec.inputModel,
    outputModel: spec.outputModel,
    inputJsonSchema: spec.inputJsonSchema ?? { type: 'object' },
    outputJsonSchema: spec.outputJsonSchema ?? { type: 'object' },
    run: spec.run,
  };
}
