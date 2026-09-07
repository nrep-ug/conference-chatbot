"use client";

import {
  Archive,
  ArrowUp,
  CalendarDays,
  FileText,
  Handshake,
  Images,
  Landmark,
  Lightbulb,
  LoaderCircle,
  MapPin,
  MessageCircleQuestion,
  RotateCcw,
  Sparkles,
  Wifi,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHAT_QUESTION_LIMITS,
  sanitizeChatHistory,
  validateChatQuestion,
} from "@/lib/chat-conversation";
import BrandLogo from "./components/brand-logo";

const suggestedQuestions = [
  {
    question: "How should I prepare for the conference across the 4 days?",
    icon: CalendarDays,
  },
  {
    question: "Which sessions are relevant to finance and investment?",
    icon: Landmark,
  },
  {
    question: "What happens on Day 3?",
    icon: MessageCircleQuestion,
  },
  {
    question: "Show me the official photos from REC24",
    icon: Images,
  },
  {
    question: "Can I download the REC25 conference report?",
    icon: FileText,
  },
];

const capabilityItems = [
  { label: "Programme sessions", icon: CalendarDays },
  { label: "Venue and halls", icon: MapPin },
  { label: "Sponsors and partners", icon: Handshake },
  { label: "Practical preparation", icon: Lightbulb },
  { label: "Previous editions", icon: Archive },
  { label: "Media and reports", icon: FileText },
];

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
        <strong key={key} className="font-semibold text-[#14262D]">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-[#EDF3F5] px-1 py-0.5 text-[0.92em] text-[#183B49]"
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
          className="font-medium text-[#176F91] underline decoration-[#7BC4DF] underline-offset-2 hover:text-[#0B5E78]"
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
          className="font-medium text-[#176F91] underline decoration-[#7BC4DF] underline-offset-2 hover:text-[#0B5E78]"
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
    <div className="space-y-3 break-words text-[0.9375rem] leading-7 text-[#243B44]">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = block.level === 1 ? "h3" : "h4";

          return (
            <Heading
              key={`${block.type}-${index}`}
              className="text-base font-semibold leading-6 tracking-normal text-[#14262D]"
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
  const isWaiting = !isUser && !message.content && !message.error;

  return (
    <article
      className={`flex items-start gap-3 ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser && (
        <BrandLogo className="mt-1 h-9 w-9 rounded-md border border-[#D5E0E4] shadow-sm" />
      )}
      <div className={`min-w-0 ${isUser ? "max-w-[86%] sm:max-w-[72%]" : "max-w-[calc(100%-3rem)] sm:max-w-[84%]"}`}>
        <div
          className={`rounded-lg px-4 py-3 ${
            isUser
              ? "bg-[#176F91] text-white shadow-sm"
              : message.error
                ? "border border-red-200 bg-red-50 text-red-800"
                : "border border-[#D5E0E4] bg-white text-[#243B44] shadow-[0_1px_2px_rgba(20,38,45,0.04)]"
          }`}
        >
          <div
            className={`mb-1.5 text-[0.6875rem] font-semibold uppercase ${
              isUser ? "text-white/75" : "text-[#617780]"
            }`}
          >
            {isUser ? "You" : "REC Assistant"}
          </div>
          {isWaiting ? (
            <div className="flex items-center gap-2 py-1 text-sm text-[#617780]" role="status">
              <LoaderCircle className="h-4 w-4 animate-spin text-[#2E9ECC]" />
              Preparing your answer
            </div>
          ) : isUser ? (
            <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-7">
              {message.content}
            </p>
          ) : (
            <MarkdownContent content={message.content} />
          )}
        </div>
        {!isUser && message.sources?.length > 0 && (
          <details className="group mt-2 text-xs text-[#617780]">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 font-medium hover:text-[#176F91] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2E9ECC]">
              <FileText className="h-3.5 w-3.5" />
              {message.sources.length} source{message.sources.length === 1 ? "" : "s"} used
            </summary>
            <ul className="mt-1 space-y-1 border-l-2 border-[#D5E0E4] pl-3">
              {message.sources.slice(0, 6).map((source, index) => (
                <li key={`${source.source || source.sourceType || "source"}-${index}`}>
                  {source.source || source.sourceType || `Conference source ${index + 1}`}
                </li>
              ))}
              {message.sources.length > 6 && (
                <li>And {message.sources.length - 6} more</li>
              )}
            </ul>
          </details>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [composerError, setComposerError] = useState("");
  const transcriptRef = useRef(null);
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    if (messages.length === 0) {
      transcriptRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }

    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function askQuestion(event, presetQuestion) {
    event?.preventDefault();

    if (loading || requestInFlightRef.current) return;

    const validation = validateChatQuestion(presetQuestion || question);
    if (!validation.valid) {
      setComposerError(validation.error);
      return;
    }

    const userQuestion = validation.question;

    const history = sanitizeChatHistory(
      messages.filter((message) => message.error !== true)
    );
    const assistantMessageId = crypto.randomUUID();
    requestInFlightRef.current = true;
    setComposerError("");
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
        body: JSON.stringify({
          question: userQuestion,
          history,
          stream: true,
        }),
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
      requestInFlightRef.current = false;
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
    <main className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-[#F4F7F8] text-[#14262D]">
      <header className="shrink-0 border-b border-[#D5E0E4] bg-white">
        <div className="mx-auto flex h-[72px] w-full max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLogo
              className="h-12 w-12 rounded-md border border-[#D5E0E4]"
              priority
            />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-[#14262D] sm:text-lg">
                REC26 & EXPO Assistant
              </h1>
              <p className="truncate text-xs text-[#617780] sm:text-sm">
                Renewable Energy Conference & Expo
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-l border-[#D5E0E4] pl-4">
            <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <div>
              <p className="text-xs font-semibold text-[#24404B]">Online</p>
              <p className="hidden text-xs text-[#78909A] sm:block">REC26 guide</p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 lg:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 overflow-y-auto border-x border-[#0A536B] bg-[#0B5E78] text-white lg:flex lg:flex-col">
          <div className="border-t-4 border-[#EFA74F] px-6 pb-6 pt-7">
            <p className="text-xs font-semibold uppercase text-[#F5C078]">
              Active event
            </p>
            <h2 className="mt-3 text-xl font-semibold leading-7">
              Renewable Energy Conference & Expo 2026
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#CBE7F2]">
              From Systems to Scale: Powering Uganda&apos;s Green Economy
            </p>
          </div>

          <div className="border-y border-white/15 px-6 py-5">
            <div className="flex items-start gap-3">
              <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-[#F5C078]" />
              <div>
                <p className="text-sm font-semibold">19-22 October 2026</p>
                <p className="mt-1 text-xs leading-5 text-[#B9DCE9]">
                  Four programme days
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-start gap-3">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-[#F5C078]" />
              <div>
                <p className="text-sm font-semibold">Kampala Serena Hotel</p>
                <p className="mt-1 text-xs leading-5 text-[#B9DCE9]">
                  Kampala, Uganda
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 px-6 py-6">
            <p className="text-xs font-semibold uppercase text-[#9DCBDB]">
              Conference guide
            </p>
            <ul className="mt-4 space-y-1">
              {capabilityItems.map(({ label, icon: CapabilityIcon }) => (
                <li key={label} className="flex items-center gap-3 py-2.5 text-sm text-[#E4F2F7]">
                  <CapabilityIcon className="h-4 w-4 shrink-0 text-[#F5C078]" />
                  {label}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-white/15 px-6 py-5">
            <div className="flex items-center gap-3">
              <Wifi className="h-4 w-4 text-[#F5C078]" />
              <p className="text-xs leading-5 text-[#B9DCE9]">
                Answers use published REC data and approved visitor guidance.
              </p>
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col border-r border-[#D5E0E4] bg-white">
          <div className="flex min-h-[68px] shrink-0 items-center justify-between gap-4 border-b border-[#D5E0E4] px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 shrink-0 text-[#EFA74F]" />
                <h2 className="truncate text-sm font-semibold sm:text-base">
                  Conference conversation
                </h2>
              </div>
              <p className="mt-1 hidden text-xs text-[#617780] sm:block">
                Current event guidance and the published REC archive
              </p>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => setMessages([])}
                title="Clear conversation"
                aria-label="Clear conversation"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#D5E0E4] text-[#617780] transition hover:border-[#93B7C5] hover:bg-[#EDF3F5] hover:text-[#176F91] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2E9ECC]"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
          </div>

          <div
            ref={transcriptRef}
            aria-live="polite"
            className="flex-1 space-y-5 overflow-y-auto bg-[#F7F9FA] px-4 py-5 sm:px-6 sm:py-7 lg:px-8"
          >
            {messages.length === 0 ? (
              <div className="mx-auto flex min-h-full max-w-3xl items-center">
                <div className="w-full py-3 sm:py-8">
                  <div className="flex items-center gap-4">
                    <BrandLogo className="h-16 w-16 rounded-lg border border-[#D5E0E4] shadow-sm" />
                    <div>
                      <p className="text-xs font-semibold uppercase text-[#176F91]">
                        Official conference assistant
                      </p>
                      <h3 className="mt-1 text-2xl font-semibold leading-8 text-[#14262D] sm:text-3xl">
                        Plan your REC26 experience
                      </h3>
                    </div>
                  </div>
                  <p className="mt-5 max-w-2xl text-sm leading-7 text-[#526B75] sm:text-base">
                    Get precise programme details, compare sessions, prepare for
                    each day, or explore sponsors and previous conference editions.
                  </p>
                  <div className="mt-6 grid gap-2 sm:grid-cols-2">
                    {suggestedQuestions.map(
                      ({ question: suggestedQuestion, icon: SuggestedIcon }) => (
                        <button
                          key={suggestedQuestion}
                          type="button"
                          onClick={(event) => askQuestion(event, suggestedQuestion)}
                          className="group flex min-h-[68px] items-center gap-3 rounded-md border border-[#D5E0E4] bg-white px-4 py-3 text-left text-sm font-medium leading-5 text-[#29434D] shadow-[0_1px_2px_rgba(20,38,45,0.03)] transition hover:border-[#79B5CC] hover:bg-[#F1F8FA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2E9ECC]"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#E5F3F8] text-[#176F91] transition group-hover:bg-[#D6ECF4]">
                            <SuggestedIcon className="h-4 w-4" />
                          </span>
                          <span>{suggestedQuestion}</span>
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-5xl space-y-5">
                {messages.map((message) => (
                  <Message key={message.id} message={message} />
                ))}
              </div>
            )}
          </div>

          <form
            onSubmit={askQuestion}
            className="shrink-0 border-t border-[#D5E0E4] bg-white px-4 py-3 sm:px-6 sm:py-4 lg:px-8"
          >
            <div className="mx-auto max-w-5xl">
              <div className="flex items-end gap-2 rounded-lg border border-[#B9CBD2] bg-white p-2 shadow-[0_4px_18px_rgba(20,38,45,0.06)] transition focus-within:border-[#2E9ECC] focus-within:ring-2 focus-within:ring-[#D6ECF4]">
                <label htmlFor="conference-question" className="sr-only">
                  Ask the REC conference assistant
                </label>
                <textarea
                  id="conference-question"
                  value={question}
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    if (composerError) setComposerError("");
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      askQuestion(event);
                    }
                  }}
                  minLength={DEFAULT_CHAT_QUESTION_LIMITS.minChars}
                  maxLength={DEFAULT_CHAT_QUESTION_LIMITS.maxChars}
                  aria-invalid={Boolean(composerError)}
                  aria-describedby={
                    composerError
                      ? "conference-question-error"
                      : "conference-question-guidance"
                  }
                  placeholder="Ask about REC26 & EXPO..."
                  rows={2}
                  className="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-[0.9375rem] leading-6 text-[#14262D] outline-none placeholder:text-[#82969E]"
                />
                <button
                  type="submit"
                  disabled={
                    loading ||
                    question.trim().length <
                      DEFAULT_CHAT_QUESTION_LIMITS.minChars
                  }
                  title="Send question"
                  aria-label="Send question"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#176F91] text-white transition hover:bg-[#0B5E78] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2E9ECC] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#AEC0C7]"
                >
                  {loading ? (
                    <LoaderCircle className="h-5 w-5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-5 w-5" />
                  )}
                </button>
              </div>
              {composerError ? (
                <p
                  id="conference-question-error"
                  role="alert"
                  className="mt-2 text-center text-xs font-medium leading-4 text-red-700"
                >
                  {composerError}
                </p>
              ) : (
                <p
                  id="conference-question-guidance"
                  className="mt-2 text-center text-[0.6875rem] leading-4 text-[#78909A]"
                >
                  Information is based on published REC records and may change as
                  the programme is updated.
                </p>
              )}
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
