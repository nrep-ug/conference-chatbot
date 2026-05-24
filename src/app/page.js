"use client";

import { useEffect, useRef, useState } from "react";

const suggestedQuestions = [
  "How should I prepare for the conference across the 4 days?",
  "Which sessions are relevant to finance and investment?",
  "What renewable energy technologies may be discussed?",
  "What happens on Day 3?",
];

const capabilityItems = [
  "Programme sessions",
  "Venue and halls",
  "Sponsors and partners",
  "Practical preparation",
];

function Icon({ name, className = "" }) {
  const props = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  const paths = {
    send: (
      <>
        <path d="m4 11.5 15-7-7 15-2.5-6L4 11.5Z" />
        <path d="m19 4.5-9.5 9" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.5 5L19 9.5 13.5 11 12 17l-1.5-6L5 9.5 10.5 8 12 3Z" />
        <path d="M19 17v4" />
        <path d="M17 19h4" />
      </>
    ),
    calendar: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M8 3v4" />
        <path d="M16 3v4" />
        <path d="M4 10h16" />
      </>
    ),
    map: (
      <>
        <path d="M9 18 4 20V6l5-2 6 2 5-2v14l-5 2-6-2Z" />
        <path d="M9 4v14" />
        <path d="M15 6v14" />
      </>
    ),
  };

  return <svg {...props}>{paths[name]}</svg>;
}

function parseStreamEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  const eventType =
    lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!dataLine) return null;

  return {
    eventType,
    data: JSON.parse(dataLine.slice(6)),
  };
}

function parseMarkdownBlocks(content) {
  const lines = String(content || "").split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let list = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const listItem = unordered || ordered;

    if (listItem) {
      flushParagraph();
      const listType = ordered ? "ordered-list" : "unordered-list";
      if (!list || list.type !== listType) {
        flushList();
        list = { type: listType, items: [] };
      }
      list.items.push(listItem[1].trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return blocks.length > 0
    ? blocks
    : [{ type: "paragraph", text: "Thinking..." }];
}

function splitTrailingUrlPunctuation(url) {
  const trailing = url.match(/[.,;:!?]+$/)?.[0] || "";

  return {
    href: trailing ? url.slice(0, -trailing.length) : url,
    trailing,
  };
}

function parseInlineMarkdown(text) {
  const pattern =
    /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|(https?:\/\/[^\s<]+))/g;
  const nodes = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const key = `${match.index}-${match[0]}`;

    if (match[2]) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-950">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-slate-100 px-1 py-0.5 text-[0.92em] text-slate-800"
        >
          {match[3]}
        </code>
      );
    } else if (match[4] && match[5]) {
      nodes.push(
        <a
          key={key}
          href={match[5]}
          target={match[5].startsWith("http") ? "_blank" : undefined}
          rel={match[5].startsWith("http") ? "noreferrer" : undefined}
          className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2"
        >
          {match[4]}
        </a>
      );
    } else if (match[6]) {
      const { href, trailing } = splitTrailingUrlPunctuation(match[6]);
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2"
        >
          {href}
        </a>
      );
      if (trailing) {
        nodes.push(trailing);
      }
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : text;
}

function MarkdownContent({ content }) {
  const blocks = parseMarkdownBlocks(content || "Thinking...");

  return (
    <div className="space-y-3 break-words text-sm leading-7">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = block.level === 1 ? "h3" : "h4";

          return (
            <Heading
              key={`${block.type}-${index}`}
              className="text-base font-semibold leading-6 tracking-normal text-slate-950"
            >
              {parseInlineMarkdown(block.text)}
            </Heading>
          );
        }

        if (block.type === "unordered-list" || block.type === "ordered-list") {
          const List = block.type === "ordered-list" ? "ol" : "ul";

          return (
            <List
              key={`${block.type}-${index}`}
              className={`space-y-1 pl-5 ${
                block.type === "ordered-list" ? "list-decimal" : "list-disc"
              }`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>
                  {parseInlineMarkdown(item)}
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={`${block.type}-${index}`}>
            {parseInlineMarkdown(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function Message({ message }) {
  const isUser = message.role === "user";

  return (
    <article className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] rounded-lg px-4 py-3 shadow-sm sm:max-w-[78%] ${
          isUser
            ? "bg-slate-950 text-white"
            : "border border-slate-200 bg-white text-slate-900"
        }`}
      >
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
          {isUser ? "You" : "REC Assistant"}
        </div>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-7">
            {message.content || "Thinking..."}
          </p>
        ) : (
          <MarkdownContent content={message.content} />
        )}
        {message.sources?.length > 0 && (
          <p className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-500">
            {message.sources.length} source{message.sources.length === 1 ? "" : "s"} used
          </p>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const transcriptRef = useRef(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function askQuestion(event, presetQuestion) {
    event?.preventDefault();

    const userQuestion = (presetQuestion || question).trim();
    if (!userQuestion || loading) return;

    const assistantMessageId = crypto.randomUUID();
    setQuestion("");
    setLoading(true);

    setMessages((previous) => [
      ...previous,
      { id: crypto.randomUUID(), role: "user", content: userQuestion },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        sources: [],
      },
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

        for (const rawEvent of events) {
          handleStreamEvent(rawEvent, assistantMessageId);
        }
      }

      if (buffer.trim()) {
        handleStreamEvent(buffer, assistantMessageId);
      }
    } catch (error) {
      updateAssistantMessage(
        assistantMessageId,
        error.message || "Something went wrong while contacting the chatbot.",
        { replace: true, error: true }
      );
    } finally {
      setLoading(false);
    }
  }

  function handleStreamEvent(rawEvent, assistantMessageId) {
    const parsed = parseStreamEvent(rawEvent);
    if (!parsed) return;

    if (parsed.eventType === "token") {
      updateAssistantMessage(assistantMessageId, parsed.data);
    }

    if (parsed.eventType === "sources") {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? { ...message, sources: parsed.data || [] }
            : message
        )
      );
    }

    if (parsed.eventType === "error") {
      updateAssistantMessage(assistantMessageId, parsed.data.error, {
        replace: true,
        error: true,
      });
    }
  }

  function updateAssistantMessage(messageId, content, options = {}) {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === messageId
          ? {
              ...message,
              error: options.error || message.error,
              content: options.replace ? content : message.content + content,
            }
          : message
      )
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-emerald-400 text-slate-950">
              <Icon name="spark" className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-normal">
                REC26 & EXPO Assistant
              </h1>
              <p className="text-sm text-slate-500">
                Public conference guidance grounded in the active programme
              </p>
            </div>
          </div>
          <a
            href="/admin"
            className="inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Admin
          </a>
        </header>

        <section className="mt-4 grid flex-1 gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="rounded-lg border border-slate-200 bg-slate-950 p-5 text-white shadow-sm">
            <div>
              <p className="text-sm font-medium text-emerald-300">Active event</p>
              <h2 className="mt-2 text-2xl font-semibold leading-tight tracking-normal">
                Renewable Energy Conference & Expo 2026
              </h2>
            </div>
            <div className="mt-6 space-y-3">
              <div className="flex gap-3 rounded-md bg-white/[0.06] p-4">
                <Icon name="calendar" className="mt-0.5 h-5 w-5 text-emerald-300" />
                <div>
                  <p className="text-sm font-semibold">19-22 October 2026</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    Four days spanning policy, technology, implementation, and
                    regional scale.
                  </p>
                </div>
              </div>
              <div className="flex gap-3 rounded-md bg-white/[0.06] p-4">
                <Icon name="map" className="mt-0.5 h-5 w-5 text-emerald-300" />
                <div>
                  <p className="text-sm font-semibold">Kampala Serena Hotel</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    Kampala, Uganda
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Can help with
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {capabilityItems.map((item) => (
                  <div
                    key={item}
                    className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300"
                  >
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </aside>

          <section className="flex min-h-[680px] flex-col rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Conversation</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Ask about sessions, planning, logistics, sponsors, and
                    practical preparation.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMessages([])}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  Clear
                </button>
              </div>
            </div>

            <div
              ref={transcriptRef}
              className="flex-1 space-y-4 overflow-y-auto bg-slate-50 px-4 py-5 sm:px-6"
            >
              {messages.length === 0 ? (
                <div className="grid min-h-full place-items-center">
                  <div className="max-w-2xl text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-slate-950 text-white">
                      <Icon name="spark" className="h-5 w-5" />
                    </div>
                    <h3 className="mt-5 text-2xl font-semibold tracking-normal">
                      Start with the outcome you want
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                      The assistant can answer direct conference facts and also
                      give practical planning guidance when grounded in the
                      published programme.
                    </p>
                    <div className="mt-6 grid gap-2 sm:grid-cols-2">
                      {suggestedQuestions.map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={(event) => askQuestion(event, item)}
                          className="rounded-md border border-slate-200 bg-white px-4 py-3 text-left text-sm font-medium leading-6 text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                messages.map((message) => <Message key={message.id} message={message} />)
              )}
            </div>

            <form
              onSubmit={askQuestion}
              className="border-t border-slate-200 bg-white p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row">
                <textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      askQuestion(event);
                    }
                  }}
                  placeholder="Ask about the conference..."
                  rows={2}
                  className="min-h-14 flex-1 resize-none rounded-md border border-slate-300 px-4 py-3 text-sm leading-6 outline-none transition focus:border-slate-950 focus:ring-4 focus:ring-slate-200"
                />
                <button
                  type="submit"
                  disabled={loading || !question.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 sm:w-36"
                >
                  <Icon name="send" className="h-4 w-4" />
                  {loading ? "Sending" : "Ask"}
                </button>
              </div>
            </form>
          </section>
        </section>
      </div>
    </main>
  );
}
