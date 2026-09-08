import { askPlanner } from "./ollama.js";
import { logChatEvent } from "./chat-diagnostics.js";
import { extractRequestedDays, getRecPublicSnapshot } from "./rec-data.js";
import { getPlannerSchemaPrompt, REC_SCHEMA } from "./rec-schema.js";

const PLANNER_ENABLED = process.env.PLANNER_ENABLED !== "false";
const MAX_OPERATIONS = readInteger("PLANNER_MAX_OPERATIONS", 4);
const MAX_ROWS_PER_OPERATION = readInteger("PLANNER_MAX_ROWS_PER_OPERATION", 12);
const MAX_CONTEXT_CHARS = readInteger("PLANNER_MAX_CONTEXT_CHARS", 3200);
const MAX_SCHEMA_CHARS = readInteger("PLANNER_SCHEMA_MAX_CHARS", 4500);

const SOURCE_TYPES = {
  conferences: "conference_overview",
  programs: "program_overview",
  timeBlocks: "program_time_block",
  sessions: "session",
  sponsorCategories: "sponsor_category",
  sponsors: "sponsor",
  mediaItems: "conference_media",
  reports: "conference_report",
  operationalInfo: "operational_info",
};

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/\s+/g, " ").trim();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson(value, fallback) {
  if (!value || typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function truncate(value, maxLength = 600) {
  const text = String(value || "").trim();

  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength).trim()}...`;
}

function formatDate(value) {
  if (!value) return "";

  return new Intl.DateTimeFormat("en-UG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return "";

  return new Intl.DateTimeFormat("en-UG", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Africa/Kampala",
  }).format(new Date(value));
}

function extractJsonObject(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function cleanString(value, maxLength = 80) {
  if (typeof value !== "string") return "";

  return value.trim().slice(0, maxLength);
}

function cleanStringArray(value, maxItems = 8) {
  const values = Array.isArray(value) ? value : value ? [value] : [];

  return values
    .map((item) => cleanString(item, 80))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return {};
  const sanitized = {};

  if (Number.isFinite(Number(filters.day))) {
    const day = Number(filters.day);
    if (day >= 1 && day <= 10) sanitized.day = day;
  }

  for (const key of ["year", "conferenceYear"]) {
    if (Number.isFinite(Number(filters[key]))) {
      const year = Number(filters[key]);
      if (year >= 2000 && year <= 2100) sanitized[key] = year;
    }
  }

  const date = cleanString(filters.date, 20);
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) sanitized.date = date.slice(0, 10);

  for (const key of [
    "title",
    "theme",
    "venueHall",
    "type",
    "categoryName",
    "category",
    "mediaType",
    "reportType",
    "status",
  ]) {
    const value = cleanString(filters[key]);
    if (value) sanitized[key] = value;
  }

  if (typeof filters.isActive === "boolean") {
    sanitized.isActive = filters.isActive;
  }

  if (typeof filters.isPublished === "boolean") {
    sanitized.isPublished = filters.isPublished;
  }

  if (typeof filters.isFeatured === "boolean") {
    sanitized.isFeatured = filters.isFeatured;
  }

  const keywords = cleanStringArray(filters.keywords);
  if (keywords.length > 0) {
    sanitized.keywords = keywords;
  }

  return sanitized;
}

function sanitizeOperation(operation) {
  const table = cleanString(operation?.table);
  if (!Object.hasOwn(REC_SCHEMA.tables, table)) return null;
  const tableSchema = REC_SCHEMA.tables[table];

  if (!tableSchema) return null;

  const allowedFieldSet = new Set(tableSchema.fields);
  const fields = cleanStringArray(operation.fields, 12).filter((field) =>
    allowedFieldSet.has(field)
  );
  const allowedSortSet = new Set(REC_SCHEMA.allowedSortFields);
  const sort = cleanStringArray(operation.sort, 4).filter((field) =>
    allowedSortSet.has(field)
  );
  const limit = Math.min(
    Math.max(Number.parseInt(operation.limit || 0, 10) || 8, 1),
    MAX_ROWS_PER_OPERATION
  );

  return {
    table,
    purpose: cleanString(operation.purpose, 160),
    filters: sanitizeFilters(operation.filters),
    fields: fields.length > 0 ? fields : tableSchema.defaultFields,
    sort,
    limit,
  };
}

function sanitizePlan(rawPlan) {
  if (!rawPlan || rawPlan.lookup === false) return null;

  const operations = (Array.isArray(rawPlan.operations) ? rawPlan.operations : [])
    .map(sanitizeOperation)
    .filter(Boolean)
    .slice(0, MAX_OPERATIONS);

  if (operations.length === 0 || operations.length !== rawPlan.operations?.length) return null;

  return {
    lookup: true,
    reason: cleanString(rawPlan.reason, 180),
    answerStyle: cleanString(rawPlan.answerStyle, 120),
    operations,
  };
}

export function validateRecPlan(rawPlan, question) {
  const plan = sanitizePlan(rawPlan);
  if (!plan) return null;
  const text = normalize(question);
  // Refuse invented narrowing instead of treating any nonempty lookup as correct.
  for (const operation of plan.operations) {
    for (const [key, value] of Object.entries(operation.filters)) {
      if (key === "day" && !extractRequestedDays(text).includes(value)) return null;
      if (["year", "conferenceYear"].includes(key) && !text.includes(String(value)) && !new RegExp(`\\brec\\s*[-']?\\s*${String(value).slice(2)}\\b`).test(text)) return null;
      if (["keywords", "title", "theme", "venueHall", "categoryName"].includes(key)) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some((item) => !text.includes(normalize(item)))) return null;
      }
    }
  }
  return plan;
}

function getConferenceBundles(snapshot) {
  return [
    {
      conference: snapshot.conference,
      programs: snapshot.programs || [],
      timeBlocks: snapshot.timeBlocks || [],
      sessions: snapshot.sessions || [],
      sponsorCategories: snapshot.sponsorCategories || [],
      sponsors: snapshot.sponsors || [],
      mediaItems: snapshot.mediaItems || [],
      reports: snapshot.reports || [],
      operationalInfo: snapshot.operationalInfo || [],
    },
    ...(snapshot.pastConferences || []),
  ];
}

function getRows(snapshot, table) {
  const bundles = getConferenceBundles(snapshot);

  if (table === "conferences") {
    return bundles.map((bundle) => ({
      ...bundle.conference,
      conferenceYear: bundle.conference.year,
    }));
  }

  return bundles.flatMap((bundle) =>
    (bundle[table] || []).map((row) => ({
      ...row,
      conferenceId: row.conferenceId || bundle.conference.$id,
      conferenceYear: bundle.conference.year,
      conferenceTitle: bundle.conference.title,
    }))
  );
}

function getSponsorCategoryMap(snapshot) {
  return new Map(
    getConferenceBundles(snapshot).reduce(
      (entries, bundle) => [
        ...entries,
        ...(bundle.sponsorCategories || []).map((category) => [
          category.$id,
          category.name,
        ]),
      ],
      []
    )
  );
}

function valueToText(value) {
  if (Array.isArray(value)) return value.join(" ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return stripHtml(value);
}

function rowSearchText(row, table, snapshot) {
  const tableSchema = REC_SCHEMA.tables[table];
  const values = tableSchema.searchableFields.map((field) => valueToText(row[field]));

  if (table === "sessions") {
    const bundle = getConferenceBundles(snapshot).find((b) => b.conference.$id === row.conferenceId);
    const day = parseJson(bundle?.conference.days, [])[Number(row.day) - 1];
    values.push(day?.theme || "");
  }

  if (table === "sponsors") {
    const categories = getSponsorCategoryMap(snapshot);
    values.push(categories.get(row.categoryId) || "");
  }

  if (table === "conferences") {
    const days = parseJson(row.days, []);
    values.push(days.map((day) => `${day.label} ${day.theme} ${day.date}`).join(" "));
  }

  return normalize(values.join(" "));
}

function containsText(row, fields, value) {
  const needle = normalize(value);
  if (!needle) return true;

  return fields.some((field) => normalize(valueToText(row[field])).includes(needle));
}

function rowMatchesFilters(row, table, filters, snapshot) {
  if (filters.day && Number(row.day) !== filters.day) return false;
  if (filters.year && Number(row.year || row.conferenceYear) !== filters.year) {
    return false;
  }
  if (
    filters.conferenceYear &&
    Number(row.conferenceYear || row.year) !== filters.conferenceYear
  ) {
    return false;
  }
  if (filters.date && !normalize(row.date).includes(normalize(filters.date))) return false;
  if (filters.type && normalize(row.type) !== normalize(filters.type)) return false;
  if (
    filters.mediaType &&
    normalize(row.mediaType) !== normalize(filters.mediaType)
  ) {
    return false;
  }
  if (
    filters.reportType &&
    normalize(row.reportType) !== normalize(filters.reportType)
  ) {
    return false;
  }
  if (filters.category && normalize(row.category) !== normalize(filters.category)) {
    return false;
  }
  if (filters.status && normalize(row.status) !== normalize(filters.status)) return false;
  if (typeof filters.isActive === "boolean" && row.isActive !== filters.isActive) {
    return false;
  }
  if (
    typeof filters.isPublished === "boolean" &&
    row.isPublished !== filters.isPublished
  ) {
    return false;
  }
  if (
    typeof filters.isFeatured === "boolean" &&
    row.isFeatured !== filters.isFeatured
  ) {
    return false;
  }

  if (filters.title) {
    const titleFields = table === "timeBlocks" ? ["label"] : ["title", "name"];
    if (!containsText(row, titleFields, filters.title)) return false;
  }

  if (filters.theme && !containsText(row, ["theme"], filters.theme)) {
    const bundle = getConferenceBundles(snapshot).find((b) => b.conference.$id === row.conferenceId);
    const day = parseJson(bundle?.conference.days, [])[Number(row.day) - 1];
    if (table !== "sessions" || !normalize(day?.theme).includes(normalize(filters.theme))) return false;
  }

  if (filters.venueHall) {
    const venueText = normalize(`${valueToText(row.venueHall)} ${valueToText(row.venueHalls)}`);
    if (!venueText.includes(normalize(filters.venueHall))) return false;
  }

  if (filters.categoryName) {
    const categoryMap = getSponsorCategoryMap(snapshot);
    const categoryText =
      table === "sponsors"
        ? categoryMap.get(row.categoryId) || ""
        : row.name || row.slug || "";
    if (!normalize(categoryText).includes(normalize(filters.categoryName))) {
      return false;
    }
  }

  if (filters.keywords?.length > 0) {
    const text = rowSearchText(row, table, snapshot);
    const hasMatch = filters.keywords.some((keyword) =>
      text.includes(normalize(keyword))
    );

    if (!hasMatch) return false;
  }

  return true;
}

function defaultSort(table) {
  if (table === "sessions") return ["day", "startTime", "title"];
  if (table === "timeBlocks") return ["day", "startMinutes", "label"];
  if (table === "sponsors" || table === "sponsorCategories") {
    return ["displayOrder", "name"];
  }
  if (table === "mediaItems") return ["conferenceYear", "displayOrder", "title"];
  if (table === "reports") {
    return ["conferenceYear", "displayOrder", "title"];
  }
  if (table === "operationalInfo") return ["category", "title"];
  if (table === "conferences") return ["startDate"];
  return ["title"];
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;

  return String(a).localeCompare(String(b), "en", { numeric: true });
}

function sortRows(rows, table, requestedSort) {
  const sort = requestedSort.length > 0 ? requestedSort : defaultSort(table);

  return [...rows].sort((a, b) => {
    for (const field of sort) {
      const result = compareValues(a[field], b[field]);
      if (result !== 0) return result;
    }

    return 0;
  });
}

function formatFieldValue(field, value, table, snapshot) {
  if (value === null || value === undefined || value === "") return "";
  if (field === "preamble" || field === "description") return truncate(stripHtml(value));
  if (field === "startTime" || field === "toTime" || field === "endTime") {
    return formatTime(value);
  }
  if (
    field === "startDate" ||
    field === "endDate" ||
    field === "publicationDate"
  ) {
    return formatDate(value);
  }
  if (field === "days") {
    return parseJson(value, [])
      .map((day) => `${day.label}: ${day.date}, ${day.theme}`)
      .join("; ");
  }
  if (field === "registrationFee" || field === "maxLimits" || field === "currentCounts") {
    return JSON.stringify(parseJson(value, value));
  }
  if (field === "sampleImagesJson") {
    return parseJson(value, [])
      .map((image) => image.url)
      .filter(Boolean)
      .join(", ");
  }
  if (field === "categoryId" && table === "sponsors") {
    return getSponsorCategoryMap(snapshot).get(value) || value;
  }
  if (Array.isArray(value)) return value.join(", ");

  return String(value);
}

function getRowLabel(row, table) {
  if (table === "timeBlocks") return row.label || row.$id;
  return row.title || row.name || row.shortName || row.$id;
}

function formatRowContext(row, table, fields, snapshot) {
  const tableSchema = REC_SCHEMA.tables[table];
  const fieldLines = fields
    .map((field) => {
      const value = formatFieldValue(field, row[field], table, snapshot);
      return value ? `${field}: ${value}` : null;
    })
    .filter(Boolean);

  return [
    `Table: ${tableSchema.label}`,
    `Row: ${getRowLabel(row, table)}`,
    row.conferenceYear ? `Conference year: ${row.conferenceYear}` : null,
    ...fieldLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function sourceFor(table, row) {
  return {
    source: getRowLabel(row, table),
    sourceType: SOURCE_TYPES[table] || table,
    tableId: row?.$tableId,
    rowId: row?.$id,
    score: 1,
  };
}

function executeOperation(operation, snapshot) {
  const hasHistoricalFilter = Boolean(
    operation.filters.year ||
      operation.filters.conferenceYear ||
      operation.filters.isActive === false
  );
  const activeConferenceId = snapshot.conference.$id;
  const rows = getRows(snapshot, operation.table)
    .filter((row) => {
      if (hasHistoricalFilter) return true;
      const rowConferenceId =
        operation.table === "conferences" ? row.$id : row.conferenceId;
      return !rowConferenceId || rowConferenceId === activeConferenceId;
    })
    .filter((row) => rowMatchesFilters(row, operation.table, operation.filters, snapshot));
  const sortedRows = sortRows(rows, operation.table, operation.sort).slice(
    0,
    operation.limit
  );

  return {
    operation,
    total: rows.length,
    rows: sortedRows,
    context: sortedRows
      .map((row) =>
        formatRowContext(row, operation.table, operation.fields, snapshot)
      )
      .join("\n\n"),
    sources: sortedRows.map((row) => sourceFor(operation.table, row)),
  };
}

export function executeRecPlan(plan, snapshot, maxContextChars = MAX_CONTEXT_CHARS) {
  const results = plan.operations.map((operation) =>
    executeOperation(operation, snapshot)
  );
  const contextSections = [];
  const coverage = [];
  const sources = [];
  const seenSources = new Set();
  const budget = Math.floor(Math.max(0, maxContextChars - 500) / Math.max(1, results.length));
  for (const result of results) {
    let section = `Table: ${result.operation.table}; matching records: ${result.total}.\n`;
    let included = 0;
    for (const row of result.rows) {
      const text = formatRowContext(row, result.operation.table, result.operation.fields, snapshot);
      if (section.length + text.length + 100 > budget) continue;
      section += `\n${text}\n`;
      included += 1;
      const source = sourceFor(result.operation.table, row);
      const key = `${source.sourceType}:${source.rowId}`;
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      sources.push(source);
    }
    const complete = included === result.total;
    coverage.push({ table: result.operation.table, matched: result.total, included, complete });
    section += `\nCoverage: ${included}/${result.total}. ${complete ? "Complete lookup." : "Partial evidence; do not claim a complete list or infer missing facts."}`;
    contextSections.push(section);
  }

  if (contextSections.length === 0) {
    return {
      context: "",
      sources: [],
    };
  }

  const header = [
    `Default active conference: ${snapshot.conference.title} (${snapshot.conference.shortName})`,
    `Available previous conference years: ${(snapshot.pastConferences || [])
      .map((bundle) => bundle.conference?.year)
      .filter(Boolean)
      .join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    context: `${header}\n\n${contextSections.join("\n\n---\n\n")}`,
    sources,
    coverage,
  };
}

function summarizePlan(plan) {
  if (!plan) return null;

  return {
    reason: plan.reason,
    operations: plan.operations.map((operation) => ({
      table: operation.table,
      filters: operation.filters,
      limit: operation.limit,
    })),
  };
}

export async function retrievePlannedRecContext(
  question,
  { signal, requestId, history = [] } = {}
) {
  if (!PLANNER_ENABLED) {
    logChatEvent("planner_disabled", { requestId });
    return { confident: false, context: "", sources: [], plan: null };
  }

  const startedAt = Date.now();

  try {
    const schema = getPlannerSchemaPrompt().slice(0, MAX_SCHEMA_CHARS);
    const rawPlanText = await askPlanner({ question, schema, history, signal, requestId });
    const rawPlan = extractJsonObject(rawPlanText);
    const plan = validateRecPlan(rawPlan, question);

    if (!plan) {
      logChatEvent("planner_invalid_or_empty", {
        requestId,
        durationMs: Date.now() - startedAt,
        rawPreview: rawPlanText,
      });

      return { confident: false, context: "", sources: [], plan: null };
    }

    const snapshot = await getRecPublicSnapshot({ signal });
    const result = executeRecPlan(plan, snapshot);
    const confident = result.sources.length > 0 && result.coverage.every((item) => item.complete && item.matched > 0);
    logChatEvent("planner_executed", {
      requestId,
      durationMs: Date.now() - startedAt,
      confident,
      coverage: result.coverage,
      sourceCount: result.sources.length,
      contextChars: result.context.length,
      plan: summarizePlan(plan),
    });

    return {
      confident,
      context: result.context,
      sources: result.sources,
      plan,
    };
  } catch (error) {
    logChatEvent("planner_error", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: error.message,
    });
    console.warn("REC planner lookup skipped:", error.message);
    return { confident: false, context: "", sources: [], plan: null };
  }
}
