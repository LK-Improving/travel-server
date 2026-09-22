// Skill 注册中心（对齐 Python app/skills/registry.py）。
import type { AmapProvider } from '../services/amapProvider';
import { amapProvider } from '../services/amapProvider';
import { SkillRegistry } from './base';
import { travelPlanningSkill } from './travel_planning';
import { budgetAdjustmentSkill } from './budget_adjustment';

export function buildSkillRegistry(amap: AmapProvider = amapProvider): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(travelPlanningSkill(amap));
  registry.register(budgetAdjustmentSkill);
  return registry;
}

export const skillRegistry = buildSkillRegistry();
