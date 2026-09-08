import assert from "node:assert/strict";
import test from "node:test";
import { createSseResponse } from "../src/lib/chat-stream.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();

test("SSE comments arrive before buffered work and do not expose any answer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const response = createSseResponse(async (controller) => {
    await pending;
    controller.enqueue(encoder.encode('event: token\ndata: "Verified answer"\n\n'));
    controller.close();
  }, { heartbeatMs: 15000, headers: { "X-Request-Id": "test" } });
  assert.equal(response.headers.get("x-request-id"), "test");
  const reader = response.body.getReader();
  assert.equal(decoder.decode((await reader.read()).value), ": connected\n\n");
  t.mock.timers.tick(15000);
  assert.equal(decoder.decode((await reader.read()).value), ": keepalive\n\n");
  finish();
  assert.match(decoder.decode((await reader.read()).value), /Verified answer/);
  assert.equal((await reader.read()).done, true);
  t.mock.timers.tick(15000);
  assert.equal((await reader.read()).done, true);
});

test("cancelling the response aborts upstream work and discards late writes", async () => {
  let upstream;
  const response = createSseResponse(async (controller, signal) => {
    upstream = signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    controller.enqueue(encoder.encode("late response"));
    controller.close();
  });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(upstream.aborted, true);
  assert.equal((await reader.read()).done, true);
});

test("parent cancellation closes the response while work is pending", async () => {
  const abort = new AbortController();
  const response = createSseResponse(async (_controller, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  }, { signal: abort.signal });
  const reader = response.body.getReader();
  await reader.read();
  abort.abort();
  assert.equal((await reader.read()).done, true);
});

test("an already cancelled request never starts the model work", async () => {
  const abort = new AbortController();
  abort.abort();
  let called = false;
  const response = createSseResponse(() => { called = true; }, { signal: abort.signal });
  assert.equal((await response.body.getReader().read()).done, true);
  assert.equal(called, false);
});
