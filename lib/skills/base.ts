/**
 * 版本化 Skill 契约。Skill 负责确定性业务编排：
 * 不持有模型客户端、不直接执行 SQL，输入校验后返回可审计的 JSON 安全结果。
 * 对齐 Python 版 app/skills/base.py。
 */
import type { ZodType, ZodTypeDef } from 'zod';

export interface SkillExecutionContext {
  traceId?: string | null;
  tenantId?: string | null;
  applicationId?: string | null;
  actorId?: string | null;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface Skill<TInput = unknown, TOutput = unknown> {
  name: string;
  version: string;
  description: string;
  inputModel: ZodType<TInput, ZodTypeDef, unknown>;
  outputModel: ZodType<TOutput, ZodTypeDef, unknown>;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
  run(input: TInput, context?: SkillExecutionContext): Promise<TOutput>;
}

export function versionKey(version: string): number[] {
  return String(version)
    .split('.')
    .map((part) => {
      const digits = part.replace(/\D/g, '');
      return digits ? Number.parseInt(digits, 10) : 0;
    });
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** 进程内注册中心，显式版本选择，禁止静默覆盖。 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill<never, never>>();

  register<TInput, TOutput>(skill: Skill<TInput, TOutput>): Skill<TInput, TOutput> {
    const key = `${skill.name}@${skill.version}`;
    if (this.skills.has(key)) throw new Error(`Skill 已注册：${key}`);
    this.skills.set(key, skill as unknown as Skill<never, never>);
    return skill;
  }

  get(name: string, version?: string | null): Skill<never, never> {
    const normalized = String(name ?? '').trim();
    if (version) {
      const skill = this.skills.get(`${normalized}@${String(version).trim()}`);
      if (!skill) throw new Error(`Skill 不存在：${normalized}@${version}`);
      return skill;
    }
    const candidates = [...this.skills.values()].filter((skill) => skill.name === normalized);
    if (!candidates.length) throw new Error(`Skill 不存在：${normalized}`);
    return candidates.reduce((best, current) =>
      compareVersions(versionKey(current.version), versionKey(best.version)) > 0 ? current : best,
    );
  }

  manifests(): SkillManifest[] {
    return [...this.skills.values()]
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || compareVersions(versionKey(a.version), versionKey(b.version)),
      )
      .map((skill) => ({
        name: skill.name,
        version: skill.version,
        description: skill.description,
        inputSchema: skill.inputJsonSchema,
        outputSchema: skill.outputJsonSchema,
      }));
  }

  async execute(
    name: string,
    payload: unknown,
    options: { version?: string | null; context?: SkillExecutionContext } = {},
  ): Promise<unknown> {
    const skill = this.get(name, options.version);
    const input = skill.inputModel.parse(payload);
    const output = await skill.run(input, options.context);
    return skill.outputModel.parse(output);
  }
}
