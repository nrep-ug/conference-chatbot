const ALLOWED_HISTORY_ROLES = new Set(["user", "assistant"]);

export const DEFAULT_CHAT_HISTORY_LIMITS = Object.freeze({
  maxMessages: 8,
  maxMessageChars: 1200,
  maxTotalChars: 4800,
});

export const DEFAULT_CHAT_QUESTION_LIMITS = Object.freeze({
  minChars: 2,
  maxChars: 4000,
});

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function cleanMessageContent(value, maxChars) {
  return String(value || "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxChars);
}

function normalizedConversationText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2019`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateChatQuestion(rawQuestion, options = {}) {
  const minChars = positiveInteger(
    options.minChars,
    DEFAULT_CHAT_QUESTION_LIMITS.minChars
  );
  const maxChars = positiveInteger(
    options.maxChars,
    DEFAULT_CHAT_QUESTION_LIMITS.maxChars
  );

  if (typeof rawQuestion !== "string") {
    return {
      valid: false,
      question: "",
      error: "Please provide a valid question.",
    };
  }

  const question = rawQuestion.replace(/\0/g, "").trim();

  if (question.length < minChars) {
    return {
      valid: false,
      question,
      error: `Please enter at least ${minChars} characters.`,
    };
  }

  if (question.length > maxChars) {
    return {
      valid: false,
      question,
      error: `Please keep the question under ${maxChars} characters.`,
    };
  }

  return { valid: true, question, error: "" };
}

export function sanitizeChatHistory(rawHistory, options = {}) {
  if (!Array.isArray(rawHistory)) return [];

  const maxMessages = positiveInteger(
    options.maxMessages,
    DEFAULT_CHAT_HISTORY_LIMITS.maxMessages
  );
  const maxMessageChars = positiveInteger(
    options.maxMessageChars,
    DEFAULT_CHAT_HISTORY_LIMITS.maxMessageChars
  );
  const maxTotalChars = positiveInteger(
    options.maxTotalChars,
    DEFAULT_CHAT_HISTORY_LIMITS.maxTotalChars
  );
  const history = [];
  let totalChars = 0;
  const oldestCandidate = Math.max(0, rawHistory.length - maxMessages * 4);

  for (
    let index = rawHistory.length - 1;
    index >= oldestCandidate && history.length < maxMessages;
    index -= 1
  ) {
    const message = rawHistory[index];
    const role = String(message?.role || "").toLowerCase();
    if (!ALLOWED_HISTORY_ROLES.has(role)) continue;

    const availableChars = maxTotalChars - totalChars;
    if (availableChars <= 0) break;

    const content = cleanMessageContent(
      message?.content,
      Math.min(maxMessageChars, availableChars)
    );
    if (!content) continue;

    history.unshift({ role, content });
    totalChars += content.length;
  }

  return history;
}

export function getConversationalReply(question, history = []) {
  if (!Array.isArray(history) || history.length === 0) return null;

  const normalized = normalizedConversationText(question);
  if (!normalized || normalized.length > 120) return null;

  if (
    /^(?:many )?(?:thanks|thank you|thank you very much|much appreciated)$/.test(
      normalized
    )
  ) {
    return "You're welcome. What else would you like to know about REC26 & EXPO?";
  }

  if (
    /^(?:(?:oh+|ah+|wow|well)\s+)?(?:(?:that|this|it)\s+(?:is|was|sounds|looks)\s+)?(?:(?:very|really|quite)\s+)?(?:nice|great|good|helpful|useful|interesting|clear|amazing|perfect|excellent|awesome|cool|wonderful|lovely)$/.test(
      normalized
    )
  ) {
    return "Glad that was helpful. What would you like to explore next about REC26 & EXPO?";
  }

  if (
    /^(?:ok|okay|alright|all right|got it|i see|understood|makes sense|sounds good|noted)$/.test(
      normalized
    )
  ) {
    return "Understood. What would you like to explore next about REC26 & EXPO?";
  }

  return null;
}

export function isHistoryDependentFollowUp(question, history = []) {
  if (!Array.isArray(history) || history.length === 0) return false;

  const normalized = normalizedConversationText(question);
  if (!normalized) return false;

  const hasReference =
    /\b(it|its|they|their|theirs|them|that|those|this|these|former|latter|same|above)\b/.test(
      normalized
    );
  const hasVagueFollowUp =
    /^(?:(?:and|also|but|so|then)\s+)?(?:tell me more|more details|what about|what of|how about|and what|why|when|where|who|which one)\b/.test(
      normalized
    );

  if (!hasReference && !hasVagueFollowUp) return false;

  const hasStandaloneAnchor =
    /\b(?:day\s*[1-4]|rec\s*[-']?\s*\d{2}|20(?:22|23|24|25|26)|renewable energy conference|opening ceremony|closing ceremony|tea break|lunch break|exhibition blocks?|registration status)\b/.test(
      normalized
    );

  return !hasStandaloneAnchor;
}

export function buildHistoryAwareQuery(question, history = [], options = {}) {
  if (!isHistoryDependentFollowUp(question, history)) return question;

  const maxChars = positiveInteger(options.maxChars, 2400);
  const recentHistory = sanitizeChatHistory(history, {
    maxMessages: 4,
    maxMessageChars: 700,
    maxTotalChars: Math.max(800, maxChars - String(question).length - 120),
  });
  const conversation = recentHistory
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`
    )
    .join("\n");

  return [
    `Current follow-up: ${question}`,
    "Recent conversation for resolving references only:",
    conversation,
  ]
    .join("\n")
    .slice(0, maxChars);
}

export function buildConversationCacheKey(question, history = []) {
  const recentHistory = sanitizeChatHistory(history).map((message) => ({
    role: message.role,
    content: normalizedConversationText(message.content),
  }));

  return JSON.stringify({
    question: normalizedConversationText(question),
    history: recentHistory,
  });
}
