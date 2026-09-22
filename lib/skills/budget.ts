/**
 * 行程费用块的确定性校验。对齐 Python 版 app/rag_base/budget.py。
 * 用 decimal.js 替代 Python Decimal，避免浮点误差导致预算判定漂移。
 */
import Decimal from 'decimal.js';

const BUDGET_BLOCK_PATTERN = /<budget_plan>([\s\S]*?)<\/budget_plan>/g;
const UNCLOSED_BLOCK_PATTERN = /<budget_plan\b[\s\S]*/g;
const MALFORMED_FEEDBACK =
  '预算校验未通过：费用明细格式无效。请在不编造价格的前提下重新规划并输出费用明细。';
const MISSING_FEEDBACK = '预算校验未通过：未提供费用明细。请在不编造价格的前提下重新规划并输出费用明细。';

export interface BudgetValidation {
  valid: boolean;
  answer: string;
  totalCny: Decimal | null;
  feedback: string | null;
}

interface BudgetItem {
  name: string;
  unitPriceCny: Decimal;
  quantity: number;
}

function stripBudgetBlocks(content: string): string {
  let stripped = content.replace(BUDGET_BLOCK_PATTERN, '');
  if (stripped.includes('<budget_plan')) {
    stripped = stripped.replace(UNCLOSED_BLOCK_PATTERN, '');
  }
  return stripped.replace(/<\/budget_plan>/g, '');
}

/** JSON 不允许的常量（NaN/Infinity）一律拒绝，避免绕开数值校验。 */
function parseStrictJson(raw: string): unknown {
  const normalized = raw.trim();
  if (/\b(NaN|Infinity|-Infinity)\b/.test(normalized)) throw new Error('Invalid JSON constant');
  return JSON.parse(normalized, function reviver(_key, value) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid number');
    return value;
  });
}

function asNonNegativeDecimal(value: unknown): Decimal {
  if (typeof value === 'boolean') throw new Error('Budget item price is invalid');
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error('Budget item price is invalid');
  }
  const price = new Decimal(String(value));
  if (!price.isFinite() || price.isNegative()) throw new Error('Budget item price is invalid');
  return price;
}

function calculateTotal(plan: unknown): Decimal {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Budget plan must be an object');
  const keys = Object.keys(plan as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'items') throw new Error('Budget plan must contain only items');

  const items = (plan as { items: unknown }).items;
  if (!Array.isArray(items) || !items.length) throw new Error('Budget plan items must be a non-empty list');

  return items
    .map((raw): BudgetItem => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Budget item has an invalid structure');
      }
      const item = raw as Record<string, unknown>;
      const itemKeys = Object.keys(item).sort();
      if (itemKeys.length !== 3 || itemKeys.join(',') !== 'name,quantity,unitPriceCny') {
        throw new Error('Budget item has an invalid structure');
      }
      if (typeof item.name !== 'string' || !item.name.trim()) throw new Error('Budget item name is invalid');
      const unitPrice = asNonNegativeDecimal(item.unitPriceCny);
      const quantity = item.quantity;
      if (typeof quantity === 'boolean' || typeof quantity !== 'number' || !Number.isInteger(quantity)) {
        throw new Error('Budget item quantity is invalid');
      }
      if (quantity <= 0) throw new Error('Budget item quantity is invalid');
      return { name: item.name.trim(), unitPriceCny: unitPrice, quantity };
    })
    .reduce((total, item) => total.plus(item.unitPriceCny.times(item.quantity)), new Decimal(0));
}

/** 解析唯一的 <budget_plan> 块并与预算比较，返回给模型的安全反馈。 */
export function parseBudgetBlock(content: string, budgetCny: Decimal | string | number): BudgetValidation {
  const budget = budgetCny instanceof Decimal ? budgetCny : new Decimal(String(budgetCny));
  const matches = [...String(content ?? '').matchAll(BUDGET_BLOCK_PATTERN)];
  const answer = stripBudgetBlocks(String(content ?? '')).trim();

  if (!matches.length) {
    const feedback = String(content ?? '').includes('budget_plan') ? MALFORMED_FEEDBACK : MISSING_FEEDBACK;
    return { valid: false, answer, totalCny: null, feedback };
  }
  if (matches.length !== 1) {
    return { valid: false, answer, totalCny: null, feedback: MALFORMED_FEEDBACK };
  }

  let total: Decimal;
  try {
    const plan = parseStrictJson(matches[0][1]);
    total = calculateTotal(plan);
  } catch {
    return { valid: false, answer, totalCny: null, feedback: MALFORMED_FEEDBACK };
  }

  if (total.lte(budget)) {
    return { valid: true, answer, totalCny: total, feedback: null };
  }
  const difference = total.minus(budget);
  return {
    valid: false,
    answer,
    totalCny: total,
    feedback: `预算校验未通过：预算 ${budget.toFixed(2)} 元，当前估算 ${total.toFixed(2)} 元，超出 ${difference.toFixed(2)} 元。请在不编造价格的前提下重新规划并输出费用明细。`,
  };
}

export function budgetFeedback(validation: BudgetValidation): string {
  return validation.feedback ?? '';
}
