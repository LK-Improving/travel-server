/**
 * 配置驱动的模型路由。选择逻辑完全在服务端，对外只暴露安全元数据。
 * 对齐 Python 版 app/services/model_router.py。
 */
import { config } from '../config';
import { projectModelCatalog } from './projectModels';

export type ModelRole = 'planner' | 'answer';

export interface ModelRouteDecision {
  role: ModelRole;
  intent: string | null;
  modelName: string;
  reason: string;
}

export function modelRouteDecisionPublic(decision: ModelRouteDecision): Record<string, unknown> {
  return {
    role: decision.role,
    intent: decision.intent,
    model: decision.modelName,
    reason: decision.reason,
  };
}

export class ModelRouter {
  decide(intentPlan: Record<string, unknown> | null, options: { afterTool: boolean }): ModelRouteDecision {
    const plan = intentPlan ?? {};
    const rawIntent = plan.intent;
    const intent = rawIntent ? String(rawIntent) : null;

    let role: ModelRole;
    let reason: string;
    if (options.afterTool) {
      role = 'answer';
      reason = '工具结果已返回，进入最终回答阶段';
    } else if (intent === 'chat' || intent === 'clarify' || intent === 'unsafe') {
      role = 'answer';
      reason = '闲聊、澄清或安全拒答不需要工具规划';
    } else {
      role = 'planner';
      reason = '根据结构化意图决定是否调用受控工具';
    }

    const configuredName = role === 'answer' ? config.answerModel : config.plannerModel;
    return { role, intent, modelName: configuredName || 'provider_default', reason };
  }

  modelName(role: ModelRole): string | null {
    return (role === 'answer' ? config.answerModel : config.plannerModel) || null;
  }

  publicConfig(): Record<string, unknown> {
    return {
      models: projectModelCatalog.listOptions(),
      roles: {
        planner: this.modelName('planner') || 'provider_default',
        answer: this.modelName('answer') || 'provider_default',
      },
      fallbackModel: config.modelFallback || null,
      rateLimitPerMinute: config.modelRateLimitPerMinute,
      circuitFailureThreshold: config.modelCircuitFailureThreshold,
      circuitResetSeconds: config.modelCircuitResetSeconds,
      cacheTtlSeconds: config.modelCacheTtlSeconds,
    };
  }
}

export const modelRouter = new ModelRouter();
