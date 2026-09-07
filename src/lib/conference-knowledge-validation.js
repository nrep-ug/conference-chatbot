export const CONFERENCE_KNOWLEDGE_CATEGORIES = Object.freeze([
  "venue",
  "connectivity",
  "transport",
  "accessibility",
  "catering",
  "registration",
  "safety",
  "other",
]);

export const CONFERENCE_KNOWLEDGE_LIMITS = Object.freeze({
  items: 50,
  id: 80,
  title: 140,
  answer: 3000,
  keywords: 20,
  keyword: 60,
});

const CATEGORY_SET = new Set(CONFERENCE_KNOWLEDGE_CATEGORIES);

function cleanValidationText(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .trim();
}

function rawKeywords(value) {
  return (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map(cleanValidationText)
    .filter(Boolean);
}

export function normalizeConferenceKnowledgeKeywords(value) {
  const seen = new Set();

  return rawKeywords(value).reduce((keywords, keyword) => {
    const normalized = keyword.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      keywords.push(normalized);
    }
    return keywords;
  }, []);
}

function addIssue(issues, index, field, code, message) {
  issues.push({ index, field, code, message });
}

export function validateConferenceKnowledgeItems(items) {
  const issues = [];

  if (!Array.isArray(items)) {
    addIssue(
      issues,
      null,
      "items",
      "invalid_type",
      "Operational information must be an array."
    );
    return { valid: false, issues };
  }

  if (items.length > CONFERENCE_KNOWLEDGE_LIMITS.items) {
    addIssue(
      issues,
      null,
      "items",
      "too_many_items",
      `A conference can have at most ${CONFERENCE_KNOWLEDGE_LIMITS.items} operational entries.`
    );
  }

  const titleIndexes = new Map();

  items.forEach((item, index) => {
    const entryNumber = index + 1;
    const id = cleanValidationText(item?.id);
    const title = cleanValidationText(item?.title);
    const answer = cleanValidationText(item?.answer);
    const category = cleanValidationText(item?.category);
    const keywords = rawKeywords(item?.keywords);
    const normalizedKeywords = normalizeConferenceKnowledgeKeywords(keywords);
    const isPublished = item?.isPublished === true;

    if (item?.isPublished !== undefined && typeof item.isPublished !== "boolean") {
      addIssue(
        issues,
        index,
        "isPublished",
        "invalid_publish_state",
        `Entry ${entryNumber} has an invalid publish state.`
      );
    }

    if (id.length > CONFERENCE_KNOWLEDGE_LIMITS.id) {
      addIssue(
        issues,
        index,
        "id",
        "id_too_long",
        `Entry ${entryNumber} has an invalid identifier.`
      );
    }

    if (!CATEGORY_SET.has(category)) {
      addIssue(
        issues,
        index,
        "category",
        "invalid_category",
        `Entry ${entryNumber} needs a valid category.`
      );
    }

    if (isPublished && !title) {
      addIssue(
        issues,
        index,
        "title",
        "required_for_publish",
        `Entry ${entryNumber} needs a public topic before it can be published.`
      );
    } else if (title.length > CONFERENCE_KNOWLEDGE_LIMITS.title) {
      addIssue(
        issues,
        index,
        "title",
        "title_too_long",
        `Entry ${entryNumber}'s public topic must be ${CONFERENCE_KNOWLEDGE_LIMITS.title} characters or fewer.`
      );
    }

    if (isPublished && !answer) {
      addIssue(
        issues,
        index,
        "answer",
        "required_for_publish",
        `Entry ${entryNumber} needs a public answer before it can be published.`
      );
    } else if (answer.length > CONFERENCE_KNOWLEDGE_LIMITS.answer) {
      addIssue(
        issues,
        index,
        "answer",
        "answer_too_long",
        `Entry ${entryNumber}'s public answer must be ${CONFERENCE_KNOWLEDGE_LIMITS.answer} characters or fewer.`
      );
    }

    if (isPublished && normalizedKeywords.length === 0) {
      addIssue(
        issues,
        index,
        "keywords",
        "required_for_publish",
        `Entry ${entryNumber} needs at least one matching keyword before it can be published.`
      );
    }

    if (normalizedKeywords.length > CONFERENCE_KNOWLEDGE_LIMITS.keywords) {
      addIssue(
        issues,
        index,
        "keywords",
        "too_many_keywords",
        `Entry ${entryNumber} can have at most ${CONFERENCE_KNOWLEDGE_LIMITS.keywords} matching keywords.`
      );
    }

    if (keywords.some((keyword) => keyword.length > CONFERENCE_KNOWLEDGE_LIMITS.keyword)) {
      addIssue(
        issues,
        index,
        "keywords",
        "keyword_too_long",
        `Entry ${entryNumber}'s keywords must each be ${CONFERENCE_KNOWLEDGE_LIMITS.keyword} characters or fewer.`
      );
    }

    if (title) {
      const titleKey = title.toLowerCase();
      const matchingIndexes = titleIndexes.get(titleKey) || [];
      matchingIndexes.push(index);
      titleIndexes.set(titleKey, matchingIndexes);
    }
  });

  for (const indexes of titleIndexes.values()) {
    if (indexes.length < 2) continue;

    const title = cleanValidationText(items[indexes[0]]?.title);
    for (const index of indexes) {
      addIssue(
        issues,
        index,
        "title",
        "duplicate_title",
        `Entry ${index + 1} duplicates the public topic "${title}".`
      );
    }
  }

  return { valid: issues.length === 0, issues };
}

export function validateConferenceKnowledgeItemForPublishing(item) {
  return validateConferenceKnowledgeItems([
    {
      ...item,
      isPublished: true,
    },
  ]);
}

export function isConferenceKnowledgeItemPublishable(item) {
  return (
    item?.isPublished === true &&
    validateConferenceKnowledgeItems([item]).valid
  );
}

export function formatConferenceKnowledgeValidationError(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "Review the highlighted operational information fields.";
  }

  if (issues.length === 1) return issues[0].message;

  return `${issues[0].message} Review ${issues.length - 1} other highlighted ${
    issues.length === 2 ? "error" : "errors"
  }.`;
}

export class ConferenceKnowledgeValidationError extends Error {
  constructor(issues) {
    super(formatConferenceKnowledgeValidationError(issues));
    this.name = "ConferenceKnowledgeValidationError";
    this.code = "CONFERENCE_KNOWLEDGE_VALIDATION_ERROR";
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

export function assertValidConferenceKnowledgeItems(items) {
  const validation = validateConferenceKnowledgeItems(items);
  if (!validation.valid) {
    throw new ConferenceKnowledgeValidationError(validation.issues);
  }
  return validation;
}
