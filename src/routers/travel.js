import express from "express";
import TravelServer from "../services/travelServer.js";
import { createStreamResponse } from "../utils/streamUtils.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";
const router = express.Router();

router.post("/recommand", async (req, res) => {
  const { city, budget, days } = req.body;
  console.log("city :>> ", city);
  if (!city || !budget || !days) {
    return res.status(400).json({
      msg: "推荐景点",
      timestamp: Date.now(),
      error: "缺少必要参数city,budget,days",
    });
  }
  const result = await TravelServer.recommend(city, budget, days);
  return res.json(result);
});

router.post("/chat", optionalAuth, async (req, res) => {
  const { message, conversationId } = req.body;
  if (!message) {
    return res.status(400).json({
      msg: "对话",
      timestamp: Date.now(),
      error: "缺少必要参数message",
    });
  }
  //  对SSE流式接口返回进行处理
  const stream = createStreamResponse(res);

  try {
    // 调取大模型获取流式响应
    const result = await TravelServer.chat(
      message,
      (chunk) => {
        stream.send({ type: "chunk", content: chunk });
      },
      {
        userId: req.auth?.user?.id,
        conversationId,
      },
    );

    if (result.success) {
      stream.send({ type: "complete", data: result });
    } else {
      stream.error(result.error || "对话失败");
    }
  } catch (error) {
    stream.error(error.message || "对话失败");
  } finally {
    stream.end();
  }
});

export default router;
