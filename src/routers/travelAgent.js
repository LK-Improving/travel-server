import express from "express";
import TravelAgentServer from "../services/travelAgentServer.js";
import { listAgentTools } from "../services/agentTools.js";
import { createAgentStreamResponse } from "../utils/agentStreamUtils.js";

const router = express.Router();

router.get("/tools", (_req, res) => {
  return res.json({
    success: true,
    data: listAgentTools(),
  });
});

router.post("/chat", async (req, res) => {
  const { message, matchCount, threshold, city, requestId, messageId } = req.body;

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "缺少必要参数message",
    });
  }

  const stream = createAgentStreamResponse(req, res, {
    requestId,
    messageId,
  });

  try {
    const result = await TravelAgentServer.chat(
      {
        message,
        matchCount,
        threshold,
        city,
      },
      stream,
    );

    if (!stream.isAborted()) {
      stream.send("complete", result);
    }
  } catch (error) {
    if (!stream.isAborted()) {
      stream.error(error.message || "Agent 对话失败", {
        stage: "agent_chat",
      });
    }
  } finally {
    stream.end();
  }
});

export default router;
