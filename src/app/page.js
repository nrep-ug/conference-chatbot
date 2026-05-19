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
    setQuestion("");
    setLoading(true);

    setMessages((previous) => [
      ...previous,
      { role: "user", content: userQuestion },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: userQuestion }),
      });

      const data = await response.json();

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: data.answer || data.error || "No answer returned.",
        },
      ]);
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: "Something went wrong while contacting the chatbot.",
        },
      ]);
    } finally {
      setLoading(false);
    }
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

          {messages.map((message, index) => (
            <div
              key={index}
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
                <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
              </div>
            </div>
          ))}

          {loading && <p className="text-gray-500">Thinking...</p>}
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
            className="rounded-xl bg-black px-5 py-3 font-medium text-white"
          >
            Ask
          </button>
        </form>
      </section>
    </main>
  );
}