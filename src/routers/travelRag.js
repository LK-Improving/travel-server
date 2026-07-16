import express from "express";
import RagServer from "../services/ragServer.js";
import { createStreamResponse } from "../utils/streamUtils.js";

const router = express.Router();

router.get("/status", async (_req, res) => {
  try {
    const result = await RagServer.status();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "RAG 状态检查失败",
    });
  }
});

router.post("/documents", async (req, res) => {
  const { title, content, metadata, chunkSize, chunkOverlap } = req.body;

  if (!content) {
    return res.status(400).json({
      msg: "RAG 文档入库",
      timestamp: Date.now(),
      error: "缺少必要参数content",
    });
  }

  try {
    const result = await RagServer.addDocument({
      title,
      content,
      metadata,
      chunkSize,
      chunkOverlap,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "RAG 文档入库失败",
    });
  }
});

router.post("/search", async (req, res) => {
  const { query, message, matchCount, threshold } = req.body;
  const searchText = query || message;

  if (!searchText) {
    return res.status(400).json({
      msg: "RAG 检索",
      timestamp: Date.now(),
      error: "缺少必要参数query或message",
    });
  }

  const result = await RagServer.searchWithFallback(searchText, {
    matchCount,
    threshold,
  });

  return res.json(result);
});

router.post("/chat", async (req, res) => {
  const { message, matchCount, threshold } = req.body;

  if (!message) {
    return res.status(400).json({
      msg: "RAG 对话",
      timestamp: Date.now(),
      error: "缺少必要参数message",
    });
  }

  const stream = createStreamResponse(res);

  try {
    const result = await RagServer.chat(
      message,
      {
        matchCount,
        threshold,
        onSources: (sources, retrieval) => {
          stream.send({ type: "sources", data: sources, retrieval });
        },
      },
      (chunk) => {
        stream.send({ type: "chunk", content: chunk });
      },
    );

    if (result.success) {
      stream.send({ type: "complete", data: result });
    } else {
      stream.error(result.error || "RAG 对话失败");
    }
  } catch (error) {
    stream.error(error.message || "RAG 对话失败");
  } finally {
    stream.end();
  }
});

export default router;
