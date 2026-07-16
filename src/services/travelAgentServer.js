import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import TravelServer from "./travelServer.js";
import { executeAgentTool, listAgentTools } from "./agentTools.js";

function extractJson(text) {
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced?.[1] || text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_error) {
    return null;
  }
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .filter((call) => call && typeof call.name === "string")
    .slice(0, Number(process.env.AGENT_MAX_TOOL_CALLS || 4))
    .map((call) => ({
      id: call.id || randomUUID(),
      name: call.name,
      arguments: call.arguments && typeof call.arguments === "object" ? call.arguments : {},
    }));
}

function heuristicPlan(message, options = {}) {
  const toolCalls = [
    {
      name: "search_knowledge_base",
      arguments: {
        query: message,
        matchCount: options.matchCount || 5,
        threshold: options.threshold,
      },
    },
  ];

  const cityMatch = message.match(/(杭州|长沙|上海|北京|广州|深圳|成都|西安|南京|苏州)/);
  const city = options.city || cityMatch?.[1];

  if (city && /(天气|下雨|气温|热|冷|明天|周末)/.test(message)) {
    toolCalls.push({
      name: "get_weather",
      arguments: {
        city,
        date: message.includes("明天") ? "明天" : "出行当天",
      },
    });
  }

  if (city && /(景点|路线|怎么玩|游玩|半天|一天|推荐)/.test(message)) {
    toolCalls.push({
      name: "search_poi",
      arguments: {
        city,
        limit: 5,
      },
    });
    toolCalls.push({
      name: "plan_route",
      arguments: {
        city,
        hours: message.includes("半天") ? 4 : 8,
      },
    });
  }

  return normalizeToolCalls(toolCalls);
}

class TravelAgentServer {
  async planToolCalls(message, options = {}) {
    const tools = listAgentTools();
    const plannerMessages = [
      new SystemMessage(`你是旅游助手的工具规划器。你只能从给定工具中选择需要调用的工具。
请只输出 JSON，不要输出解释文字。
JSON 格式：
{
  "toolCalls": [
    { "name": "工具名", "arguments": { } }
  ]
}
如果不确定，至少调用 search_knowledge_base。
可用工具：
${JSON.stringify(tools, null, 2)}`),
      new HumanMessage(`用户问题：${message}
默认参数：${JSON.stringify({
        matchCount: options.matchCount || 5,
        threshold: options.threshold,
        city: options.city,
      })}`),
    ];

    try {
      const response = await TravelServer.llm.invoke(plannerMessages);
      const plan = extractJson(response.content || "");
      const toolCalls = normalizeToolCalls(plan?.toolCalls);
      return toolCalls.length ? toolCalls : heuristicPlan(message, options);
    } catch (error) {
      console.warn("Agent planner fallback:", error);
      return heuristicPlan(message, options);
    }
  }

  async executeTools(toolCalls, stream) {
    const results = [];

    for (const toolCall of toolCalls) {
      if (stream.isAborted()) break;

      stream.send("tool_start", {
        toolCallId: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });

      try {
        const result = await executeAgentTool(toolCall);
        results.push({ ...result, id: toolCall.id });

        stream.send("tool_result", {
          toolCallId: toolCall.id,
          name: toolCall.name,
          success: true,
          data: result.data,
        });

        if (toolCall.name === "search_knowledge_base") {
          stream.send("sources", {
            sources: result.data.data || [],
            retrieval: result.data,
          });
        }
      } catch (error) {
        const failed = {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          success: false,
          error: error.message || "工具调用失败",
        };
        results.push(failed);

        stream.send("tool_error", {
          toolCallId: toolCall.id,
          name: toolCall.name,
          success: false,
          error: failed.error,
        });
      }
    }

    return results;
  }

  async streamFinalAnswer({ message, toolResults }, stream) {
    const messages = [
      new SystemMessage(`你是一个专业旅游规划师。你会收到后端安全工具的执行结果。
请基于工具结果回答；工具失败或资料不足时要明确说明，并给出谨慎建议。
不要声称已经调用真实外部服务，除非工具结果中 mock 为 false。
回答要结构清晰、适合前端流式展示。`),
      new HumanMessage(`用户问题：
${message}

工具结果：
${JSON.stringify(toolResults, null, 2)}`),
    ];

    const llmStream = await TravelServer.llm.stream(messages);
    let reply = "";

    for await (const chunk of llmStream) {
      if (stream.isAborted()) break;
      const content = chunk.content || "";
      if (!content.trim()) continue;
      reply += content;
      stream.send("chunk", {
        content,
      });
    }

    return reply;
  }

  async chat(options, stream) {
    const { message } = options;

    stream.send("plan_start", {
      message,
      availableTools: listAgentTools().map((tool) => tool.name),
    });

    const toolCalls = await this.planToolCalls(message, options);
    stream.send("plan_result", {
      toolCalls,
    });

    const toolResults = await this.executeTools(toolCalls, stream);
    const reply = stream.isAborted()
      ? ""
      : await this.streamFinalAnswer({ message, toolResults }, stream);

    return {
      success: true,
      reply,
      toolCalls,
      toolResults,
    };
  }
}

export default new TravelAgentServer();
