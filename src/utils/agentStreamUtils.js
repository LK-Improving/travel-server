import { randomUUID } from "node:crypto";

export function createAgentStreamResponse(req, res, options = {}) {
  const requestId = options.requestId || randomUUID();
  const messageId = options.messageId || randomUUID();
  const heartbeatMs = Number(process.env.AGENT_SSE_HEARTBEAT_MS || 15000);
  let seq = 0;
  let aborted = false;

  const write = (payload) => {
    if (aborted || res.writableEnded) return false;
    res.write(payload);
    res.flush?.();
    return true;
  };

  const send = (type, data = {}) => {
    seq += 1;
    const event = {
      type,
      requestId,
      messageId,
      seq,
      timestamp: Date.now(),
      data,
    };

    write(`id: ${seq}\n`);
    write(`event: ${type}\n`);
    write(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  };

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    write(`: ping ${Date.now()}\n\n`);
  }, heartbeatMs);

  void req;

  res.on("close", () => {
    aborted = !res.writableEnded;
    clearInterval(heartbeat);
  });

  send("connected", {
    heartbeatMs,
  });

  return {
    requestId,
    messageId,
    send,
    error: (message, detail = {}) => send("error", { message, ...detail }),
    end: () => {
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        send("end");
        res.end();
      }
    },
    isAborted: () => aborted || res.writableEnded,
  };
}
