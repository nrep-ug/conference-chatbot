const DIAGNOSTIC_LOGS_ENABLED = process.env.CHAT_DIAGNOSTIC_LOGS === "true";

function sanitizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
  if (typeof value !== "object") return String(value);

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/(api[_-]?key|secret|token|password|authorization)/i.test(key)
      )
      .map(([key, item]) => [key, sanitizeValue(item)])
  );
}

export function logChatEvent(event, payload = {}) {
  if (!DIAGNOSTIC_LOGS_ENABLED) return;

  console.info(
    JSON.stringify({
      type: "conference_chatbot",
      event,
      at: new Date().toISOString(),
      ...sanitizeValue(payload),
    })
  );
}
