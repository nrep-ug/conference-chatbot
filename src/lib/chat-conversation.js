const ALLOWED_HISTORY_ROLES = new Set(["user", "assistant"]);

const COURTESY_PHRASES = [
  {
    kind: "gratitude",
    pattern:
      /^(?:(?:many )?thanks(?: a lot| so much| very much)?|thank you(?: very much| so much)?|(?:much|really) appreciated|(?:i )?(?:really )?appreciate (?:it|that))(?: for (?:the |your )?(?:help|answer|information|info|details|photos|pictures|images|album|links?|report|explanation|guidance))?(?=\s|$)/,
  },
  {
    kind: "positive",
    pattern:
      /^(?:(?:that|this|it) (?:is|was|sounds|looks) )?(?:(?:very|really|quite|so) )?(?:nice|great|good|helpful|useful|interesting|clear|amazing|perfect|excellent|awesome|cool|wonderful|lovely)(?=\s|$)/,
  },
  {
    kind: "acknowledgement",
    pattern:
      /^(?:okay|ok|alright|all right|got it|i see|i understand|understood|makes sense|sounds good|noted)(?=\s|$)/,
  },
  { kind: "interjection", pattern: /^(?:oh+|ah+|wow|well|hey|hi|hello)(?=\s|$)/ },
];

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
  // Keep all language content so a mixed-language question cannot become just "thanks".
  let remaining = String(question || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/\b(that|this|it)'s\b/g, "$1 is")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!remaining || remaining.length > 120) return null;

  const kinds = new Set();

  // Every phrase must be a courtesy; any remaining request uses the normal answer flow.
  while (remaining) {
    const phrase = COURTESY_PHRASES.find(({ pattern }) => pattern.test(remaining));
    if (!phrase) return null;

    kinds.add(phrase.kind);
    remaining = remaining.replace(phrase.pattern, "").trimStart();
    if (remaining === "and") return null;
    remaining = remaining.replace(/^and\s+/, "");
  }

  // Explicit thanks are safe to acknowledge even when the client sends no history.
  if (kinds.has("gratitude")) return "You're welcome!";
  if (!Array.isArray(history) || history.length === 0) return null;

  if (kinds.has("positive")) {
    return "Glad that was helpful. What would you like to explore next?";
  }

  return kinds.has("acknowledgement")
    ? "Understood. What would you like to explore next?"
    : null;
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
    content: message.content.normalize("NFC"),
  }));

  return JSON.stringify({
    question: String(question).normalize("NFC").trim(),
    history: recentHistory,
  });
}
