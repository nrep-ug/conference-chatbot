import assert from "node:assert/strict";
import test from "node:test";
import { askMistral, askPlanner, streamMistral, getAnswerContextBudget } from "../src/lib/ollama.js";

const input = { question: "Who are the sponsors?", context: "Published sponsors" };
function mockStream(t, packets) {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(packets);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  })));
}

test("planner requests JSON format without the previous investment example bias", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.format, "json");
    assert.doesNotMatch(body.messages.at(-1).content, /\["investment"\]/);
    return Response.json({ done: true, message: { content: '{"lookup":false}' } });
  });
  assert.equal(await askPlanner({ question: "List sessions", schema: "Public tables" }), '{"lookup":false}');
});

test("stream decoder preserves UTF-8 and handles a final packet without a newline", async (t) => {
  mockStream(t, '{"message":{"content":"Caf\u00e9 "}}\n{"message":{"content":"sessions"},"done":true,"done_reason":"stop"}');
  let tokens = "";
  assert.equal(await streamMistral({ ...input, onToken: (text) => { tokens += text; } }), "Caf\u00e9 sessions");
  assert.equal(tokens, "Caf\u00e9 sessions");
});

for (const [name, packets, expected] of [
  ["truncated transport", '{"message":{"content":"Partial answer"}}\n', /before completion/],
  ["output limit", '{"message":{"content":"Partial"},"done":true,"done_reason":"length"}\n', /output limit/],
  ["upstream error", '{"error":"runner unavailable"}\n', /runner unavailable/],
  ["empty output", '{"done":true,"message":{"content":""}}\n', /complete answer/],
]) {
  test(`does not accept ${name} as a successful model answer`, async (t) => {
    mockStream(t, packets);
    await assert.rejects(streamMistral(input), expected);
  });
}

test("non-streamed token-limited responses also fail instead of being cached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ done: true, done_reason: "length", message: { content: "Incomplete" } }));
  await assert.rejects(askMistral(input), /output limit/);
});

test("reserves more context space for a longer conversation", () => {
  const short = getAnswerContextBudget("Compare sessions");
  const long = getAnswerContextBudget("Compare sessions", [{ role: "user", content: "Previous request ".repeat(60) }]);
  assert.ok(short > long);
  assert.ok(long >= 0);
});
