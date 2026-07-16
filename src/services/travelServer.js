import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import UserMemoryServer from "./userMemoryServer.js";
import "dotenv/config.js";

const providers = {
  DEEPSEEK: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  },
  XIAOMI: {
    apiKey: process.env.XIAOMI_API_KEY,
    baseURL: process.env.XIAOMI_BASE_URL,
    model: process.env.XIAOMI_MODEL,
  },
  GJLD: {
    apiKey: process.env.GJLD_API_KEY,
    baseURL: process.env.GJLD_BASE_URL,
    model: process.env.GJLD_MODEL,
  },
};

function cleanEnv(value) {
  return typeof value === "string" ? value.trim() : value;
}

class TravelServer {
  constructor() {
    this.llm = null;
    this.modelProvide = cleanEnv(process.env.MODEL_PROVIDE)?.toUpperCase();
  }

  initLLM() {
    const provider = providers[this.modelProvide];
    if (!provider) {
      throw new Error(`不支持的模型供应商：${this.modelProvide || "未配置"}`);
    }

    const apiKey = cleanEnv(provider.apiKey);
    const baseURL = cleanEnv(provider.baseURL);
    const model = cleanEnv(provider.model);
    if (!apiKey || !baseURL || !model) {
      throw new Error(
        `${this.modelProvide} 缺少 apiKey、baseURL 或 model 配置`,
      );
    }

    console.log("LLM provider :>> ", this.modelProvide);
    console.log("LLM baseURL :>> ", baseURL);
    console.log("LLM model :>> ", model);

    this.llm = new ChatOpenAI({
      apiKey,
      model,
      streaming: true,
      temperature: 0.7,
      maxTokens: Number(process.env.MODEL_MAX_TOKENS || 1600),
      timeout: Number(process.env.LLM_TIMEOUT_MS || 120000),
      maxRetries: Number(process.env.LLM_MAX_RETRIES || 1),
      configuration: {
        baseURL,
      },
    });
  }

  getLLM() {
    if (!this.llm) {
      this.initLLM();
    }

    return this.llm;
  }

  async recommend(city, budget, days) {
    if (budget < 100 || days < 1 || days > 10) {
      throw new Error("预算必须在100元以上，天数必须在1天以上10天以下");
    }
    // 构建提示词
    const prompt = this.getTravelPrompt(city, budget, days);
    try {
      // 调用模型生成推荐景点
      const response = await this.getLLM().invoke(prompt);
      const fullResponse = response.content || "";
      try {
        const jsonMatch =
          fullResponse.match(/```json\n([\s\S]*?)\n```/) ||
          fullResponse.match(/```\n([\s\S]*?)\n```/) ||
          fullResponse.match(/\{[\s\S]*\}/);
        const resData = JSON.parse(jsonMatch[0]);
        console.log("response.content :>> ", fullResponse);
        return {
          success: true,
          content: resData,
          usage: response.usage_metadata,
        };
      } catch (error) {
        return {
          success: false,
          error: "模型输出的JSON格式错误",
          rawResponse: error.message,
        };
      }
    } catch (error) {
      console.error("LLM Error:", error);
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  // 流式对话
  async chat(message, streamCallback, options = {}) {
    const memoryEnabled = Boolean(options.userId);
    const conversationId = options.conversationId || "default";
    let memoryMessages = [];

    if (memoryEnabled) {
      try {
        memoryMessages = await UserMemoryServer.getRecentMessages(options.userId, conversationId);
      } catch (error) {
        console.warn("Load user memory failed:", error);
      }
    }

    //  组装参数
    const messages = [
      new SystemMessage(
        "你是一个专业的旅游规划师，擅长根据用户的需求生成详细的旅行行程。",
      ),
      ...memoryMessages,
      new HumanMessage(message),
    ];
    try {
      const stream = await this.getLLM().stream(messages);

      let fullResponse = "";

      for await (const chunk of stream) {
        const content = chunk.content || "";
        // 过滤空内容
        if (content.trim() === "") {
          continue;
        }
        fullResponse += content;
        if (streamCallback) {
          streamCallback(content);
        }
      }
      if (memoryEnabled) {
        try {
          await UserMemoryServer.rememberExchange({
            userId: options.userId,
            conversationId,
            userMessage: message,
            assistantMessage: fullResponse,
            metadata: {
              source: "travel_chat",
            },
          });
        } catch (error) {
          console.warn("Save user memory failed:", error);
        }
      }

      return {
        success: true,
        reply: fullResponse,
        memory: {
          enabled: memoryEnabled,
          conversationId,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  getTravelPrompt(city, budget, days) {
    return [
      new HumanMessage(`你是一个专业的旅游规划师，擅长根据用户的需求生成详细的旅行行程。
请根据以下信息为用户生成一份详细的旅游规划：
- 目的地城市：${city}
- 预算：${budget}元
- 旅行天数：${days}天

要求：
1. 每天的行程安排（上午、下午、晚上）
2. 每个景点的详细介绍
3. 交通建议
4. 预算分配明细
5. 注意事项

请以JSON格式输出，结构如下：
{
  "success": true,
  "city": "城市名",
  "days": 天数,
  "totalBudget": 总预算,
  "dailyItinerary": [
    {
      "day": 1,
      "date": "第1天",
      "morning": {
        "spot": "景点名称",
        "duration": "游览时长",
        "ticket": "门票价格",
        "transportation": "交通方式",
        "description": "景点介绍"
      },
      "afternoon": {
        "spot": "景点名称",
        "duration": "游览时长",
        "ticket": "门票价格",
        "transportation": "交通方式",
        "description": "景点介绍"
      },
      "evening": {
        "spot": "活动名称",
        "duration": "活动时长",
        "ticket": "费用",
        "transportation": "交通方式",
        "description": "活动介绍"
      }
    }
  ],
  "budgetBreakdown": {
    "accommodation": 住宿费用,
    "food": 餐饮费用,
    "transportation": 交通费用,
    "tickets": 门票费用,
    "other": 其他费用
  },
  "tips": ["提示1", "提示2", "提示3"],
  "warnings": ["注意事项1", "注意事项2"]
}
  确保 JSON 格式正确，可以被解析。`),
    ];
  }
}

export default new TravelServer();
