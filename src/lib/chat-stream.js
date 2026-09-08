// Transport lifecycle only; answer selection and validation stay in the chat route.
export function createSseResponse(run, { signal: parentSignal, headers = {}, heartbeatMs = 15000 } = {}) {
  const operation = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, operation.signal]) : operation.signal;
  const encoder = new TextEncoder();
  let finished = false, heartbeat, onAbort;
  const cleanup = () => { clearInterval(heartbeat); signal.removeEventListener("abort", onAbort); };
  const body = new ReadableStream({
    start(controller) {
      const writer = {
        enqueue(value) { if (!finished) controller.enqueue(value); },
        close() { if (!finished) { finished = true; cleanup(); controller.close(); } },
        error(error) { if (!finished) { finished = true; cleanup(); controller.error(error); } },
      };
      onAbort = () => writer.close();
      if (signal.aborted) { writer.close(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      writer.enqueue(encoder.encode(": connected\n\n"));
      heartbeat = setInterval(() => writer.enqueue(encoder.encode(": keepalive\n\n")), heartbeatMs);
      heartbeat.unref?.();
      // Do not await the answer in start(): headers and comments must arrive during model work.
      Promise.resolve().then(() => {
        if (!signal.aborted) return run(writer, signal);
      }).catch((error) => writer.error(error)).finally(() => writer.close());
    },
    cancel(reason) {
      finished = true;
      cleanup();
      operation.abort(reason);
    },
  });
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    ...headers,
  } });
}
