/**
 * 服务端模型目录：对外只暴露 key/label/provider/model/available，
 * 凭据与连接信息永不离开服务端。对齐 Python 版 app/services/project_models.py。
 */
import { ChatOpenAI } from '@langchain/openai';
import { config, env, PROVIDER_PREFIXES, type ProviderName } from '../config';

export class ModelUnavailableError extends Error {
  constructor(message = '所选模型不存在或当前不可用') {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

export interface ModelDefinition {
  key: string;
  label: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  available: boolean;
}

export interface PublicModelOption {
  key: string;
  label: string;
  provider: string;
  model: string;
  available: boolean;
}

function definitions(): ModelDefinition[] {
  const providers: Array<[string, string, string, string]> = [
    ['OLLAMA', config.ollamaChatModel, config.ollamaApiKey || 'ollama', config.ollamaBaseUrl],
    ...PROVIDER_PREFIXES.map((name): [string, string, string, string] => [
      name,
      env(`${name}_MODEL`),
      env(`${name}_API_KEY`),
      env(`${name}_BASE_URL`),
    ]),
  ];

  const result: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const [provider, model, apiKey, baseUrl] of providers) {
    const modelName = String(model ?? '').trim();
    const key = modelName ? `${provider.toLowerCase()}:${modelName}` : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const normalizedBaseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    result.push({
      key,
      label: modelName,
      provider,
      model: modelName,
      apiKey: String(apiKey ?? ''),
      baseUrl: normalizedBaseUrl,
      available: Boolean(apiKey && normalizedBaseUrl && modelName),
    });
  }
  return result;
}

export class ProjectModelCatalog {
  listOptions(): PublicModelOption[] {
    return definitions().map((definition) => ({
      key: definition.key,
      label: definition.label,
      provider: definition.provider,
      model: definition.model,
      available: definition.available,
    }));
  }

  require(modelKey: string): ModelDefinition {
    const key = String(modelKey ?? '').trim();
    const definition = definitions().find((item) => item.key === key);
    if (!definition || !definition.available) throw new ModelUnavailableError();
    return definition;
  }

  buildChatModel(
    modelKey: string,
    options: { temperature?: number; maxTokens?: number; streaming?: boolean } = {},
  ): ChatOpenAI {
    const definition = this.require(modelKey);
    return new ChatOpenAI({
      model: definition.model,
      apiKey: definition.apiKey,
      configuration: { baseURL: definition.baseUrl },
      timeout: config.llmTimeoutMs,
      maxRetries: config.llmMaxRetries,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? config.modelMaxTokens,
      streaming: options.streaming ?? true,
    });
  }
}

export const projectModelCatalog = new ProjectModelCatalog();
export type { ProviderName };
