// 可解释预算调整 Skill（对齐 Python app/skills/budget_adjustment.py）。
import Decimal from 'decimal.js';
import { z } from 'zod';
import { defineSkill } from './define';
import type { SkillExecutionContext } from './base';

function toDecimal(value: unknown): Decimal {
  if (typeof value === 'boolean') throw new Error('金额必须是有限数值');
  let amount: Decimal;
  try {
    amount = new Decimal(String(value));
  } catch {
    throw new Error('金额必须是有限数值');
  }
  if (!amount.isFinite() || amount.isNegative()) throw new Error('金额必须是有限的非负数');
  return amount;
}

const decimalNonNeg = z
  .union([z.number(), z.string()])
  .transform((v) => toDecimal(v))
  .refine((d) => d.isFinite() && !d.isNegative(), '金额必须是有限的非负数');

const decimalPositive = z
  .union([z.number(), z.string()])
  .transform((v) => toDecimal(v))
  .refine((d) => d.isFinite() && !d.isNegative() && !d.isZero(), '金额必须是有限的正数值');

const BudgetAlternative = z.object({
  name: z.string().min(1).max(120),
  unitPriceCny: decimalNonNeg,
  reason: z.string().max(300).default(''),
});

const BudgetItem = z.object({
  name: z.string().min(1).max(120),
  unitPriceCny: decimalNonNeg,
  quantity: z.number().int().min(1).max(1000).default(1),
  mandatory: z.boolean().default(false),
  alternatives: z.array(BudgetAlternative).max(20).default([]),
});

const BudgetAdjustmentRequest = z.object({
  budgetCny: decimalPositive,
  items: z.array(BudgetItem).min(1).max(100),
});
export type BudgetAdjustmentRequestType = z.infer<typeof BudgetAdjustmentRequest>;

function money(value: Decimal): string {
  return value.toDecimalPlaces(2).toString();
}

const BudgetAdjustmentResult = z.object({
  status: z.enum(['within_budget', 'adjusted', 'infeasible']),
  budgetCny: z.string(),
  originalTotalCny: z.string(),
  totalCny: z.string(),
  items: z.array(z.object({ name: z.string(), unitPriceCny: z.string(), quantity: z.number() })),
  adjustments: z.array(z.record(z.unknown())).default([]),
  protectedConstraints: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

export const budgetAdjustmentSkill = defineSkill<BudgetAdjustmentRequestType, z.infer<typeof BudgetAdjustmentResult>>({
  name: 'budget_adjustment',
  version: '1.0.0',
  description: '基于明确费用项、数量和备选方案进行可解释的预算内调整，不推测缺失价格。',
  inputModel: BudgetAdjustmentRequest,
  outputModel: BudgetAdjustmentResult,
  inputJsonSchema: {
    type: 'object',
    properties: {
      budgetCny: { type: 'number', exclusiveMinimum: 0 },
      items: { type: 'array', items: { type: 'object' } },
    },
  },
  outputJsonSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['within_budget', 'adjusted', 'infeasible'] },
      budgetCny: { type: 'string' },
      originalTotalCny: { type: 'string' },
      totalCny: { type: 'string' },
      items: { type: 'array' },
    },
  },
  run: async (request, _context: SkillExecutionContext | undefined) => {
    void _context;
    const budget = request.budgetCny;
    const totalRows = (items: { unitPriceCny: Decimal; quantity: number }[]) =>
      items.reduce((sum, it) => sum.plus(it.unitPriceCny.times(it.quantity)), new Decimal(0));

    const originalTotal = totalRows(request.items);
    // 计算阶段保留 Decimal 精度，只在输出时转成字符串金额。
    const selected: { name: string; unitPriceCny: Decimal; quantity: number }[] = [];
    const adjustments: Record<string, unknown>[] = [];
    const protectedConstraints: string[] = [];
    const warnings: string[] = [];

    if (originalTotal.lte(budget)) {
      return {
        status: 'within_budget',
        budgetCny: money(budget),
        originalTotalCny: money(originalTotal),
        totalCny: money(originalTotal),
        items: request.items.map((item) => ({
          name: item.name,
          unitPriceCny: money(item.unitPriceCny),
          quantity: item.quantity,
        })),
        adjustments: [],
        protectedConstraints: request.items.filter((i) => i.mandatory).map((i) => i.name),
        warnings: [],
      };
    }

    for (const item of request.items) {
      let chosenName = item.name;
      let chosenPrice = item.unitPriceCny;
      if (item.mandatory) {
        protectedConstraints.push(item.name);
      } else if (item.alternatives.length) {
        const cheapest = item.alternatives.reduce((best, alt) => (alt.unitPriceCny.lt(best.unitPriceCny) ? alt : best), item.alternatives[0]);
        if (cheapest.unitPriceCny.lt(chosenPrice)) {
          chosenName = cheapest.name;
          chosenPrice = cheapest.unitPriceCny;
          adjustments.push({
            item: item.name,
            from: money(item.unitPriceCny),
            to: money(chosenPrice),
            replacement: chosenName,
            reason: cheapest.reason || '选择最低价备选项',
          });
        }
      }
      selected.push({ name: chosenName, unitPriceCny: chosenPrice, quantity: item.quantity });
    }

    const total = totalRows(selected);
    const status: 'within_budget' | 'adjusted' | 'infeasible' = total.lte(budget) ? 'adjusted' : 'infeasible';
    if (status === 'infeasible') {
      warnings.push('仅使用已提供的备选方案仍无法满足预算；未修改必选项，也未虚构价格。');
    }
    return {
      status,
      budgetCny: money(budget),
      originalTotalCny: money(originalTotal),
      totalCny: money(total),
      items: selected.map((item) => ({ name: item.name, unitPriceCny: money(item.unitPriceCny), quantity: item.quantity })),
      adjustments,
      protectedConstraints,
      warnings,
    };
  },
});
