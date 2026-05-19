const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const CHAT_MODEL = process.env.CHAT_MODEL || "mistral";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text-v2-moe";

export async function getEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
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
}

export async function askMistral({ question, context }) {
  const systemPrompt = `
You are a conference chatbot.

Only answer using the provided conference context.
If the answer is not found in the context, say:
"I could not find that information in the conference materials."

Do not invent dates, speakers, venues, prices, or schedules.
Keep answers clear and helpful.
`;

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `
Conference context:
${context}

Question:
${question}
`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.message.content;
}