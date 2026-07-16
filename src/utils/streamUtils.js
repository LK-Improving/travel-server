export const createStreamResponse = (res) => {
  const writeSse = (payload) => {
    if (res.writableEnded) return;

    res.write(payload);
    // compression 等中间件会提供 res.flush；没有该方法时，Node 的 res.write 会直接写入 socket。
    res.flush?.();
  };

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // 禁用 Nginx 这类代理对 SSE 的响应缓冲。
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  writeSse(": connected\n\n");

  return {
    send: (data) => {
      try {
        writeSse(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        console.error("流式发送错误:", error);
      }
    },
    end: () => {
      try {
        if (!res.writableEnded) {
          writeSse('event: end\ndata: {"type":"end"}\n\n');
          res.end();
        }
      } catch (error) {
        console.error("流式结束错误:", error);
      }
    },
    error: (message) => {
      try {
        writeSse(
          `event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`,
        );
      } catch (error) {
        console.error("流式响应错误:", error);
      }
    },
  };
};
