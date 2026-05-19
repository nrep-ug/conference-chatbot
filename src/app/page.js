"use client";

import { useState } from "react";

export default function Home() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  async function askQuestion(event) {
    event.preventDefault();

    if (!question.trim()) return;

    const userQuestion = question;
    const assistantMessageId = crypto.randomUUID();
    setQuestion("");
    setLoading(true);

    setMessages((previous) => [
      ...previous,
      { id: crypto.randomUUID(), role: "user", content: userQuestion },
      { id: assistantMessageId, role: "assistant", content: "" },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ question: userQuestion, stream: true }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "The chatbot request failed.");
      }

      if (!response.body) {
        throw new Error("The chatbot did not return a response stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          handleStreamEvent(event, assistantMessageId);
        }
      }

      if (buffer.trim()) {
        handleStreamEvent(buffer, assistantMessageId);
      }
    } catch (error) {
      updateAssistantMessage(
        assistantMessageId,
        error.message || "Something went wrong while contacting the chatbot.",
        true
      );
    } finally {
      setLoading(false);
    }
  }

  function handleStreamEvent(rawEvent, assistantMessageId) {
    const lines = rawEvent.split("\n");
    const eventType =
      lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (!dataLine) return;

    const data = JSON.parse(dataLine.slice(6));

    if (eventType === "token") {
      updateAssistantMessage(assistantMessageId, data);
    }

    if (eventType === "error") {
      updateAssistantMessage(assistantMessageId, data.error, true);
    }
  }

  function updateAssistantMessage(messageId, content, replace = false) {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: replace ? content : message.content + content,
            }
          : message
      )
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <section className="mx-auto max-w-3xl rounded-2xl bg-white p-6 shadow">
        <h1 className="text-2xl font-bold">Conference Chatbot</h1>
        <p className="mt-2 text-gray-600">
          Ask about the conference program, venue, registration, exhibitors, and FAQs.
        </p>

        <div className="mt-6 min-h-[350px] rounded-xl border bg-gray-50 p-4">
          {messages.length === 0 && (
            <p className="text-gray-500">
              Try asking: Where will the conference take place?
            </p>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`mb-4 ${
                message.role === "user" ? "text-right" : "text-left"
              }`}
            >
              <div
                className={`inline-block max-w-[85%] rounded-xl px-4 py-3 ${
                  message.role === "user"
                    ? "bg-black text-white"
                    : "bg-white text-gray-900 border"
                }`}
              >
                <strong>{message.role === "user" ? "You" : "Bot"}</strong>
                <p className="mt-1 whitespace-pre-wrap">
                  {message.content || "Thinking..."}
                </p>
              </div>
            </div>
          ))}

          {loading && <p className="text-gray-500">Responding...</p>}
        </div>

        <form onSubmit={askQuestion} className="mt-4 flex gap-2">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about the conference..."
            className="flex-1 rounded-xl border px-4 py-3 outline-none focus:ring-2 focus:ring-black"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-black px-5 py-3 font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-400"
          >
            {loading ? "..." : "Ask"}
          </button>
        </form>
      </section>
    </main>
  );
}
