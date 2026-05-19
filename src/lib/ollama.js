import os from "node:os";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL = process.env.CHAT_MODEL || "mistral";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text-v2-moe";
const CHAT_KEEP_ALIVE = process.env.CHAT_KEEP_ALIVE || "30m";
const EMBED_KEEP_ALIVE = process.env.EMBED_KEEP_ALIVE || CHAT_KEEP_ALIVE;
const OLLAMA_TIMEOUT_MS = readInteger("OLLAMA_TIMEOUT_MS", 120000);
const DEFAULT_CHAT_NUM_THREAD = Math.max(
  1,
  Math.min(12, (os.availableParallelism?.() || os.cpus().length) - 2)
);

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readOptionalInteger(name) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFloat(name, fallback) {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function buildChatOptions() {
  const options = {
    temperature: readFloat("CHAT_TEMPERATURE", 0.1),
    num_ctx: readInteger("CHAT_NUM_CTX", 1024),
    num_predict: readInteger("CHAT_NUM_PREDICT", 160),
  };

  const numThread =
    readOptionalInteger("CHAT_NUM_THREAD") || DEFAULT_CHAT_NUM_THREAD;
  if (numThread) {
    options.num_thread = numThread;
  }

  return options;
}

function createRequestSignal(parentSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function buildMessages({ question, context }) {
  return [
    {
      role: "system",
      content:
        "Use CONTEXT only. If missing, say: I could not find that information in the conference materials. Be concise.",
    },
    {
      role: "user",
      content: `CONTEXT:
${context}

Q: ${question}`,
    },
  ];
}

export async function getEmbedding(text, { signal } = {}) {
  const requestSignal = createRequestSignal(signal);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: requestSignal.signal,
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: text,
        keep_alive: EMBED_KEEP_ALIVE,
        truncate: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding failed: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.embeddings || !data.embeddings[0]) {
      throw new Error("No embedding returned from Ollama.");
    }

    return data.embeddings[0];
  } finally {
    requestSignal.cleanup();
  }
}

export async function askMistral({ question, context, signal }) {
  const requestSignal = createRequestSignal(signal);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: requestSignal.signal,
      body: JSON.stringify({
        model: CHAT_MODEL,
        stream: false,
        keep_alive: CHAT_KEEP_ALIVE,
        options: buildChatOptions(),
        messages: buildMessages({ question, context }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.message.content.trim();
  } finally {
    requestSignal.cleanup();
  }
}

export async function streamMistral({ question, context, signal, onToken }) {
  const requestSignal = createRequestSignal(signal);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: requestSignal.signal,
      body: JSON.stringify({
        model: CHAT_MODEL,
        stream: true,
        keep_alive: CHAT_KEEP_ALIVE,
        options: buildChatOptions(),
        messages: buildMessages({ question, context }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat failed: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("Ollama did not return a response stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        const data = JSON.parse(line);
        const token = data.message?.content || "";

        if (token) {
          answer += token;
          onToken?.(token);
        }

        if (data.done) {
          return answer.trim();
        }
      }
    }

    if (buffer.trim()) {
      const data = JSON.parse(buffer);
      const token = data.message?.content || "";
      if (token) {
        answer += token;
        onToken?.(token);
      }
    }

    return answer.trim();
  } finally {
    requestSignal.cleanup();
  }
}
