import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Query, listAllRows, listRows } from "./appwrite.js";

export const HR_DATABASE_ID =
  process.env.APPWRITE_DATABASE_ID || "66bcc8760033a24883f6";
export const REC_TABLES = {
  conferences:
    process.env.APPWRITE_REC_CONFERENCES_TABLE_ID || "6863ae070028061694f1",
  programs: process.env.APPWRITE_REC_PROGRAM_TABLE_ID || "68e62391001de7d5c9be",
  timeBlocks:
    process.env.APPWRITE_REC_PROGRAM_TIME_BLOCKS_TABLE_ID ||
    "rec_program_time_blocks",
  sessions: process.env.APPWRITE_REC_SESSIONS_TABLE_ID || "68e60fc1003b0bbb05d8",
  sponsorCategories:
    process.env.APPWRITE_REC_SPONSOR_CATEGORIES_TABLE_ID ||
    "rec_sponsor_categories",
  sponsors: process.env.APPWRITE_REC_SPONSORS_TABLE_ID || "rec_sponsors",
};

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");
const SNAPSHOT_JSON_PATH = path.join(GENERATED_DIR, "rec-current.json");
const SNAPSHOT_MD_PATH = path.join(GENERATED_DIR, "rec-current.md");

function parseJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

function compact(values) {
  return values.filter((value) => value !== null && value !== undefined && value !== "");
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

function formatConferenceDates(conference) {
  const startDate = formatDate(conference.startDate);
  const endDate = formatDate(conference.endDate);

  if (!startDate && !endDate) return "";
  if (startDate === endDate) return startDate;

  return `${startDate} to ${endDate}`;
}

function normalizeSnapshot(snapshot, metadata = {}) {
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: "appwrite",
      databaseId: HR_DATABASE_ID,
      tables: REC_TABLES,
      activeConferenceId: snapshot.conference?.$id,
      ...metadata,
    },
    conference: snapshot.conference,
    programs: snapshot.programs || [],
    timeBlocks: snapshot.timeBlocks || [],
    sessions: snapshot.sessions || [],
    sponsorCategories: snapshot.sponsorCategories || [],
    sponsors: snapshot.sponsors || [],
  };
}

async function getActiveConference(signal) {
  const query = Query();
  const result = await listRows(HR_DATABASE_ID, REC_TABLES.conferences, {
    signal,
    queries: [query.equal("isActive", true), query.limit(1)],
  });

  if (!result.rows[0]) {
    throw new Error("No active REC conference found in Appwrite.");
  }

  return result.rows[0];
}

async function listRowsByField(tableId, field, value, signal) {
  const query = Query();

  return listAllRows(HR_DATABASE_ID, tableId, {
    signal,
    queries: [query.equal(field, value)],
  });
}

async function listRowsByProgramIds(tableId, programIds, signal) {
  const rows = [];

  for (const programId of programIds) {
    rows.push(...(await listRowsByField(tableId, "programId", programId, signal)));
  }

  return rows;
}

export async function fetchRecSnapshotFromAppwrite({ signal } = {}) {
  const conference = await getActiveConference(signal);
  const conferenceId = conference.$id;
  const programs = await listRowsByField(
    REC_TABLES.programs,
    "conferenceId",
    conferenceId,
    signal
  );
  const programIds = programs.map((program) => program.$id);
  const [timeBlocks, sessions, sponsorCategories, sponsors] =
    await Promise.all([
      listRowsByProgramIds(REC_TABLES.timeBlocks, programIds, signal),
      listRowsByProgramIds(REC_TABLES.sessions, programIds, signal),
      listRowsByField(
        REC_TABLES.sponsorCategories,
        "conferenceId",
        conferenceId,
        signal
      ),
      listRowsByField(REC_TABLES.sponsors, "conferenceId", conferenceId, signal),
    ]);

  return normalizeSnapshot({
    conference,
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
  });
}

export function snapshotToRuntimeData(snapshot) {
  return {
    conference: snapshot.conference,
    programs: snapshot.programs || [],
    timeBlocks: snapshot.timeBlocks || [],
    sessions: snapshot.sessions || [],
    sponsorCategories: snapshot.sponsorCategories || [],
    sponsors: snapshot.sponsors || [],
    metadata: snapshot.metadata,
  };
}

export function getSnapshotPaths() {
  return {
    directory: GENERATED_DIR,
    json: SNAPSHOT_JSON_PATH,
    markdown: SNAPSHOT_MD_PATH,
  };
}

export async function readGeneratedRecSnapshot() {
  const raw = await readFile(SNAPSHOT_JSON_PATH, "utf8");
  const snapshot = JSON.parse(raw);

  if (!snapshot?.conference?.$id) {
    throw new Error(`Generated REC snapshot is invalid: ${SNAPSHOT_JSON_PATH}`);
  }

  return snapshot;
}

function markdownTable(headers, rows) {
  const escapeCell = (value) =>
    String(value ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  const header = `| ${headers.map(escapeCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
    .join("\n");

  return [header, divider, body].filter(Boolean).join("\n");
}

function categoryNameById(snapshot) {
  return new Map(
    (snapshot.sponsorCategories || []).map((category) => [
      category.$id,
      category.name,
    ])
  );
}

export function renderRecSnapshotMarkdown(snapshot) {
  const conference = snapshot.conference;
  const days = parseJson(conference.days, []);
  const categoriesById = categoryNameById(snapshot);
  const activeSponsors = (snapshot.sponsors || [])
    .filter((sponsor) => sponsor.isActive !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  const sessions = [...(snapshot.sessions || [])].sort(
    (a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime)
  );
  const blocks = [...(snapshot.timeBlocks || [])].sort(
    (a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime)
  );

  const sections = [
    `# ${conference.title}`,
    compact([
      `Generated: ${snapshot.metadata?.generatedAt || new Date().toISOString()}`,
      `Source: Appwrite active conference ${conference.$id}`,
    ]).join("\n"),
    "## Conference",
    compact([
      `Short name: ${conference.shortName}`,
      `Theme: ${conference.theme}`,
      `Dates: ${formatConferenceDates(conference)}`,
      `Venue: ${conference.venue}, ${conference.location}`,
      `Website: ${conference.mainWebsiteUrl}`,
      `Registration status: ${conference.registrationOpen ? "open" : "closed"}`,
      conference.regClosedMessage
        ? `Registration message: ${conference.regClosedMessage}`
        : null,
      conference.contactEmail || conference.contactPhone
        ? `Contact: ${compact([conference.contactEmail, conference.contactPhone]).join(", ")}`
        : null,
      conference.description ? `Description: ${stripHtml(conference.description)}` : null,
    ]).join("\n"),
    "## Days",
    markdownTable(
      ["Day", "Date", "Theme"],
      days.map((day, index) => [
        day.label || `Day ${index + 1}`,
        day.date,
        day.theme,
      ])
    ),
    "## Program Time Blocks",
    markdownTable(
      ["Day", "Label", "Type", "Start", "End", "Venue"],
      blocks.map((block) => [
        block.day,
        block.label,
        block.type,
        formatTime(block.startTime),
        formatTime(block.endTime),
        (block.venueHalls || []).join(", "),
      ])
    ),
    "## Sessions",
    markdownTable(
      ["Day", "Title", "Theme", "Time", "Venue", "Organizer", "Details"],
      sessions.map((session) => [
        session.day,
        session.title,
        session.theme,
        `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`,
        session.venueHall,
        session.organizer,
        stripHtml(session.preamble),
      ])
    ),
    "## Sponsors And Partners",
    markdownTable(
      ["Name", "Category", "Featured", "Website", "Description"],
      activeSponsors.map((sponsor) => [
        sponsor.name,
        categoriesById.get(sponsor.categoryId) || "",
        sponsor.isFeatured ? "yes" : "no",
        sponsor.siteUrl,
        stripHtml(sponsor.description),
      ])
    ),
  ];

  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

export async function writeGeneratedRecSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshotToRuntimeData(snapshot), {
    ...(snapshot.metadata || {}),
    generatedAt: new Date().toISOString(),
  });
  const markdown = renderRecSnapshotMarkdown(normalized);

  await mkdir(GENERATED_DIR, { recursive: true });
  await Promise.all([
    writeAtomic(SNAPSHOT_JSON_PATH, `${JSON.stringify(normalized, null, 2)}\n`),
    writeAtomic(SNAPSHOT_MD_PATH, markdown),
  ]);

  return {
    snapshot: normalized,
    paths: getSnapshotPaths(),
    counts: {
      programs: normalized.programs.length,
      timeBlocks: normalized.timeBlocks.length,
      sessions: normalized.sessions.length,
      sponsorCategories: normalized.sponsorCategories.length,
      sponsors: normalized.sponsors.length,
    },
  };
}

export async function refreshGeneratedRecSnapshot({ signal } = {}) {
  const snapshot = await fetchRecSnapshotFromAppwrite({ signal });
  return writeGeneratedRecSnapshot(snapshot);
}
