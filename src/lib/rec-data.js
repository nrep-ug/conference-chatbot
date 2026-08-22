import { stat } from "node:fs/promises";

import {
  HR_DATABASE_ID,
  fetchRecSnapshotFromAppwrite,
  getSnapshotPaths,
  normalizeSpeakerText,
  readGeneratedRecSnapshot,
  snapshotToRuntimeData,
} from "./rec-snapshot.js";

const REC_DATA_CACHE_TTL_MS = readInteger("REC_DATA_CACHE_TTL_MS", 5 * 60 * 1000);
const REC_SNAPSHOT_ENABLED = readBoolean("REC_SNAPSHOT_ENABLED", true);
const REC_SNAPSHOT_STRICT = readBoolean("REC_SNAPSHOT_STRICT", false);
let cachedSnapshot = null;

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

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

function withTerminalPeriod(value) {
  const text = String(value || "").trim();

  if (!text) return "";

  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function markdownList(items) {
  return compact(items)
    .map((item) => `- ${String(item).trim()}`)
    .join("\n");
}

function markdownNumberedList(items) {
  return compact(items)
    .map((item, index) => `${index + 1}. ${String(item).trim()}`)
    .join("\n");
}

function markdownDetails(items) {
  return markdownList(
    items
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([label, value]) => `**${label}:** ${value}`)
  );
}

function joinMarkdownSections(sections) {
  return compact(sections).join("\n\n");
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

function getKampalaMinutes(value) {
  if (!value) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Africa/Kampala",
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return hour * 60 + minute;
}

function normalizeQuestion(question) {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatConferenceDates(conference) {
  const startDate = formatDate(conference.startDate);
  const endDate = formatDate(conference.endDate);

  if (!startDate && !endDate) return "";
  if (startDate === endDate) return startDate;

  return `${startDate} to ${endDate}`;
}

function formatConferenceVenue(conference) {
  const parts = compact([conference.venue, conference.location])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set();

  return parts
    .filter((part) => {
      const key = normalizeQuestion(part);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

function sourceFor(type, row, label) {
  return {
    source: label,
    sourceType: type,
    tableId: row?.$tableId,
    rowId: row?.$id,
    score: 1,
  };
}

async function readSnapshotFileSignature() {
  try {
    const file = await stat(getSnapshotPaths().json);
    return `${file.mtimeMs}:${file.size}`;
  } catch {
    return null;
  }
}

async function getCache() {
  if (
    !cachedSnapshot ||
    Date.now() - cachedSnapshot.createdAt >= REC_DATA_CACHE_TTL_MS
  ) {
    return null;
  }

  if (cachedSnapshot.snapshotFileSignature) {
    const currentSignature = await readSnapshotFileSignature();

    if (currentSignature !== cachedSnapshot.snapshotFileSignature) {
      cachedSnapshot = null;
      return null;
    }
  }

  return cachedSnapshot.data;
}

function setCache(data, { snapshotFileSignature = null } = {}) {
  cachedSnapshot = {
    createdAt: Date.now(),
    data,
    snapshotFileSignature,
  };
}

export function invalidateRecPublicSnapshotCache() {
  cachedSnapshot = null;
}

export async function getRecPublicSnapshot({ signal, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await getCache();
    if (cached) return cached;
  }

  if (!forceRefresh && REC_SNAPSHOT_ENABLED) {
    try {
      const generated = snapshotToRuntimeData(await readGeneratedRecSnapshot());
      setCache(generated, {
        snapshotFileSignature: await readSnapshotFileSignature(),
      });
      return generated;
    } catch (error) {
      if (REC_SNAPSHOT_STRICT) {
        throw error;
      }
    }
  }

  const data = snapshotToRuntimeData(
    await fetchRecSnapshotFromAppwrite({ signal })
  );

  setCache(data);
  return data;
}

function buildConferenceDocuments(conference) {
  const days = parseJson(conference.days, []);
  const maxLimits = parseJson(conference.maxLimits, {});
  const registrationFee = parseJson(conference.registrationFee, {});
  const contact = compact([conference.contactEmail, conference.contactPhone]).join(", ");

  return [
    {
      sourceType: "conference_overview",
      title: conference.title,
      row: conference,
      text: compact([
        `Conference: ${conference.title}`,
        `Short name: ${conference.shortName}`,
        `Theme: ${conference.theme}`,
        `Description: ${conference.description}`,
        `Dates: ${formatConferenceDates(conference)}`,
        `Venue: ${formatConferenceVenue(conference)}`,
        `Registration: ${conference.registrationOpen ? "open" : "closed"}`,
        conference.regClosedMessage
          ? `Registration closed message: ${conference.regClosedMessage}`
          : null,
        conference.successMessage
          ? `Registration success message: ${conference.successMessage}`
          : null,
        `Maximum attendees: ${conference.maxAttendees}`,
        `Capacity limits: attendees ${maxLimits.attendee}, exhibitors ${maxLimits.exhibitor}, sponsors ${maxLimits.sponsor}`,
        `Registration fees: attendee ${registrationFee.attendee}, exhibitor ${registrationFee.exhibitor}, sponsor ${registrationFee.sponsor}`,
        contact ? `Contact: ${contact}` : null,
        conference.mainWebsiteUrl ? `Website: ${conference.mainWebsiteUrl}` : null,
        conference.heroTagline ? `Tagline: ${conference.heroTagline}` : null,
      ]).join("\n"),
    },
    ...days.map((day) => ({
      sourceType: "conference_day",
      title: `${conference.title} - ${day.label}`,
      row: conference,
      text: compact([
        `Conference day: ${day.label}`,
        `Date: ${day.date}`,
        `Theme: ${day.theme}`,
        `Conference: ${conference.title}`,
      ]).join("\n"),
    })),
  ];
}

function buildProgramDocuments(programs) {
  return programs.map((program) => ({
    sourceType: "program_overview",
    title: program.title,
    row: program,
    text: compact([
      `Program: ${program.title}`,
      `Description: ${program.description}`,
      `Days count: ${program.daysCount}`,
      `Venue halls: ${program.venueHalls?.join(", ")}`,
      `Status: ${program.status}`,
    ]).join("\n"),
  }));
}

function buildTimeBlockDocuments(timeBlocks) {
  return timeBlocks.map((block) => ({
    sourceType: "program_time_block",
    title: block.label,
    row: block,
    text: compact([
      `Program time block: ${block.label}`,
      `Day: ${block.day}`,
      `Date: ${block.date}`,
      `Time: ${formatTime(block.startTime)} to ${formatTime(block.endTime)}`,
      `Type: ${block.type}`,
      `Venue halls: ${block.venueHalls?.join(", ")}`,
      block.notes ? `Notes: ${block.notes}` : null,
    ]).join("\n"),
  }));
}

function buildSessionDocuments(sessions) {
  return sessions.map((session) => ({
    sourceType: "session",
    title: session.title,
    row: session,
    text: compact([
      `Session: ${session.title}`,
      `Theme: ${session.theme}`,
      `Day: ${session.day}`,
      `Time: ${formatTime(session.startTime)} to ${formatTime(session.toTime)}`,
      `Venue: ${session.venueHall}`,
      session.organizer
        ? `Organizer: ${stripHtml(session.organizer)}`
        : null,
      session.speakers ? `Speakers: ${normalizeSpeakerText(session.speakers)}` : null,
      session.preamble ? `Details: ${stripHtml(session.preamble)}` : null,
      session.status ? `Status: ${session.status}` : null,
    ]).join("\n"),
  }));
}

function buildSponsorDocuments(sponsorCategories, sponsors) {
  const categoriesById = new Map(
    sponsorCategories.map((category) => [category.$id, category])
  );

  return [
    ...sponsorCategories.map((category) => ({
      sourceType: "sponsor_category",
      title: category.name,
      row: category,
      text: compact([
        `Sponsor category: ${category.name}`,
        category.description ? `Description: ${stripHtml(category.description)}` : null,
        `Active: ${category.isActive ? "yes" : "no"}`,
      ]).join("\n"),
    })),
    ...sponsors.map((sponsor) => {
      const category = categoriesById.get(sponsor.categoryId);

      return {
        sourceType: "sponsor",
        title: sponsor.name,
        row: sponsor,
        text: compact([
          `Sponsor: ${sponsor.name}`,
          category ? `Category: ${category.name}` : null,
          sponsor.description ? `Description: ${stripHtml(sponsor.description)}` : null,
          sponsor.siteUrl ? `Website: ${sponsor.siteUrl}` : null,
          `Active: ${sponsor.isActive ? "yes" : "no"}`,
        ]).join("\n"),
      };
    }),
  ];
}

function buildOperationalInfoDocuments(items) {
  return items.map((item) => ({
    sourceType: "operational_info",
    title: item.title,
    row: item,
    text: compact([
      `Published visitor information: ${item.title}`,
      `Category: ${item.category}`,
      `Answer: ${item.answer}`,
      item.keywords?.length ? `Keywords: ${item.keywords.join(", ")}` : null,
    ]).join("\n"),
  }));
}

function buildMediaDocuments(mediaItems) {
  return mediaItems.map((item) => {
    const sampleImages = parseJson(item.sampleImagesJson, []);

    return {
      sourceType: "conference_media",
      title: item.title,
      row: item,
      text: compact([
        `Published conference media: ${item.title}`,
        `Type: ${item.mediaType}`,
        item.description ? `Description: ${stripHtml(item.description)}` : null,
        item.externalUrl ? `Album or external link: ${item.externalUrl}` : null,
        item.videoUrl ? `Video link: ${item.videoUrl}` : null,
        item.thumbnailUrl ? `Thumbnail: ${item.thumbnailUrl}` : null,
        sampleImages.length
          ? `Sample image links: ${sampleImages
              .map((image) => image.url)
              .filter(Boolean)
              .join(", ")}`
          : null,
      ]).join("\n"),
    };
  });
}

function buildReportDocuments(reports) {
  return reports.map((report) => ({
    sourceType: "conference_report",
    title: report.title,
    row: report,
    text: compact([
      `Published conference report: ${report.title}`,
      report.reportType ? `Type: ${report.reportType}` : null,
      report.summary ? `Summary: ${stripHtml(report.summary)}` : null,
      report.reportUrl ? `Report link: ${report.reportUrl}` : null,
      report.coverImageUrl ? `Cover image: ${report.coverImageUrl}` : null,
      report.publicationDate
        ? `Publication date: ${formatDate(report.publicationDate)}`
        : null,
      `Featured: ${report.isFeatured ? "yes" : "no"}`,
    ]).join("\n"),
  }));
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

function buildConferenceBundleDocuments(bundle) {
  return [
    ...buildConferenceDocuments(bundle.conference),
    ...buildProgramDocuments(bundle.programs || []),
    ...buildTimeBlockDocuments(bundle.timeBlocks || []),
    ...buildSessionDocuments(bundle.sessions || []),
    ...buildSponsorDocuments(
      bundle.sponsorCategories || [],
      bundle.sponsors || []
    ),
    ...buildOperationalInfoDocuments(bundle.operationalInfo || []),
    ...buildMediaDocuments(bundle.mediaItems || []),
    ...buildReportDocuments(bundle.reports || []),
  ];
}

export function buildRecDocuments(snapshot) {
  const runtime = snapshotToRuntimeData(snapshot);

  return getConferenceBundles(runtime).flatMap((bundle) =>
    buildConferenceBundleDocuments(bundle).map((document, index) => ({
      id: `${bundle.conference.$id}:${document.sourceType}:${
        document.row?.$id || index
      }:${index}`,
      text: document.text,
      payload: {
        source: document.title || document.sourceType,
        sourceType: document.sourceType,
        databaseId: HR_DATABASE_ID,
        tableId: document.row?.$tableId,
        rowId: document.row?.$id,
        conferenceId: bundle.conference.$id,
        isActiveConference: bundle.conference.isActive === true,
        year: bundle.conference.year,
        title: document.title,
        text: document.text,
        updatedAt: document.row?.updatedAt || document.row?.$updatedAt,
      },
    }))
  );
}

function getRepresentedSponsorGroups(
  bundle,
  { partnersOnly = false, featuredOnly = false } = {}
) {
  const categories = [...(bundle.sponsorCategories || [])]
    .filter((category) => category.isActive !== false)
    .sort(
      (left, right) =>
        (left.displayOrder || 0) - (right.displayOrder || 0) ||
        String(left.name || "").localeCompare(String(right.name || ""))
    );
  const categoriesById = new Map(
    categories.map((category) => [category.$id, category])
  );
  const groups = new Map();

  for (const sponsor of [...(bundle.sponsors || [])]
    .filter((item) => item.isActive !== false)
    .filter((item) => !featuredOnly || item.isFeatured === true)
    .sort(
      (left, right) =>
        (left.displayOrder || 0) - (right.displayOrder || 0) ||
        String(left.name || "").localeCompare(String(right.name || ""))
    )) {
    const category = categoriesById.get(sponsor.categoryId) || {
      $id: "uncategorized",
      name: "Other",
      description: "",
      displayOrder: Number.MAX_SAFE_INTEGER,
    };

    if (
      partnersOnly &&
      canonicalSearchText(category.name) !== "partners"
    ) {
      continue;
    }

    const key = category.$id || category.name;
    const group = groups.get(key) || { category, sponsors: [] };
    group.sponsors.push(sponsor);
    groups.set(key, group);
  }

  return [...groups.values()].sort(
    (left, right) =>
      (left.category.displayOrder || 0) -
        (right.category.displayOrder || 0) ||
      String(left.category.name || "").localeCompare(
        String(right.category.name || "")
      )
  );
}

function formatSponsorGroups(
  groups,
  { includeDescriptions = true, includeCategoryHeadings = true } = {}
) {
  return groups
    .map(({ category, sponsors }) => {
      const sponsorItems = sponsors.map((sponsor) => {
        const name = sponsor.siteUrl
          ? `[${sponsor.name}](${sponsor.siteUrl})`
          : `**${sponsor.name}**`;
        const description = includeDescriptions
          ? stripHtml(sponsor.description)
          : "";

        return description ? `${name}: ${description}` : name;
      });

      return joinMarkdownSections([
        includeCategoryHeadings ? `### ${category.name || "Other"}` : null,
        category.description ? stripHtml(category.description) : null,
        markdownList(sponsorItems),
      ]);
    })
    .join("\n\n");
}

function answerSponsors(snapshot) {
  const groups = getRepresentedSponsorGroups(snapshot);
  const sponsorCount = groups.reduce(
    (total, group) => total + group.sponsors.length,
    0
  );

  if (sponsorCount === 0) {
    return "No active sponsors are currently listed for the conference.";
  }

  const conferenceName =
    snapshot.conference.shortName || snapshot.conference.title || "REC & EXPO";

  return joinMarkdownSections([
    `## ${conferenceName} Sponsors and Partners`,
    `${sponsorCount} published organisation${sponsorCount === 1 ? " is" : "s are"} currently listed across ${groups.length} represented categor${groups.length === 1 ? "y" : "ies"}.`,
    formatSponsorGroups(groups),
  ]);
}

function findMentionedSponsor(normalized, sponsors) {
  return sponsors.find((sponsor) => {
    const name = normalizeQuestion(sponsor.name || "");
    if (!name) return false;

    const compactName = name.replace(/\b(uganda|limited|ltd|inc|plc)\b/g, "").trim();
    const firstToken = compactName.split(" ")[0];

    return (
      normalized.includes(name) ||
      (compactName.length >= 3 && normalized.includes(compactName)) ||
      (firstToken.length >= 3 && new RegExp(`\\b${firstToken}\\b`).test(normalized))
    );
  });
}

function answerSpecificSponsor(sponsor, snapshot) {
  const category = snapshot.sponsorCategories.find(
    (item) => item.$id === sponsor.categoryId
  );
  const conferenceName =
    snapshot.conference.shortName || snapshot.conference.title;
  const details = [`## ${sponsor.name}`];

  if (category?.name) {
    details.push(`**Category:** ${category.name}`);
  }

  details.push(`**Conference:** ${conferenceName}`);

  if (sponsor.description) {
    details.push(stripHtml(sponsor.description));
  }

  if (sponsor.siteUrl) {
    details.push(`[Visit ${sponsor.name} website](${sponsor.siteUrl})`);
  }

  return joinMarkdownSections(details);
}

function findMentionedSession(normalized, sessions) {
  return sessions.find((session) => {
    const title = normalizeQuestion(session.title || "");
    if (!title) return false;

    const titleTokens = title
      .split(" ")
      .filter((token) => token.length > 2 && !["the", "and", "for", "tbc"].includes(token));
    const matchedTokens = titleTokens.filter((token) =>
      new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        normalized
      )
    );

    return normalized.includes(title) || matchedTokens.length >= 2;
  });
}

function truncateText(text, maxLength = 900) {
  if (!text || text.length <= maxLength) return text;

  return `${text.slice(0, maxLength).trim()}...`;
}

function answerSpecificSession(session, normalized) {
  if (/(which hall|what hall|where|venue|room)/.test(normalized)) {
    return joinMarkdownSections([
      `${session.title} is scheduled in ${session.venueHall}.`,
      markdownDetails([
        ["Day", session.day],
        [
          "Time",
          session.startTime && session.toTime
            ? `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`
            : null,
        ],
      ]),
    ]);
  }

  return joinMarkdownSections([
    `${session.title} is scheduled for Day ${session.day}.`,
    markdownDetails([
      [
        "Time",
        session.startTime && session.toTime
          ? `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`
          : null,
      ],
      ["Venue", session.venueHall],
      ["Theme", session.theme],
    ]),
    session.preamble ? truncateText(stripHtml(session.preamble)) : null,
  ]);
}

const DAY_WORDS = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
};

const DAY_TOKEN_PATTERN =
  "\\d+|one|first|two|second|three|third|four|fourth";

function parseDayToken(value) {
  const token = String(value || "").trim().toLowerCase();
  const numeric = Number.parseInt(token, 10);
  const day = Number.isFinite(numeric) ? numeric : DAY_WORDS[token];

  return Number.isFinite(day) && day > 0 ? day : null;
}

function addUniqueDay(days, day) {
  if (!day || days.includes(day)) return;
  days.push(day);
}

function extractRequestedDays(normalized) {
  const days = [];
  const rangePattern = new RegExp(
    `\\b(?:from\\s+)?days?\\s*(${DAY_TOKEN_PATTERN})\\s*(?:to|through|until|-|–|—)\\s*(?:days?\\s*)?(${DAY_TOKEN_PATTERN})\\b`,
    "g"
  );
  const listPattern = new RegExp(
    `\\bdays?\\s+((?:${DAY_TOKEN_PATTERN})(?:\\s*(?:,\\s*(?:and\\s+)?|and\\s+|&\\s*)(?:${DAY_TOKEN_PATTERN}))*)`,
    "g"
  );
  const repeatedDayPattern = new RegExp(
    `\\bday\\s*(${DAY_TOKEN_PATTERN})\\b`,
    "g"
  );
  const tokenPattern = new RegExp(DAY_TOKEN_PATTERN, "g");
  let match;

  while ((match = rangePattern.exec(normalized)) !== null) {
    const start = parseDayToken(match[1]);
    const end = parseDayToken(match[2]);
    if (!start || !end) continue;

    const min = Math.min(start, end);
    const max = Math.max(start, end);
    for (let day = min; day <= max; day += 1) {
      addUniqueDay(days, day);
    }
  }

  while ((match = listPattern.exec(normalized)) !== null) {
    const tokens = match[1].match(tokenPattern) || [];
    for (const token of tokens) {
      addUniqueDay(days, parseDayToken(token));
    }
  }

  while ((match = repeatedDayPattern.exec(normalized)) !== null) {
    addUniqueDay(days, parseDayToken(match[1]));
  }

  return days.sort((a, b) => a - b);
}

function extractRequestedDay(normalized) {
  return extractRequestedDays(normalized)[0] || null;
}

function getRequestedDayPart(normalized) {
  if (/\blate morning\b/.test(normalized)) {
    return { label: "late morning", startMinutes: 660, endMinutes: 780 };
  }

  if (/\bmorning\b/.test(normalized)) {
    return { label: "morning", startMinutes: 0, endMinutes: 780 };
  }

  if (/\bafternoon\b/.test(normalized)) {
    return { label: "afternoon", startMinutes: 780, endMinutes: Infinity };
  }

  if (/\bevening\b/.test(normalized)) {
    return { label: "evening", startMinutes: 1020, endMinutes: Infinity };
  }

  return null;
}

function overlapsDayPart(startMinutes, endMinutes, dayPart) {
  if (!dayPart) return true;
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
    return false;
  }

  return endMinutes > dayPart.startMinutes && startMinutes < dayPart.endMinutes;
}

function blockOverlapsDayPart(block, dayPart) {
  return overlapsDayPart(
    block.startMinutes ?? getKampalaMinutes(block.startTime),
    block.endMinutes ?? getKampalaMinutes(block.endTime),
    dayPart
  );
}

function sessionOverlapsDayPart(session, dayPart) {
  return overlapsDayPart(
    getKampalaMinutes(session.startTime),
    getKampalaMinutes(session.toTime),
    dayPart
  );
}

function answerDaySchedule(day, snapshot, options = {}) {
  const dayPart = options.dayPart || null;
  const days = parseJson(snapshot.conference.days, []);
  const dayInfo = days[day - 1];
  const sessions = snapshot.sessions
    .filter((session) => session.day === day)
    .filter((session) => sessionOverlapsDayPart(session, dayPart))
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const timeBlocks = snapshot.timeBlocks
    .filter((block) => block.day === day)
    .filter((block) => blockOverlapsDayPart(block, dayPart))
    .sort((a, b) => (a.startMinutes || 0) - (b.startMinutes || 0));

  if (!dayInfo && sessions.length === 0 && timeBlocks.length === 0) {
    return `I could not find schedule information for Day ${day}${dayPart ? ` in the ${dayPart.label}` : ""} in the conference materials.`;
  }

  const sessionSummary = sessions
    .slice(0, 8)
    .map((session) =>
      compact([
        session.startTime && session.toTime
          ? `${formatTime(session.startTime)}-${formatTime(session.toTime)}`
          : formatTime(session.startTime),
        session.title,
        session.venueHall ? `at ${session.venueHall}` : null,
      ]).join(" ")
    );
  const blockSummary = timeBlocks
    .slice(0, dayPart ? 12 : 5)
    .map((block) =>
      compact([
        `${formatTime(block.startTime)}-${formatTime(block.endTime)}`,
        block.label,
        block.type ? `(${block.type})` : null,
      ]).join(" ")
    );

  return joinMarkdownSections([
    `Day ${day}${dayInfo?.date ? ` (${dayInfo.date})` : ""}${dayPart ? ` ${dayPart.label}` : ""}${dayInfo?.theme ? ` focuses on ${dayInfo.theme}` : ""}.`,
    blockSummary.length
      ? `**Main blocks**\n${markdownList(blockSummary)}`
      : null,
    sessionSummary.length
      ? `**Sessions include**\n${markdownList(sessionSummary)}`
      : null,
  ]);
}

function getConferenceDays(conference) {
  return parseJson(conference.days, []);
}

function getDayInfo(snapshot, dayNumber) {
  const days = getConferenceDays(snapshot.conference);
  return days.find((day, index) => getDayNumberFromDay(day, index) === dayNumber);
}

function answerDayDate(snapshot, dayNumber) {
  const day = getDayInfo(snapshot, dayNumber);

  if (!day) {
    return `I could not find date information for Day ${dayNumber} in the published conference materials.`;
  }

  return `Day ${dayNumber} of ${snapshot.conference.shortName || snapshot.conference.title} is ${day.date}${day.theme ? `, with the focus area "${day.theme}"` : ""}.`;
}

function cleanSpeakerText(value) {
  return normalizeSpeakerText(value)
    .replace(/\b(details?\s+forthcoming|to be confirmed)\b/gi, (match) =>
      match.toLowerCase()
    )
    .trim();
}

function hasNamedSpeaker(value) {
  const text = normalizeQuestion(value);

  return Boolean(text) && !/^(tbc|details? forthcoming|to be confirmed|none|n\/a)$/.test(text);
}

function answerSpeakersOverview(snapshot, requestedDays) {
  const selectedDays = normalizeRequestedDays(requestedDays);
  const sessions = getSessionsForDays(snapshot, selectedDays)
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return selectedDays.length > 0
      ? `I could not find sessions for ${formatRequestedDays(selectedDays)}, so I could not check speaker details.`
      : "I could not find sessions in the published programme, so I could not check speaker details.";
  }

  const rows = sessions.map((session) => {
    const speakers = cleanSpeakerText(session.speakers);
    return `${session.title} (Day ${session.day}, ${session.venueHall}): ${speakers || "not listed"}`;
  });
  const namedSpeakers = sessions
    .map((session) => cleanSpeakerText(session.speakers))
    .filter(hasNamedSpeaker);
  const scope = selectedDays.length > 0
    ? formatRequestedDays(selectedDays)
    : "the published programme";
  const introduction = namedSpeakers.length > 0
    ? `Published speaker details for ${scope}:`
    : `Published speaker names for ${scope} are not yet available. The current speaker fields are:`;

  return joinMarkdownSections([introduction, markdownList(rows)]);
}

function answerDaysCount(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayCount = days.length;

  if (dayCount === 0) {
    return `${snapshot.conference.title} runs from ${formatConferenceDates(snapshot.conference)}.`;
  }

  const focusAreas = days
    .map((day, index) => {
      const dayNumber =
        day.label.match(/Day\s+(\d+)/i)?.[1] || String(index + 1);
      return `Day ${dayNumber}: ${day.theme}`;
    });

  return joinMarkdownSections([
    `${snapshot.conference.title} runs for **${dayCount} days**, from **${formatConferenceDates(snapshot.conference)}**.`,
    `**Daily focus areas**\n${markdownList(focusAreas)}`,
  ]);
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function getSessionThemeHighlights(sessions) {
  return uniqueValues(
    sessions
      .map((session) => session.theme)
      .filter((theme) => theme && !/^tbc$/i.test(theme))
  ).slice(0, 8);
}

function answerLearningOutcomes(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const sessionsByDay = new Map();

  for (const session of snapshot.sessions) {
    const daySessions = sessionsByDay.get(session.day) || [];
    daySessions.push(session);
    sessionsByDay.set(session.day, daySessions);
  }

  const daySummaries = days
    .map((day, index) => {
      const dayNumber =
        Number(day.label.match(/Day\s+(\d+)/i)?.[1]) || index + 1;
      const sessionFocus = uniqueValues(
        (sessionsByDay.get(dayNumber) || [])
          .map((session) => {
            if (session.theme && !/^tbc$/i.test(session.theme)) {
              return session.theme;
            }

            return (session.title || "")
              .replace(/^tbc\s*-\s*/i, "")
              .replace(/\s*-\s*tbc$/i, "")
              .replace(/^\((.*)\)$/, "$1")
              .trim();
          })
          .filter(Boolean)
      ).slice(0, 3);

      return compact([
        `Day ${dayNumber}: ${day.theme}`,
        sessionFocus.length ? `sessions cover ${sessionFocus.join(", ")}` : null,
      ]).join(" - ");
    })
    .filter(Boolean);

  if (daySummaries.length === 0) {
    return "I could not find detailed learning themes in the conference materials.";
  }

  return joinMarkdownSections([
    `Across the four days of ${snapshot.conference.shortName || snapshot.conference.title}, you can expect a progression from policy and investment into technology, implementation, and regional scale-up.`,
    `**What each day builds toward**\n${markdownList(daySummaries)}`,
    "In practical terms, the programme should help you understand renewable-energy policy, investment pathways, technology options, delivery models, sustainability issues, and how projects can scale in Uganda and the region.",
  ]);
}

function isProgrammeProgressionQuestion(normalized) {
  return (
    /\bhow\b.*\b(sessions?|themes?|days?|programme|program|agenda)\b.*\b(connect|relate|build|progress|fit together)\b/.test(
      normalized
    ) ||
    /\b(progress|progression|journey)\b.*\b(across|through|from)\b.*\b(days?|programme|program|agenda)\b/.test(
      normalized
    )
  );
}

function getDayProgressionRole(theme) {
  const normalizedTheme = normalizeQuestion(theme);

  if (/policy|investment|finance/.test(normalizedTheme)) {
    return "sets the policy, finance and institutional foundation";
  }
  if (/technology|innovation/.test(normalizedTheme)) {
    return "moves into technologies, skills, market models and innovation";
  }
  if (/implementation|sustainability/.test(normalizedTheme)) {
    return "shifts from ideas into delivery, adoption and sustainable operation";
  }
  if (/impact|scale|regional|leadership/.test(normalizedTheme)) {
    return "focuses on evidence, scale-up and leadership beyond individual projects";
  }

  return `develops the programme's ${theme || "published focus"}`;
}

function getProgressionSessionHighlights(snapshot, dayNumber) {
  return uniqueValues(
    snapshot.sessions
      .filter((session) => session.day === dayNumber)
      .sort(
        (a, b) =>
          Number(/\btbc\b/i.test(a.title || "")) -
            Number(/\btbc\b/i.test(b.title || "")) ||
          new Date(a.startTime) - new Date(b.startTime)
      )
      .map((session) => stripHtml(session.title))
      .filter(Boolean)
  ).slice(0, 3);
}

function answerProgrammeProgression(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayRows = days.map((day, index) => {
    const dayNumber = getDayNumberFromDay(day, index);
    const highlights = getProgressionSessionHighlights(snapshot, dayNumber);
    const examples = highlights.length > 0
      ? ` Published examples include ${highlights.join("; ")}.`
      : "";

    return `**Day ${dayNumber} - ${day.theme}:** ${getDayProgressionRole(
      day.theme
    )}.${examples}`;
  });

  return joinMarkdownSections([
    `The published ${snapshot.conference.shortName || snapshot.conference.title} programme forms a four-stage progression rather than four disconnected agendas:`,
    markdownList(dayRows),
    "Taken together, the sequence moves from the enabling environment, through technologies and delivery, to impact and scale. This is a thematic interpretation of the published daily focus areas and session titles; parallel sessions are not necessarily direct continuations of one another.",
  ]);
}

function isProgrammeTradeOffQuestion(normalized) {
  return /\b(trade[- ]?offs?|strategic tensions?|competing priorities|balance between)\b/.test(
    normalized
  );
}

function getSessionEvidence(snapshot, pattern, limit = 2) {
  return snapshot.sessions
    .filter((session) =>
      pattern.test(
        normalizeQuestion(
          compact([
            session.title,
            session.theme,
            stripHtml(session.preamble),
          ]).join(" ")
        )
      )
    )
    .slice(0, limit);
}

function formatSessionEvidence(sessions) {
  return sessions.map((session) => `**${stripHtml(session.title)}**`).join(" and ");
}

function getProgrammeTradeOffEvidence(snapshot) {
  const seen = new Set();

  return [
    ...getSessionEvidence(snapshot, /financ|investment|tax|deal room/, 3),
    ...getSessionEvidence(snapshot, /refugee|farmer|grassroots|student|universal access/, 3),
    ...getSessionEvidence(snapshot, /e-mobility|wind|solar|biofuel|clean cooking/, 3),
    ...getSessionEvidence(snapshot, /skills gap|performance review|technical working group/, 3),
  ].filter((session) => {
    const key = session.$id || session.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function answerProgrammeTradeOffs(snapshot) {
  const finance = getSessionEvidence(snapshot, /financ|investment|tax|deal room/, 2);
  const inclusion = getSessionEvidence(
    snapshot,
    /refugee|farmer|grassroots|student|universal access/,
    2
  );
  const technologies = getSessionEvidence(
    snapshot,
    /e-mobility|wind|solar|biofuel|clean cooking/,
    2
  );
  const delivery = getSessionEvidence(
    snapshot,
    /skills gap|performance review|technical working group|implementation/,
    2
  );
  const halls = uniqueValues(
    snapshot.sessions.map((session) => session.venueHall).filter(Boolean)
  );

  return joinMarkdownSections([
    "The programme does not publish an official list of strategic trade-offs. Based on its daily themes and session titles, these are reasonable planning interpretations:",
    markdownList([
      `**Breadth versus depth:** ${snapshot.sessions.length} sessions across ${halls.length} listed spaces create broad coverage, but several run in parallel, so attendees must prioritize rather than follow every topic.`,
      `**Investment momentum versus inclusive access:** ${formatSessionEvidence(
        finance
      ) || "the finance-focused sessions"} emphasize capital and investment conditions, while ${formatSessionEvidence(
        inclusion
      ) || "the inclusion-focused sessions"} keep access, communities and end users in view.`,
      `**Technology ambition versus delivery capacity:** ${formatSessionEvidence(
        technologies
      ) || "the technology sessions"} explore solution pathways, while ${formatSessionEvidence(
        delivery
      ) || "the delivery-focused sessions"} point to skills, institutions and implementation capacity needed to sustain them.`,
      "**Immediate deals versus long-term system change:** deal rooms, business forums and taxation discussions can support near-term transactions, while the four-day progression also reserves space for policy, programme performance, sustainability, local voices and regional scale.",
    ]),
    "These are inferences from the published programme, not positions formally stated by the organizers.",
  ]);
}

function answerConferenceOverview(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayThemes = days
    .map((day, index) => {
      const dayNumber =
        day.label.match(/Day\s+(\d+)/i)?.[1] || String(index + 1);
      return `Day ${dayNumber}: ${day.theme}`;
    });

  return joinMarkdownSections([
    `${snapshot.conference.title} (${snapshot.conference.shortName}) is Uganda's premier renewable energy conference for ${snapshot.conference.year}.`,
    markdownDetails([
      ["Dates", formatConferenceDates(snapshot.conference)],
      ["Venue", formatConferenceVenue(snapshot.conference)],
      ["Theme", `"${snapshot.conference.theme}"`],
    ]),
    dayThemes.length ? `**Daily focus areas**\n${markdownList(dayThemes)}` : null,
    `The active programme currently lists ${snapshot.sessions.length} sessions and ${snapshot.timeBlocks.length} time blocks, including conference sessions, exhibitions, tea breaks, and lunch breaks.`,
    snapshot.conference.mainWebsiteUrl
      ? `**Website:** ${snapshot.conference.mainWebsiteUrl}`
      : null,
  ]);
}

function answerConferenceDeepDive(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayThemes = days
    .map((day, index) => {
      const dayNumber = getDayNumberFromDay(day, index);
      return `Day ${dayNumber} (${day.date}): ${day.theme}`;
    });
  const halls = getVenueHalls(snapshot).slice(0, 8);
  const technologyAreas = getTechnologyDiscussionAreas(snapshot)
    .map((area) => area.label)
    .slice(0, 10);
  const sponsors = getActiveSponsors(snapshot)
    .slice(0, 6)
    .map((sponsor) => sponsor.name);
  const registrationStatus = snapshot.conference.registrationOpen
    ? "Registration is currently open."
    : snapshot.conference.regClosedMessage || "Registration is currently closed.";

  return joinMarkdownSections([
    `${snapshot.conference.title} (${snapshot.conference.shortName}) is the active REC conference for ${snapshot.conference.year}.`,
    markdownDetails([
      ["Dates", formatConferenceDates(snapshot.conference)],
      ["Venue", formatConferenceVenue(snapshot.conference)],
      ["Theme", `"${snapshot.conference.theme}"`],
    ]),
    dayThemes.length ? `**Daily focus areas**\n${markdownList(dayThemes)}` : null,
    `The published programme currently has ${snapshot.sessions.length} listed sessions and ${snapshot.timeBlocks.length} time blocks, including sessions, exhibitions, breaks, lunch, and ceremonies.`,
    halls.length ? `**Main spaces**\n${markdownList(halls)}` : null,
    technologyAreas.length
      ? `**Technology and sector areas in the programme**\n${markdownList(technologyAreas)}`
      : null,
    sponsors.length
      ? `**Listed sponsors and partners include**\n${markdownList(sponsors)}`
      : null,
    withTerminalPeriod(registrationStatus),
    snapshot.conference.mainWebsiteUrl
      ? `**Website:** ${snapshot.conference.mainWebsiteUrl}`
      : null,
  ]);
}

function answerConferenceDatesAndVenue(snapshot) {
  return `${snapshot.conference.title} will run from **${formatConferenceDates(snapshot.conference)}** at **${formatConferenceVenue(snapshot.conference)}**.`;
}

function findFirstScheduledBlock(snapshot) {
  return [...snapshot.timeBlocks].sort(
    (a, b) => new Date(a.startTime) - new Date(b.startTime)
  )[0];
}

function findFirstSession(snapshot) {
  return [...snapshot.sessions].sort(
    (a, b) => new Date(a.startTime) - new Date(b.startTime)
  )[0];
}

function answerConferenceStart(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const firstDay = days[0];
  const firstBlock = findFirstScheduledBlock(snapshot);
  const firstSession = findFirstSession(snapshot);

  return joinMarkdownSections([
    `${snapshot.conference.title} starts on Day 1${firstDay?.date ? ` (${firstDay.date})` : ""}.`,
    firstBlock
      ? markdownDetails([
          ["Earliest listed block", firstBlock.label],
          [
            "Time",
            `${formatTime(firstBlock.startTime)} to ${formatTime(
              firstBlock.endTime
            )} Kampala time`,
          ],
          [
            "Venue",
            firstBlock.venueHalls?.length
              ? firstBlock.venueHalls.join(", ")
              : null,
          ],
        ])
      : null,
    firstSession
      ? `The first listed sessions begin at ${formatTime(firstSession.startTime)} Kampala time.`
      : null,
  ]);
}

function answerDailyThemes(snapshot) {
  const days = getConferenceDays(snapshot.conference);

  if (days.length === 0) {
    return "I could not find daily themes in the conference materials.";
  }

  const dailyThemes = days
    .map((day, index) => {
      const dayNumber =
        day.label.match(/Day\s+(\d+)/i)?.[1] || String(index + 1);
      return `Day ${dayNumber} (${day.date}): ${day.theme}`;
    });

  return joinMarkdownSections([
    "The daily themes are:",
    markdownList(dailyThemes),
  ]);
}

function answerProgramOverview(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const program = snapshot.programs[0];
  const sessionThemes = getSessionThemeHighlights(snapshot.sessions);
  const halls = uniqueValues([
    ...(program?.venueHalls || []),
    ...snapshot.sessions.map((session) => session.venueHall),
  ]).slice(0, 10);
  const daySummary = days
    .map((day, index) => {
      const dayNumber =
        day.label.match(/Day\s+(\d+)/i)?.[1] || String(index + 1);
      return `Day ${dayNumber}: ${day.theme}`;
    });

  return joinMarkdownSections([
    `${snapshot.conference.shortName || snapshot.conference.title} is a ${days.length || program?.daysCount || ""}-day programme at ${formatConferenceVenue(snapshot.conference)}.`,
    `**Conference theme:** ${snapshot.conference.theme}`,
    daySummary.length ? `**Daily focus**\n${markdownList(daySummary)}` : null,
    `The published data currently lists ${snapshot.sessions.length} programme sessions and ${snapshot.timeBlocks.length} time blocks.`,
    sessionThemes.length
      ? `**Session themes include**\n${markdownList(sessionThemes)}`
      : null,
    halls.length ? `**Venue halls include**\n${markdownList(halls)}` : null,
  ]);
}

function isAllSessionsListQuestion(normalized) {
  return (
    /\bsessions?\b/.test(normalized) &&
    /\b(all|every|complete|full|list|show|give|get)\b/.test(normalized) &&
    !/(recommend|attend|relevant|related|connected|mention|mentions|about|finance|financial|investment|policy|government|developer|technology|technologies|cooking|biofuel|geothermal|nuclear|productive use|efficiency)/.test(
      normalized
    )
  );
}

function normalizeRequestedDays(value) {
  const days = Array.isArray(value)
    ? value
    : Number.isFinite(Number(value))
      ? [Number(value)]
      : [];

  return [...new Set(days.filter((day) => Number.isFinite(day) && day > 0))].sort(
    (a, b) => a - b
  );
}

function formatRequestedDays(days) {
  if (days.length === 0) return "";
  if (days.length === 1) return `Day ${days[0]}`;

  const isConsecutive = days.every(
    (day, index) => index === 0 || day === days[index - 1] + 1
  );

  if (isConsecutive) {
    return `Days ${days[0]}-${days[days.length - 1]}`;
  }

  return `Days ${days.slice(0, -1).join(", ")} and ${days.at(-1)}`;
}

function getSessionsForDays(snapshot, days) {
  return snapshot.sessions.filter(
    (session) => days.length === 0 || days.includes(session.day)
  );
}

function answerSessionsOverview(snapshot, requestedDays, options = {}) {
  const selectedDays = normalizeRequestedDays(requestedDays);
  const sessions = snapshot.sessions
    .filter((session) => selectedDays.length === 0 || selectedDays.includes(session.day))
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return selectedDays.length > 0
      ? `I could not find sessions listed for ${formatRequestedDays(selectedDays)}.`
      : "I could not find listed sessions in the conference materials.";
  }

  const byDay = new Map();
  for (const session of sessions) {
    const daySessions = byDay.get(session.day) || [];
    daySessions.push(session);
    byDay.set(session.day, daySessions);
  }

  const daySummaries = [...byDay.entries()]
    .map(([day, daySessions]) => {
      const visibleSessions = options.includeAll || selectedDays.length > 0
        ? daySessions
        : daySessions.slice(0, 4);
      const titles = visibleSessions.map((session) =>
          compact([
            session.title,
            session.venueHall ? `(${session.venueHall})` : null,
          ]).join(" ")
        );
      const remaining =
        !options.includeAll && daySessions.length > visibleSessions.length
          ? `Plus ${daySessions.length - visibleSessions.length} more listed session${daySessions.length - visibleSessions.length === 1 ? "" : "s"}.`
          : "";

      return joinMarkdownSections([
        `**Day ${day}**`,
        markdownList(titles),
        remaining,
      ]);
    })
    .join("\n\n");

  const prefix = selectedDays.length > 0
    ? `Yes. I found ${sessions.length} listed session${sessions.length === 1 ? "" : "s"} for ${formatRequestedDays(selectedDays)}.`
    : `Yes. I found ${sessions.length} listed programme session${sessions.length === 1 ? "" : "s"} across the active conference.`;

  return joinMarkdownSections([prefix, daySummaries]);
}

function getVenueHalls(snapshot) {
  return uniqueValues([
    ...snapshot.programs.flatMap((program) => program.venueHalls || []),
    ...snapshot.timeBlocks.flatMap((block) => block.venueHalls || []),
    ...snapshot.sessions.map((session) => session.venueHall),
  ]);
}

function answerVenueHalls(snapshot) {
  const halls = getVenueHalls(snapshot);

  if (halls.length === 0) {
    return "I could not find specific hall details in the published conference materials.";
  }

  return joinMarkdownSections([
    "The listed conference spaces are:",
    markdownList(halls),
  ]);
}

function findRequestedHall(normalized, snapshot) {
  const halls = getVenueHalls(snapshot).sort((a, b) => b.length - a.length);

  return halls.find((hall) => {
    const hallText = normalizeQuestion(hall);
    const shortHall = hallText.replace(/\s*\(.*?\)\s*/g, "").trim();

    return (
      normalized.includes(hallText) ||
      (shortHall.length >= 4 && normalized.includes(shortHall))
    );
  });
}

function answerSessionsByHall(snapshot, hall) {
  const hallText = normalizeQuestion(hall);
  const shortHall = hallText.replace(/\s*\(.*?\)\s*/g, "").trim();
  const sessions = snapshot.sessions
    .filter((session) => {
      const venue = normalizeQuestion(session.venueHall || "");
      return venue.includes(hallText) || venue.includes(shortHall);
    })
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return `I could not find listed sessions in ${hall}.`;
  }

  const summary = sessions
    .map((session) =>
      compact([
        `Day ${session.day}`,
        `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`,
        session.title,
      ]).join(": ")
    );

  return joinMarkdownSections([
    `Sessions listed for **${hall}**:`,
    markdownList(summary),
  ]);
}

function getHallSessions(snapshot, hall) {
  const hallText = normalizeQuestion(hall);
  const shortHall = hallText.replace(/\s*\(.*?\)\s*/g, "").trim();

  return snapshot.sessions
    .filter((session) => {
      const venue = normalizeQuestion(session.venueHall || "");
      return venue.includes(hallText) || venue.includes(shortHall);
    })
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));
}

function getHallTimeBlocks(snapshot, hall) {
  const hallText = normalizeQuestion(hall);
  const shortHall = hallText.replace(/\s*\(.*?\)\s*/g, "").trim();

  return snapshot.timeBlocks
    .filter((block) => {
      const venues = normalizeQuestion((block.venueHalls || []).join(" "));
      return venues.includes(hallText) || venues.includes(shortHall);
    })
    .sort((a, b) => a.day - b.day || (a.startMinutes || 0) - (b.startMinutes || 0));
}

function answerScheduleByHall(snapshot, hall) {
  const sessions = getHallSessions(snapshot, hall);

  if (sessions.length > 0) {
    return answerSessionsByHall(snapshot, hall);
  }

  const blocks = getHallTimeBlocks(snapshot, hall);
  if (blocks.length === 0) {
    return `I could not find scheduled items for ${hall}.`;
  }

  const summary = blocks
    .slice(0, 12)
    .map((block) =>
      compact([
        `Day ${block.day}`,
        `${formatTime(block.startTime)} to ${formatTime(block.endTime)}`,
        block.label,
        block.type ? `(${block.type})` : null,
      ]).join(": ")
    );

  return joinMarkdownSections([
    `Scheduled items listed for **${hall}**:`,
    markdownList(summary),
  ]);
}

function getDayThemeMatch(normalized, snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const genericThemeTokens = new Set(["renewable", "energy"]);

  return days.find((day) => {
    const tokens = normalizeQuestion(day.theme || "")
      .split(/\W+/)
      .filter(
        (token) => token.length > 3 && !genericThemeTokens.has(token)
      );
    if (tokens.length === 0) return false;

    const matchedTokens = tokens.filter((token) =>
      new RegExp(`\\b${token}\\b`).test(normalized)
    );

    return matchedTokens.length >= Math.min(2, tokens.length);
  });
}

function getThemeSources(snapshot, day) {
  const days = getConferenceDays(snapshot.conference);
  const dayNumber = getDayNumberFromDay(day, days.indexOf(day));

  return snapshot.sessions
    .filter((session) => session.day === dayNumber)
    .slice(0, 8)
    .map((session) => sourceFor("session", session, session.title));
}

function getDayNumberFromDay(day, index) {
  return Number(day?.label?.match(/Day\s+(\d+)/i)?.[1]) || index + 1;
}

function answerSessionsForDayTheme(snapshot, day) {
  const days = getConferenceDays(snapshot.conference);
  const dayIndex = days.indexOf(day);
  const dayNumber = getDayNumberFromDay(day, dayIndex);
  const sessions = snapshot.sessions
    .filter((session) => session.day === dayNumber)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return `Day ${dayNumber} focuses on ${day.theme}, but I could not find listed sessions for that day.`;
  }

  const summary = sessions
    .map((session) =>
      compact([
        session.title,
        session.venueHall ? `at ${session.venueHall}` : null,
        session.startTime && session.toTime
          ? `(${formatTime(session.startTime)} to ${formatTime(session.toTime)})`
          : null,
      ]).join(" ")
    );

  return joinMarkdownSections([
    `That topic maps to **Day ${dayNumber}: ${day.theme}**.`,
    `**Listed sessions for that day**\n${markdownList(summary)}`,
  ]);
}

function getTopicTokens(normalized) {
  const stopwords = new Set([
    "what",
    "which",
    "show",
    "tell",
    "sessions",
    "session",
    "connected",
    "related",
    "relevant",
    "about",
    "mention",
    "mentions",
    "happening",
    "useful",
    "likely",
    "would",
    "should",
    "attend",
    "conference",
    "rec",
    "expo",
    "the",
    "and",
    "are",
    "for",
    "with",
    "under",
    "from",
    "into",
    "that",
    "this",
  ]);

  return normalized
    .split(/\W+/)
    .filter((token) => token.length > 3 && !stopwords.has(token));
}

function findSessionsByTopicQuestion(snapshot, normalized) {
  const tokens = getTopicTokens(normalized);
  if (tokens.length === 0) return [];

  return snapshot.sessions
    .map((session) => {
      const text = normalizeQuestion(
        `${session.title || ""} ${session.theme || ""} ${stripHtml(session.preamble || "")} ${session.organizer || ""}`
      );
      const score = tokens.filter((token) =>
        new RegExp(`\\b${token}\\b`).test(text)
      ).length;

      return { session, score };
    })
    .filter((item) => item.score >= Math.min(2, tokens.length))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.session.day - b.session.day ||
        new Date(a.session.startTime) - new Date(b.session.startTime)
    )
    .map((item) => item.session);
}

function answerSessionsByTopic(sessions) {
  if (sessions.length === 0) {
    return null;
  }

  const summary = sessions
    .map((session) =>
      compact([
        session.title,
        `Day ${session.day}`,
        session.venueHall,
        session.startTime && session.toTime
          ? `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`
          : null,
        session.theme ? `Theme: ${session.theme}` : null,
      ]).join(", ")
    );

  return joinMarkdownSections([
    "Matching published sessions:",
    markdownList(summary),
  ]);
}

function isFilteredSessionQuestion(normalized) {
  if (!/\bsessions?\b/.test(normalized)) return false;
  if (isGenericSessionsOverviewQuestion(normalized)) return false;

  return (
    /\bsessions?\b.*\b(about|related|connected|relevant|involving|mention|mentions|cover|covering|focused|focus|for|under|in|at)\b/.test(
      normalized
    ) ||
    /\b(about|related|connected|relevant|involving|mention|mentions|cover|covering|focused|focus|for|under|in|at)\b.*\bsessions?\b/.test(
      normalized
    )
  );
}

function isGenericSessionsOverviewQuestion(normalized) {
  return (
    /\b(tell me more|tell me about|describe|introduce|more|overview|summary|summarise|summarize|in depth|in-depth|detailed|details|view)\b.*\bsessions?\b/.test(
      normalized
    ) ||
    /\bsessions?\b.*\b(overview|summary|summarise|summarize|description|in depth|in-depth|detailed|details|view)\b/.test(
      normalized
    )
  );
}

function isConferenceDeepDiveQuestion(normalized) {
  return (
    /\b(in depth|in-depth|deep dive|detailed|comprehensive|full|complete)\b.*\b(view|overview|summary|description|look|about)?\b.*\b(conference|rec|expo)\b/.test(
      normalized
    ) ||
    /\b(conference|rec|expo)\b.*\b(in depth|in-depth|deep dive|detailed|comprehensive|full|complete)\b/.test(
      normalized
    )
  );
}

const FOCUSED_CONFERENCE_SUBJECT_PATTERN =
  /\b(dates?|when|start|starts|starting|end|ends|ending|themes?|daily focus|focus areas?|venues?|locations?|registration|websites?|contacts?|phone|email|capacity|fees?|cost|price|programmes?|programs?|agenda|schedules?|sessions?|speakers?|presenters?|panelists?|sponsors?|sponsorship|partners?|exhibitors?|halls?|rooms?|spaces?|ceremon(?:y|ies)|opening|closing|lunch|tea|breaks?|exhibitions?|photos?|images?|albums?|gallery|galleries|media|videos?|recordings?|reports?|documents?|publications?|proceedings|communiques?|wifi|internet|parking|transport|shuttle|accessibility|wheelchair|catering|meals?|attire|dress code|first aid|security|prepare|preparation|learn|learning|recommendations?|technologies?|finance|investment|policy|cooking|biofuels?|geothermal|nuclear|productive use|energy efficiency)\b/;

function hasFocusedConferenceSubject(normalized) {
  return FOCUSED_CONFERENCE_SUBJECT_PATTERN.test(normalized);
}

function isExplicitGeneralConferenceOverviewClause(clause) {
  const conferenceName =
    "(?:conference|rec(?:\\s*[-']?\\s*\\d{2})?|expo)";
  const overviewSyntax = new RegExp(
    `(?:\\b${conferenceName}\\s+(?:overview|summary)\\b|\\b(?:overview|summary)\\s+(?:of|about)\\s+(?:the\\s+)?${conferenceName}\\b)`,
    "i"
  );

  if (!overviewSyntax.test(clause)) return false;
  if (!hasFocusedConferenceSubject(clause)) return true;

  return /\b(including|along with|as well as|and its)\b|\band (?:the )?(?:sponsors?|partners?|sessions?|programme|program|venue|theme)\b/.test(
    clause
  );
}

function isConferenceOverviewQuestion(normalized) {
  return splitIntentClauses(normalized).some(
    (clause) =>
      isExplicitGeneralConferenceOverviewClause(clause) ||
      (!hasFocusedConferenceSubject(clause) &&
        (isConferenceDeepDiveQuestion(clause) ||
          /\btell me more\b/.test(clause) ||
          /\b(tell me about|describe|introduce|what is|give me (?:information|details) about)\b.*\b(conference|rec(?:\s*[-']?\s*\d{2})?|expo)\b/.test(
            clause
          ) ||
          /^(?:give me |show me )?(?:an? )?(?:conference )?(?:overview|summary)$/.test(
            clause
          )))
  );
}

function isFocusedConferenceFactQuestion(normalized) {
  const hasExplicitOverview = splitIntentClauses(normalized).some(
    isExplicitGeneralConferenceOverviewClause
  );

  return hasFocusedConferenceSubject(normalized) && !hasExplicitOverview;
}

function isOpenEndedSynthesisQuestion(normalized) {
  const asksForSynthesis =
    /\b(compare|contrast|trade[- ]?offs?|interplay|relationship between|strategic implications?|patterns? across|synthesi[sz]e|analy[sz]e)\b/.test(
      normalized
    ) ||
    /\bhow\b.*\b(sessions?|themes?|days?|programme|program|agenda)\b.*\b(connect|relate|build|progress)\b/.test(
      normalized
    );

  return (
    asksForSynthesis &&
    /\b(conference|rec|expo|sessions?|themes?|days?|programme|program|agenda)\b/.test(
      normalized
    )
  );
}

function isDayDateQuestion(normalized) {
  return (
    /\b(on )?which date\b/.test(normalized) ||
    /\bwhat date\b/.test(normalized) ||
    /\bdate is day\b/.test(normalized) ||
    /\bday\s*\d+\b.*\bdate\b/.test(normalized)
  );
}

function isDayScheduleQuestion(normalized) {
  return /\b(what happens|happen|agenda|schedule|program|programme|activity|activities|events?|day schedule)\b/.test(
    normalized
  );
}

function isDayFollowUpQuestion(normalized) {
  return /\b(what of|what about|how about|and what about)\s+days?\b/.test(
    normalized
  );
}

function isSpeakerQuestion(normalized) {
  return /\b(speaker|speakers|presenter|presenters|panelist|panelists)\b/.test(
    normalized
  );
}

function scoreSessionForKeywords(session, keywords) {
  const text = normalizeQuestion(
    `${session.title || ""} ${session.theme || ""} ${stripHtml(session.preamble || "")}`
  );

  return keywords.reduce((score, keyword) => {
    return text.includes(keyword) ? score + 1 : score;
  }, 0);
}

function groupRecommendedSessions(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const key = normalizeQuestion(session.title || session.$id);
    const group = groups.get(key) || {
      title: stripHtml(session.title),
      theme: session.theme,
      venue: session.venueHall,
      sessions: [],
      preamble: "",
    };

    group.sessions.push(session);
    if (!group.preamble && session.preamble) {
      group.preamble = stripHtml(session.preamble);
    }
    groups.set(key, group);
  }

  return [...groups.values()];
}

function getFinanceKeywords() {
  return [
    "finance",
    "financier",
    "financiers",
    "financial",
    "investment",
    "investor",
    "investors",
    "capital",
    "bank",
    "banking",
    "fund",
    "funding",
    "blended finance",
    "guarantee",
    "guarantees",
    "de-risking",
    "deal",
    "deal-making",
    "business",
    "private sector",
    "green industrialisation",
  ];
}

function getRankedFinanceSessions(snapshot) {
  const financeKeywords = getFinanceKeywords();

  return snapshot.sessions
    .map((session) => ({
      session,
      score: scoreSessionForKeywords(session, financeKeywords),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function answerFinanceOneDayRecommendation(snapshot) {
  const ranked = getRankedFinanceSessions(snapshot);

  if (ranked.length === 0) {
    return "I could not find sessions specifically related to finance or investment in the published programme.";
  }

  const scoreByDay = new Map();
  for (const item of ranked) {
    scoreByDay.set(item.session.day, (scoreByDay.get(item.session.day) || 0) + item.score);
  }

  const [bestDay] = [...scoreByDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const days = getConferenceDays(snapshot.conference);
  const dayTheme = days.find((day, index) => getDayNumberFromDay(day, index) === bestDay);
  const bestDaySessions = ranked
    .filter((item) => item.session.day === bestDay)
    .map((item) => item.session);
  const themeText = dayTheme?.theme ? `: ${dayTheme.theme}` : "";

  return joinMarkdownSections([
    `If you can only attend one day for finance or investment, I would choose **Day ${bestDay}${themeText}**.`,
    `**Relevant published sessions that day**\n${formatRecommendedSessions(bestDaySessions)}`,
  ]);
}

function answerFinanceRecommendations(snapshot, options = {}) {
  if (options.oneDayOnly) {
    return answerFinanceOneDayRecommendation(snapshot);
  }

  const ranked = getRankedFinanceSessions(snapshot)
    .map((item) => item.session);
  const groups = groupRecommendedSessions(ranked).slice(0, 4);

  if (groups.length === 0) {
    return "I could not find sessions specifically related to finance or investment in the published programme.";
  }

  const recommendations = groups
    .map((group) => {
      const schedule = group.sessions
        .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime))
        .map((session) =>
          compact([
            `Day ${session.day}`,
            `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`,
            session.venueHall,
          ]).join(", ")
        )
        .join("; ");
      const title = normalizeQuestion(group.title || "");
      let rationale = group.preamble
        ? "It explicitly covers investors, financiers, capital, partnerships, deal-making, blended finance, guarantees, and de-risking for clean energy investment."
        : group.theme && !/^tbc$/i.test(group.theme)
          ? group.theme
          : "This session is finance-relevant based on its title or listed organizer.";

      if (title.includes("africa development bank")) {
        rationale =
          "It is listed as an Africa Development Bank session, so it is likely the strongest development-finance-oriented session currently published, although details are still marked TBC.";
      }

      return `**${group.title}**: ${schedule}. Why: ${rationale}`;
    })
    .filter(Boolean);

  return joinMarkdownSections([
    "For someone in finance, I would prioritize these published REC26 & EXPO sessions:",
    markdownNumberedList(recommendations),
  ]);
}

function findSessionsByTitleParts(snapshot, titleParts) {
  return snapshot.sessions
    .filter((session) => {
      const title = normalizeQuestion(session.title || "");
      return titleParts.some((part) => title.includes(part));
    })
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));
}

function stringifySearchField(value) {
  if (!value) return "";
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getSessionSearchText(session) {
  return normalizeQuestion(
    [
      session.title,
      session.theme,
      session.organizer,
      stripHtml(session.preamble),
      stringifySearchField(session.speakers),
      session.venueHall,
    ].join(" ")
  );
}

function findSessionsByContentParts(snapshot, parts) {
  const normalizedParts = parts.map((part) => normalizeQuestion(part));

  return snapshot.sessions
    .filter((session) => {
      const text = getSessionSearchText(session);
      return normalizedParts.some((part) => text.includes(part));
    })
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));
}

function formatRecommendedSessions(sessions) {
  const items = sessions
    .map((session) =>
      compact([
        stripHtml(session.title),
        `Day ${session.day}`,
        session.venueHall,
        session.startTime && session.toTime
          ? `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`
          : null,
      ]).join(", ")
    );

  return markdownList(items);
}

function answerPolicyRecommendations(snapshot) {
  const sessions = findSessionsByTitleParts(snapshot, [
    "sustainable energy development programme",
    "subregional forum",
    "world resource institute",
    "united nations",
    "uganda - european",
  ]);

  if (sessions.length === 0) {
    return "I could not find policy-focused sessions in the published programme.";
  }

  return joinMarkdownSections([
    "For policymakers or government participants, I would start with Day 1 because its focus is Renewable Energy Policy & Investment.",
    `**Relevant published sessions**\n${formatRecommendedSessions(sessions.slice(0, 5))}`,
    "I would also consider the Uganda - European (EU) Business Forum because it connects policy dialogue with investment partnerships and green industrialisation.",
  ]);
}

function answerProjectDeveloperRecommendations(snapshot) {
  const sessions = findSessionsByTitleParts(snapshot, [
    "uganda - european",
    "productive use energy",
    "sustainable energy development programme",
    "clean cooking",
    "biofuels",
  ]);

  if (sessions.length === 0) {
    return "I could not find project-development-focused sessions in the published programme.";
  }

  return joinMarkdownSections([
    "For project developers, I would prioritize sessions that connect project pipelines, investment, implementation, and productive use.",
    `**Relevant published sessions**\n${formatRecommendedSessions(sessions.slice(0, 6))}`,
    "The Uganda - European (EU) Business Forum is especially relevant because it explicitly covers investors, developers, partnerships, B2B meetings, deal-making, and de-risking.",
  ]);
}

const TOPIC_RECOMMENDATION_PROFILES = [
  {
    label: "cooking technologies",
    pattern:
      /\b(clean cooking|cooking technolog(?:y|ies)|solar[- ]electric cooking|solco|cookstoves?|cooking solutions?)\b/,
    titleParts: ["clean cooking", "solco", "solar-electric cooking"],
    rationale:
      "These are the published sessions most directly connected to clean cooking and solar-electric cooking technologies.",
  },
  {
    label: "productive use energy",
    pattern: /\b(productive use|productive use energy|productive energy)\b/,
    titleParts: ["productive use energy"],
    rationale:
      "This is the published session directly focused on productive use energy.",
  },
  {
    label: "biofuels",
    pattern: /\b(biofuel|biofuels)\b/,
    titleParts: ["biofuels"],
    rationale: "This is the published session directly focused on biofuels.",
  },
  {
    label: "nuclear",
    pattern: /\bnuclear\b/,
    titleParts: ["nuclear"],
    rationale:
      "This is the published session directly connected to nuclear energy.",
  },
  {
    label: "geothermal",
    pattern: /\bgeothermal\b/,
    titleParts: ["geothermal"],
    rationale:
      "These are the published sessions that mention geothermal energy.",
  },
  {
    label: "energy efficiency",
    pattern: /\b(energy efficiency|efficiency)\b/,
    titleParts: ["energy efficiency"],
    rationale:
      "This is the published session directly connected to energy efficiency.",
  },
];

function getTopicRecommendationMatches(snapshot, normalized) {
  return TOPIC_RECOMMENDATION_PROFILES
    .filter((profile) => profile.pattern.test(normalized))
    .map((profile) => ({
      profile,
      sessions: findSessionsByContentParts(snapshot, profile.titleParts),
    }))
    .filter((match) => match.sessions.length > 0);
}

function answerTopicRecommendation(match, { recommendation = true } = {}) {
  return joinMarkdownSections([
    recommendation
      ? `For ${match.profile.label}, I would prioritize:`
      : `Published sessions related to ${match.profile.label}:`,
    formatRecommendedSessions(match.sessions),
    match.profile.rationale,
  ]);
}

function isTopicSessionQuestion(normalized) {
  return (
    /\bsessions?\b/.test(normalized) &&
    /\b(about|related|connected|relevant|mention|mentions|cover|covering|focused|focus|for|tell|list|show|which|what)\b/.test(
      normalized
    )
  );
}

const TECHNOLOGY_DISCUSSION_AREAS = [
  {
    label: "Hydropower, wind, hybrid energy systems, mini-grids and grid storage",
    titleParts: [
      "hydropower",
      "wind",
      "hybrid energy systems",
      "mini-grids",
      "mini grids",
      "grid storage",
    ],
  },
  {
    label: "Geothermal energy",
    titleParts: ["geothermal"],
  },
  {
    label: "Clean cooking and solar-electric cooking",
    titleParts: ["clean cooking", "solco", "solar-electric cooking"],
  },
  {
    label: "Biofuels",
    titleParts: ["biofuels"],
  },
  {
    label: "Nuclear energy",
    titleParts: ["nuclear"],
  },
  {
    label: "Productive use energy",
    titleParts: ["productive use energy"],
  },
  {
    label: "Energy efficiency",
    titleParts: ["energy efficiency"],
  },
  {
    label: "Energy access and management",
    titleParts: ["we4d"],
  },
  {
    label: "Power-sector innovation",
    titleParts: ["power forum"],
  },
];

function getTechnologyDiscussionAreas(snapshot) {
  return TECHNOLOGY_DISCUSSION_AREAS
    .map((area) => ({
      label: area.label,
      sessions: findSessionsByContentParts(snapshot, area.titleParts),
    }))
    .filter((area) => area.sessions.length > 0);
}

function answerTechnologyDiscussionAreas(snapshot) {
  const areas = getTechnologyDiscussionAreas(snapshot);

  if (areas.length === 0) {
    return "I could not find specific renewable-energy technology areas in the published programme.";
  }

  const summary = areas
    .map((area) => {
      const sessions = area.sessions
        .slice(0, 2)
        .map((session) =>
          compact([
            session.title,
            `Day ${session.day}`,
            session.venueHall,
          ]).join(", ")
        )
        .join("; ");
      return `${area.label}: ${sessions}`;
    });

  return joinMarkdownSections([
    "Based on the published programme, renewable-energy technology areas likely to be discussed include:",
    markdownList(summary),
    "Some session details are still marked TBC, so this reflects the current published data.",
  ]);
}

function isTechnologyAreasQuestion(normalized) {
  return (
    /\b(renewable energy technolog(?:y|ies)|technology areas|technical areas)\b/.test(
      normalized
    ) ||
    (/\btechnolog(?:y|ies)\b/.test(normalized) &&
      /\b(discuss|discussed|cover|covered|across|various|may|expect)\b/.test(
        normalized
      ) &&
      !/\b(recommend|attend|what should|which would)\b/.test(normalized))
  );
}

function isTopicRecommendationQuestion(normalized) {
  return /(recommend|attend|useful|prioritize|prioritise|guide|interested|should|focus|what should)/.test(
    normalized
  );
}

function findCeremonyBlocks(snapshot, normalized) {
  const requestedTypes = [
    /\bopening ceremony\b|\bopening\b/.test(normalized) ? "opening" : null,
    /\bclosing ceremony\b|\bclosing\b/.test(normalized) ? "closing" : null,
  ].filter(Boolean);

  if (requestedTypes.length === 0) return [];

  return snapshot.timeBlocks.filter((block) => {
    const label = normalizeQuestion(block.label || "");
    const type = normalizeQuestion(block.type || "");

    return (
      type === "ceremony" &&
      requestedTypes.some((ceremonyType) => label.includes(ceremonyType)) &&
      label.includes("ceremony")
    );
  }).sort((a, b) => a.day - b.day || (a.startMinutes || 0) - (b.startMinutes || 0));
}

function answerCeremonyBlock(snapshot, block) {
  const days = getConferenceDays(snapshot.conference);
  const day = days[block.day - 1];
  const dateText = day?.date ? ` (${day.date})` : "";
  const venueText = block.venueHalls?.length
    ? ` at ${block.venueHalls.join(", ")}`
    : "";

  return joinMarkdownSections([
    `${block.label} is scheduled for **Day ${block.day}${dateText}**.`,
    markdownDetails([
      [
        "Time",
        `${formatTime(block.startTime)} to ${formatTime(
          block.endTime
        )} Kampala time`,
      ],
      ["Venue", venueText ? venueText.replace(/^ at /, "") : null],
    ]),
  ]);
}

function answerMealBreaks(snapshot) {
  return answerFilteredBreaks(snapshot);
}

function answerFilteredBreaks(snapshot, filter = "all") {
  const breaks = snapshot.timeBlocks
    .filter((block) => {
      if (filter === "tea") {
        return block.type === "BREAK" && /tea/i.test(block.label || "");
      }
      if (filter === "lunch") {
        return block.type === "LUNCH" || /lunch/i.test(block.label || "");
      }

      return ["LUNCH", "BREAK"].includes(block.type);
    })
    .sort((a, b) => a.day - b.day || (a.startMinutes || 0) - (b.startMinutes || 0));

  if (breaks.length === 0) {
    return filter === "tea"
      ? "I could not find tea break information in the conference materials."
      : filter === "lunch"
        ? "I could not find lunch information in the conference materials."
        : "I could not find lunch or break information in the conference materials.";
  }

  const summary = breaks
    .map((block) =>
      compact([
        `Day ${block.day}`,
        block.label,
        `${formatTime(block.startTime)} to ${formatTime(block.endTime)}`,
      ]).join(": ")
    );

  const label =
    filter === "tea"
      ? "tea breaks"
      : filter === "lunch"
        ? "lunch breaks"
        : "listed breaks";

  return joinMarkdownSections([
    `The programme includes these ${label}:`,
    markdownList(summary),
  ]);
}

function answerTimeBlocksByType(snapshot, type, label) {
  const blocks = snapshot.timeBlocks
    .filter((block) => normalizeQuestion(block.type) === normalizeQuestion(type))
    .sort((a, b) => a.day - b.day || (a.startMinutes || 0) - (b.startMinutes || 0));

  if (blocks.length === 0) {
    return `I could not find ${label} blocks in the published programme.`;
  }

  const summary = blocks
    .map((block) =>
      compact([
        `Day ${block.day}`,
        `${formatTime(block.startTime)} to ${formatTime(block.endTime)}`,
        block.venueHalls?.length ? block.venueHalls.join(", ") : null,
      ]).join(": ")
    );

  return joinMarkdownSections([
    `Yes. The listed ${label} blocks are:`,
    markdownList(summary),
  ]);
}

function isExhibitionScheduleQuestion(normalized) {
  const mentionsExhibition =
    /\b(?:exhibitions?|exhibit|expo blocks?|expo area)\b/.test(normalized);

  if (!mentionsExhibition) return false;

  return /\b(?:are there|when|where|what time|hours?|schedule|scheduled|blocks?|open|opens|start|starts|end|ends|run|runs|happen|happens|available)\b/.test(
    normalized
  );
}

function getSessionDurationMinutes(session) {
  if (!session.startTime || !session.toTime) return 0;

  return Math.round(
    (new Date(session.toTime).getTime() - new Date(session.startTime).getTime()) /
      60000
  );
}

function answerLongRunningSessions(snapshot) {
  const sessions = snapshot.sessions
    .filter((session) => getSessionDurationMinutes(session) >= 420)
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return "I could not find sessions that run for most of the day in the published programme.";
  }

  const summary = sessions
    .map((session) =>
      compact([
        session.title,
        `Day ${session.day}`,
        session.venueHall,
        `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`,
      ]).join(", ")
    );

  return joinMarkdownSections([
    "The sessions that run for most of the day are:",
    markdownList(summary),
  ]);
}

function getCategoryNameById(snapshot) {
  return new Map(
    snapshot.sponsorCategories.map((category) => [category.$id, category.name])
  );
}

function getActiveSponsors(snapshot) {
  return snapshot.sponsors
    .filter((sponsor) => sponsor.isActive !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
}

function answerSponsorCategories(snapshot) {
  const categories = snapshot.sponsorCategories
    .filter((category) => category.isActive !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

  if (categories.length === 0) {
    return "No active sponsor categories are currently listed.";
  }

  const sponsorsByCategory = new Map();
  for (const sponsor of getActiveSponsors(snapshot)) {
    sponsorsByCategory.set(
      sponsor.categoryId,
      (sponsorsByCategory.get(sponsor.categoryId) || 0) + 1
    );
  }
  const conferenceName =
    snapshot.conference.shortName || snapshot.conference.title || "REC & EXPO";

  return joinMarkdownSections([
    `## ${conferenceName} Sponsor Categories`,
    "The published sponsor structure currently contains:",
    markdownList(
      categories.map((category) => {
        const count = sponsorsByCategory.get(category.$id) || 0;
        return `**${category.name}:** ${count} listed sponsor${count === 1 ? "" : "s"}`;
      })
    ),
  ]);
}

function answerPartners(snapshot) {
  const groups = getRepresentedSponsorGroups(snapshot, { partnersOnly: true });
  const partners = groups.flatMap((group) => group.sponsors);

  if (partners.length === 0) {
    return "No active partners are currently listed for the conference.";
  }

  const conferenceName =
    snapshot.conference.shortName || snapshot.conference.title || "REC & EXPO";

  return joinMarkdownSections([
    `## ${conferenceName} Partners`,
    `${partners.length} published partner${partners.length === 1 ? " is" : "s are"} currently listed.`,
    formatSponsorGroups(groups, { includeCategoryHeadings: false }),
  ]);
}

function answerFeaturedSponsors(snapshot) {
  const groups = getRepresentedSponsorGroups(snapshot, { featuredOnly: true });
  const featured = groups.flatMap((group) => group.sponsors);

  if (featured.length === 0) {
    return "No sponsors are currently marked as featured in the published conference data.";
  }

  return joinMarkdownSections([
    "## Featured Sponsors",
    formatSponsorGroups(groups),
  ]);
}

function answerBeginnerGuidance(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayText = days
    .map((day, index) => {
      const dayNumber = getDayNumberFromDay(day, index);
      return `Day ${dayNumber}: ${day.theme}`;
    });

  return joinMarkdownSections([
    "If you are new to renewable energy, I would use the conference structure as your guide.",
    `**Start with the daily focus areas**\n${markdownList(dayText)}`,
    "**Practical advice:** Day 1 gives the policy and investment foundation, Day 2 introduces technology and innovation, Day 3 moves into implementation and sustainability, and Day 4 focuses on impact, scale, and regional leadership.",
  ]);
}

const OPERATIONAL_MATCH_STOP_WORDS = new Set([
  "about",
  "available",
  "conference",
  "details",
  "event",
  "information",
  "provided",
  "visitor",
  "venue",
]);

function canonicalSearchText(value) {
  return normalizeQuestion(value)
    .replace(/wi[- ]?fi/g, "wifi")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function operationalItemSearchText(item) {
  return canonicalSearchText(
    compact([
      item.title,
      item.category,
      ...(Array.isArray(item.keywords) ? item.keywords : []),
      item.answer,
    ]).join(" ")
  );
}

function getOperationalInfoMatches(normalized, snapshot) {
  const question = canonicalSearchText(normalized);
  const questionTokens = new Set(question.split(" ").filter(Boolean));

  return (snapshot.operationalInfo || [])
    .map((item) => {
      const title = canonicalSearchText(item.title);
      const keywords = (item.keywords || [])
        .map(canonicalSearchText)
        .filter(Boolean);
      const titleTokens = title
        .split(" ")
        .filter(
          (token) => token.length >= 3 && !OPERATIONAL_MATCH_STOP_WORDS.has(token)
        );
      let score = 0;

      if (title.length >= 3 && question.includes(title)) score += 12;

      for (const keyword of keywords) {
        if (keyword.length >= 3 && question.includes(keyword)) score += 8;
      }

      for (const token of titleTokens) {
        if (questionTokens.has(token)) score += 4;
      }

      return { item, score };
    })
    .filter((match) => match.score >= 4)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function answerOperationalInfo(matches) {
  return joinMarkdownSections(
    matches.map(({ item }) =>
      joinMarkdownSections([`**${item.title}**`, item.answer])
    )
  );
}

function getPublishedLogisticsLabels(matches) {
  return new Set(
    UNPUBLISHED_LOGISTICS_TOPICS.filter((topic) =>
      matches.some(({ item }) => topic.pattern.test(operationalItemSearchText(item)))
    ).map((topic) => topic.label)
  );
}

function conferenceYear(bundle) {
  return Number(
    bundle.conference?.year || String(bundle.conference?.startDate || "").slice(0, 4)
  );
}

function extractRequestedConferenceYears(normalized) {
  const years = new Set(
    [...normalized.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]))
  );

  for (const match of normalized.matchAll(/\brec\s*[-']?\s*(\d{2})\b/g)) {
    years.add(2000 + Number(match[1]));
  }

  return years;
}

function isConferenceMediaQuestion(normalized) {
  return /\b(photo|photos|image|images|album|albums|gallery|galleries|media|video|videos|recording|recordings|highlights)\b/.test(
    normalized
  );
}

const CONFERENCE_REPORT_PATTERN =
  /\b(report|reports|document|documents|publication|publications|proceedings|communique|communiques|pdf|pdfs)\b|\bpublished outcomes?\b/;

function isConferenceReportQuestion(normalized) {
  return CONFERENCE_REPORT_PATTERN.test(normalized);
}

function isHistoricalThemeEvolutionQuestion(normalized) {
  const asksAboutThemes = /\bthemes?\b/.test(normalized);
  const asksAcrossEditions =
    /\b(evolv(?:e|ed|ing|ution)|chang(?:e|ed|ing)|progress(?:ion|ed|ing)?|develop(?:ed|ment)?|trend|patterns?|over time|year[- ]to[- ]year)\b/.test(
      normalized
    ) ||
    /\b(across|through|between|among)\b.*\b(editions?|years?|conferences?)\b/.test(
      normalized
    ) ||
    /\bavailable conference editions?\b/.test(normalized);

  return asksAboutThemes && asksAcrossEditions;
}

function hasHistoricalConferenceScope(normalized, snapshot) {
  const activeYear = conferenceYear(snapshot);
  const requestedYears = extractRequestedConferenceYears(normalized);

  return (
    [...requestedYears].some((year) => year !== activeYear) ||
    /\b(previous|past|historical|history|archive|archived|earlier|former|prior)\b/.test(
      normalized
    )
  );
}

function selectConferenceBundles(normalized, snapshot) {
  const bundles = getConferenceBundles(snapshot);
  const requestedYears = extractRequestedConferenceYears(normalized);
  const includesCurrent =
    /\b(current|active|this year|rec\s*[-']?\s*26|2026)\b/.test(
      normalized
    );

  if (requestedYears.size > 0) {
    const selected = bundles.filter((bundle) =>
      requestedYears.has(conferenceYear(bundle))
    );

    if (
      includesCurrent &&
      !selected.some((bundle) => bundle.conference.isActive === true)
    ) {
      selected.unshift(bundles[0]);
    }

    return selected;
  }

  const past = bundles
    .slice(1)
    .sort((left, right) => conferenceYear(right) - conferenceYear(left));

  if (/\b(previous|last|most recent prior) conference\b/.test(normalized)) {
    return includesCurrent ? [bundles[0], ...past.slice(0, 1)] : past.slice(0, 1);
  }

  if (
    /\b(previous|past|historical|history|archive|archived|earlier|former|prior)\b/.test(
      normalized
    )
  ) {
    return includesCurrent ? [bundles[0], ...past] : past;
  }

  if (isConferenceMediaQuestion(normalized)) {
    if (includesCurrent) return [bundles[0]];

    const withMedia = bundles.filter((bundle) => bundle.mediaItems?.length > 0);
    return withMedia.length > 0 ? withMedia : [bundles[0]];
  }

  if (isConferenceReportQuestion(normalized)) {
    if (includesCurrent) return [bundles[0]];

    const withReports = bundles.filter((bundle) => bundle.reports?.length > 0);
    return withReports.length > 0 ? withReports : [bundles[0]];
  }

  return [bundles[0]];
}

function splitIntentClauses(normalized) {
  return normalized
    .split(
      /[?;,]+|\.(?:\s|$)|\b(?:and then|plus also|on the other hand)\b|\band\s+(?=(?:tell|show|list|give|what|when|where|who|is|are|can|does|compare|check)\b)/
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function getIntentConferenceScope(normalized, pattern) {
  const clauses = splitIntentClauses(normalized);
  const matchingClauses = clauses.filter((clause) =>
    pattern.test(clause)
  );
  const yearOnlyContinuationClauses = clauses.filter((clause) => {
    if (matchingClauses.includes(clause)) return false;
    if (extractRequestedConferenceYears(clause).size === 0) return false;

    const remainder = clause
      .replace(/\brec\s*[-']?\s*\d{2}\b/g, " ")
      .replace(/\b20\d{2}\b/g, " ")
      .replace(/\b(and|or|with|edition|editions|year|years)\b/g, " ")
      .replace(/[^a-z0-9]+/g, "")
      .trim();

    return remainder.length === 0;
  });
  const scopedClauses = [...matchingClauses, ...yearOnlyContinuationClauses];
  const years = new Set(
    scopedClauses.flatMap((clause) => [
      ...extractRequestedConferenceYears(clause),
    ])
  );

  return {
    years,
    activeOnly: scopedClauses.some((clause) =>
      /\b(current|active|this year)\b/.test(clause)
    ),
    historicalOnly: scopedClauses.some((clause) =>
      /\b(previous|past|historical|archived|earlier|prior)\b/.test(clause)
    ),
  };
}

function bundleMatchesIntentScope(bundle, scope) {
  if (scope.years.size > 0) {
    return scope.years.has(conferenceYear(bundle));
  }

  if (scope.activeOnly) return bundle.conference.isActive === true;
  if (scope.historicalOnly) return bundle.conference.isActive !== true;

  return true;
}

function isExplicitConferenceLocationQuestion(normalized) {
  if (/\b(where|location|held|take place|venue address)\b/.test(normalized)) {
    return true;
  }

  return (
    /\bvenue\b/.test(normalized) &&
    getUnpublishedLogisticsTopics(normalized).length === 0 &&
    (/\b(what|which|name|address|conference|compare|contrast|expo)\b/.test(
      normalized
    ) ||
      /\brec\s*[-']?\s*\d{2}\b/.test(normalized))
  );
}

function formatEditionSessions(bundle, requestedDays, { speakersOnly = false } = {}) {
  const sessions = (bundle.sessions || [])
    .filter(
      (session) => requestedDays.length === 0 || requestedDays.includes(session.day)
    )
    .sort(
      (left, right) =>
        left.day - right.day || new Date(left.startTime) - new Date(right.startTime)
    );

  if (sessions.length === 0) {
    return "No eligible historical sessions are available in the current public snapshot for this edition.";
  }

  const sessionsByDay = new Map();
  for (const session of sessions) {
    const list = sessionsByDay.get(session.day) || [];
    list.push(session);
    sessionsByDay.set(session.day, list);
  }

  return [...sessionsByDay]
    .map(([day, daySessions]) => {
      const items = daySessions.map((session) => {
        const speakers = normalizeSpeakerText(session.speakers);

        if (speakersOnly) {
          return `**${session.title}:** ${speakers || "Speakers are not yet published."}`;
        }

        const timing = compact([
          session.startTime ? formatTime(session.startTime) : null,
          session.toTime ? formatTime(session.toTime) : null,
        ]).join(" to ");
        const details = compact([timing, session.venueHall]).join(", ");

        return `**${session.title}**${details ? ` (${details})` : ""}`;
      });

      return `**Day ${day}**\n${markdownList(items)}`;
    })
    .join("\n\n");
}

function formatEditionSponsors(bundle, { partnersOnly = false } = {}) {
  const groups = getRepresentedSponsorGroups(bundle, { partnersOnly });
  const sponsors = groups.flatMap((group) => group.sponsors);

  if (sponsors.length === 0) {
    return partnersOnly
      ? "No published partners are listed for this edition."
      : "No published sponsors are listed for this edition.";
  }

  return formatSponsorGroups(groups);
}

function formatEditionMedia(bundle) {
  const mediaItems = bundle.mediaItems || [];

  if (mediaItems.length === 0) {
    return "No published media items are currently listed for this edition.";
  }

  return mediaItems
    .map((item) => {
      const primaryUrl = item.externalUrl || item.videoUrl || item.thumbnailUrl;
      const primaryLinkLabel = item.mediaType === "video" ? "Watch video" : "Open album";
      const sampleImages = parseJson(item.sampleImagesJson, [])
        .map((image) => image.url)
        .filter(Boolean)
        .slice(0, 3);

      return joinMarkdownSections([
        `**${item.title}**${item.mediaType ? ` (${item.mediaType})` : ""}`,
        item.description ? stripHtml(item.description) : null,
        primaryUrl ? `[${primaryLinkLabel}](${primaryUrl})` : null,
        item.videoUrl && item.videoUrl !== primaryUrl
          ? `[Watch video](${item.videoUrl})`
          : null,
        sampleImages.length > 0
          ? `Sample images: ${sampleImages
              .map((url, index) => `[Image ${index + 1}](${url})`)
              .join(" | ")}`
          : null,
      ]);
    })
    .join("\n\n");
}

const REPORT_TYPE_LABELS = {
  conference_report: "conference report",
  proceedings: "proceedings document",
  outcomes: "outcomes report",
  communique: "communique",
  other: "other report",
};

function extractRequestedReportTypes(normalized) {
  const types = new Set();

  if (/\bconference\s+reports?\b/.test(normalized)) {
    types.add("conference_report");
  }
  if (/\bproceedings\b/.test(normalized)) types.add("proceedings");
  if (/\bcommuniques?\b/.test(normalized)) types.add("communique");
  if (/\b(?:published\s+outcomes?|outcomes?\s+(?:report|document)s?)\b/.test(normalized)) {
    types.add("outcomes");
  }

  return [...types];
}

function selectEditionReports(bundle, requestedTypes = []) {
  return [...(bundle.reports || [])]
    .filter(
      (report) =>
        requestedTypes.length === 0 || requestedTypes.includes(report.reportType)
    )
    .sort(
    (left, right) =>
      (left.displayOrder || 0) - (right.displayOrder || 0) ||
      String(left.title || "").localeCompare(String(right.title || ""))
  );
}

function formatEditionReports(bundle, requestedTypes = []) {
  const reports = selectEditionReports(bundle, requestedTypes);

  if (reports.length === 0) {
    if (requestedTypes.length > 0) {
      const requestedLabels = requestedTypes
        .map((type) => REPORT_TYPE_LABELS[type] || type.replace(/_/g, " "))
        .join(" or ");

      return `I could not find a published ${requestedLabels} for this edition.`;
    }

    return "No published report or conference document is currently listed for this edition.";
  }

  return reports
    .map((report) => {
      const reportType = String(report.reportType || "conference report")
        .replace(/_/g, " ")
        .trim();

      return joinMarkdownSections([
        `**${report.title}**${reportType ? ` (${reportType})` : ""}`,
        report.summary ? stripHtml(report.summary) : null,
        report.reportUrl ? `[Open report](${report.reportUrl})` : null,
        report.publicationDate
          ? `Published: ${formatDate(report.publicationDate)}`
          : null,
      ]);
    })
    .join("\n\n");
}

function answerHistoricalThemeEvolution(normalized, snapshot) {
  const bundles = getConferenceBundles(snapshot)
    .filter((bundle) => Number.isFinite(conferenceYear(bundle)))
    .sort((left, right) => conferenceYear(left) - conferenceYear(right));
  const themedBundles = bundles.filter((bundle) => bundle.conference?.theme);

  if (themedBundles.length < 2) {
    return answerConferenceEditions(normalized, snapshot);
  }

  const first = themedBundles[0];
  const latest = themedBundles[themedBundles.length - 1];
  const intermediateThemes = themedBundles
    .slice(1, -1)
    .map((bundle) => bundle.conference.theme)
    .join(" ")
    .toLowerCase();
  const recurringIdeas = [
    ["clean-energy access", /clean energy|energy access/],
    ["livelihoods", /livelihood/],
    ["energy systems", /energy systems?/],
    ["industrialisation", /industriali[sz]ation/],
    ["conservation", /conservation/],
  ]
    .filter(([, pattern]) => pattern.test(intermediateThemes))
    .map(([label]) => label);
  const naturalRecurringIdeas =
    recurringIdeas.length > 1
      ? `${recurringIdeas.slice(0, -1).join(", ")} and ${recurringIdeas.at(-1)}`
      : recurringIdeas[0] || "";
  const displayTheme = (theme) => String(theme || "").replace(/,(?=\S)/g, ", ");
  const currentDays = parseJson(snapshot.conference?.days, []);
  const sources = themedBundles.map((bundle) =>
    sourceFor(
      "conference_overview",
      bundle.conference,
      bundle.conference.shortName || bundle.conference.title
    )
  );
  const sections = [
    "The published REC themes show this progression:",
    markdownList(
      themedBundles.map(
        (bundle) => {
          const year = conferenceYear(bundle);
          const edition = bundle.conference.shortName || `REC${String(year).slice(-2)}`;

          return `**${year} (${edition}):** ${displayTheme(bundle.conference.theme)}`;
        }
      )
    ),
    `**Grounded interpretation:** The theme wording moves from **${displayTheme(first.conference.theme)}** in ${conferenceYear(
      first
    )} toward **${displayTheme(latest.conference.theme)}** in ${conferenceYear(latest)}${
      recurringIdeas.length > 0
        ? `, while the intervening editions repeatedly emphasize ${naturalRecurringIdeas}`
        : ""
    }. This suggests a broad shift from establishing renewable energy's role in development toward implementing connected energy systems and scaling their contribution to a green economy. This is an interpretation of the published themes, not a separate statement from the organizers.`,
  ];

  if (
    /\b(first[- ]time|new attendee|new to|attendee|prepare|preparation|what.*suggest)\b/.test(
      normalized
    )
  ) {
    sections.push(
      joinMarkdownSections([
        "**What this means for a first-time attendee:**",
        currentDays.length > 0
          ? markdownList(
              currentDays.map(
                (day, index) =>
                  `**${day.label || `Day ${index + 1}`}:** ${day.theme || "Focus not published"}`
              )
            )
          : null,
        "Start by identifying the current-day themes most relevant to your role, then choose published sessions within those days. Keep notes under policy, technology, implementation, and scale so the four days form one learning path rather than isolated sessions.",
      ])
    );
  }

  return {
    answer: joinMarkdownSections(sections),
    sources: uniqueSources(sources),
  };
}

function answerConferenceEditions(normalized, snapshot) {
  const selected = selectConferenceBundles(normalized, snapshot);
  const availableYears = getConferenceBundles(snapshot)
    .map(conferenceYear)
    .filter(Number.isFinite)
    .sort((left, right) => right - left);

  if (selected.length === 0) {
    return {
      answer: `I could not find that REC edition. Available conference years are ${availableYears.join(", ")}.`,
      sources: [
        sourceFor(
          "conference_overview",
          snapshot.conference,
          snapshot.conference.title
        ),
      ],
    };
  }

  const requestedDays = extractRequestedDays(normalized);
  const asksMedia = isConferenceMediaQuestion(normalized);
  const asksReports = isConferenceReportQuestion(normalized);
  const requestedReportTypes = extractRequestedReportTypes(normalized);
  const asksSpeakers = isSpeakerQuestion(normalized);
  const asksSessions =
    asksSpeakers ||
    /\b(session|sessions|program|programme|agenda|schedule|happen|happened)\b/.test(
      normalized
    );
  const asksSponsors = /\bsponsor|sponsors\b/.test(normalized);
  const asksPartners = /\bpartner|partners\b/.test(normalized);
  const asksTheme = /\btheme|themes\b/.test(normalized);
  const asksVenue = isExplicitConferenceLocationQuestion(normalized);
  const asksDates = /\b(when|date|dates|start|started|end|ended)\b/.test(normalized);
  const operationalMatches = getOperationalInfoMatches(normalized, snapshot);
  const publishedLogisticsLabels = getPublishedLogisticsLabels(
    operationalMatches
  );
  const unresolvedLogisticsTopics = getUnpublishedLogisticsTopics(
    normalized
  ).filter((label) => !publishedLogisticsLabels.has(label));
  const mediaScope = getIntentConferenceScope(
    normalized,
    /\b(photo|photos|image|images|album|albums|gallery|galleries|media|video|videos|recording|recordings|highlights)\b/
  );
  const reportScope = getIntentConferenceScope(
    normalized,
    CONFERENCE_REPORT_PATTERN
  );
  const sessionScope = getIntentConferenceScope(
    normalized,
    /\b(session|sessions|program|programme|agenda|schedule|happen|happened|speaker|speakers|presenter|presenters|panelist|panelists)\b/
  );
  const sponsorScope = getIntentConferenceScope(
    normalized,
    /\b(sponsor|sponsors|partner|partners)\b/
  );
  const themeScope = getIntentConferenceScope(normalized, /\btheme|themes\b/);
  const venueScope = getIntentConferenceScope(
    normalized,
    /\b(where|venue|location|held|take place)\b/
  );
  const dateScope = getIntentConferenceScope(
    normalized,
    /\b(when|date|dates|start|started|end|ended)\b/
  );
  const logisticsScope = getIntentConferenceScope(
    normalized,
    /\b(wi[- ]?fi|internet|parking|accommodation|lodging|shuttle|airport transfer|dress code|attire|visa|accessibility|wheelchair|certificate|breakfast|dinner|childcare|charging|prayer room|first aid|medical|bag policy|security)\b/
  );
  const hasFocusedRequest =
    asksMedia ||
    asksReports ||
    asksSessions ||
    asksSponsors ||
    asksPartners ||
    asksTheme ||
    asksVenue ||
    asksDates ||
    operationalMatches.length > 0 ||
    unresolvedLogisticsTopics.length > 0;
  const sources = [];
  const sections = selected.map((bundle) => {
    const conference = bundle.conference;
    const year = conferenceYear(bundle);
    const facts = [];

    sources.push(sourceFor("conference_overview", conference, conference.title));

    if (
      !hasFocusedRequest ||
      (asksDates && bundleMatchesIntentScope(bundle, dateScope))
    ) {
      facts.push(`**Dates:** ${formatConferenceDates(conference) || "Not published"}`);
    }
    if (
      !hasFocusedRequest ||
      (asksTheme && bundleMatchesIntentScope(bundle, themeScope))
    ) {
      facts.push(
        `**Theme:** ${String(conference.theme || "Not published").replace(
          /,(?=\S)/g,
          ", "
        )}`
      );
    }
    if (
      !hasFocusedRequest ||
      (asksVenue && bundleMatchesIntentScope(bundle, venueScope))
    ) {
      facts.push(
        `**Venue:** ${formatConferenceVenue(conference) || "Not published"}`
      );
    }
    if (!hasFocusedRequest) {
      facts.push(`**Published sessions:** ${(bundle.sessions || []).length}`);
      facts.push(`**Published media items:** ${(bundle.mediaItems || []).length}`);
      facts.push(`**Published reports:** ${(bundle.reports || []).length}`);
    }
    if (asksSessions && bundleMatchesIntentScope(bundle, sessionScope)) {
      facts.push(
        `${asksSpeakers ? "**Published speakers**" : "**Programme sessions**"}\n${formatEditionSessions(
          bundle,
          requestedDays,
          { speakersOnly: asksSpeakers }
        )}`
      );
      sources.push(
        ...(bundle.sessions || []).map((session) =>
          sourceFor("session", session, session.title)
        )
      );
    }
    if (
      (asksSponsors || asksPartners) &&
      bundleMatchesIntentScope(bundle, sponsorScope)
    ) {
      facts.push(
        `**${asksPartners && !asksSponsors ? "Partners" : "Sponsors and partners"}**\n${formatEditionSponsors(
          bundle,
          { partnersOnly: asksPartners && !asksSponsors }
        )}`
      );
      sources.push(
        ...(bundle.sponsors || []).map((sponsor) =>
          sourceFor("sponsor", sponsor, sponsor.name)
        )
      );
    }
    if (asksMedia && bundleMatchesIntentScope(bundle, mediaScope)) {
      facts.push(`**Published media**\n${formatEditionMedia(bundle)}`);
      sources.push(
        ...(bundle.mediaItems || []).map((item) =>
          sourceFor("conference_media", item, item.title)
        )
      );
    }
    if (asksReports && bundleMatchesIntentScope(bundle, reportScope)) {
      const reportItems = selectEditionReports(bundle, requestedReportTypes);
      facts.push(
        `**Published reports and documents**\n${formatEditionReports(
          bundle,
          requestedReportTypes
        )}`
      );
      sources.push(
        ...reportItems.map((item) =>
          sourceFor("conference_report", item, item.title)
        )
      );
    }
    if (
      conference.isActive === true &&
      operationalMatches.length > 0 &&
      bundleMatchesIntentScope(bundle, logisticsScope)
    ) {
      facts.push(
        `**Published visitor information**\n${answerOperationalInfo(
          operationalMatches
        )}`
      );
      sources.push(
        ...operationalMatches.map(({ item }) =>
          sourceFor("operational_info", item, item.title)
        )
      );
    }
    if (
      conference.isActive === true &&
      unresolvedLogisticsTopics.length > 0 &&
      bundleMatchesIntentScope(bundle, logisticsScope)
    ) {
      facts.push(answerUnpublishedLogistics(snapshot, unresolvedLogisticsTopics));
    }
    if (
      conference.isActive !== true &&
      unresolvedLogisticsTopics.length > 0 &&
      bundleMatchesIntentScope(bundle, logisticsScope)
    ) {
      facts.push(
        `I could not find archived public information about ${unresolvedLogisticsTopics.join(
          ", "
        )} for this edition.`
      );
    }

    return `### ${conference.shortName || conference.title} (${year})\n\n${facts.join(
      "\n\n"
    )}`;
  });

  const introduction = selected.length > 1
    ? "Here is the published information for the requested REC editions."
    : "Here is the published information for that REC edition.";

  return {
    answer: joinMarkdownSections([introduction, ...sections]),
    sources: uniqueSources(sources),
  };
}

function isConferencePreparationQuestion(normalized) {
  return (
    /\b(prepare|preparation|get ready|plan|planning|maximize|maximise|make the most)\b/.test(
      normalized
    ) &&
    /\b(conference|rec|expo|event|programme|program|agenda|4 days|four days|days)\b/.test(
      normalized
    )
  );
}

const UNPUBLISHED_LOGISTICS_TOPICS = [
  {
    label: "Wi-Fi or internet access",
    pattern: /\bwi[- ]?fi\b|\binternet (access|connection|available|availability)\b/,
  },
  { label: "parking", pattern: /\bparking\b/ },
  {
    label: "accommodation",
    pattern: /\b(accommodation|lodging|hotel rooms?)\b/,
  },
  {
    label: "transport or shuttle services",
    pattern: /\b(shuttle|airport transfer|transport to|transport from)\b/,
  },
  { label: "the dress code", pattern: /\b(dress code|attire)\b/ },
  { label: "visa support", pattern: /\bvisa(s| support| letter)?\b/ },
  {
    label: "accessibility arrangements",
    pattern: /\b(accessibility|wheelchair|disability access|disabled access)\b/,
  },
  {
    label: "attendance certificates",
    pattern: /\b(certificate|certification)\b/,
  },
  {
    label: "breakfast or dinner",
    pattern: /\b(breakfast|dinner|evening meal)\b/,
  },
  { label: "childcare", pattern: /\b(childcare|child care|creche|crèche)\b/ },
  {
    label: "device charging facilities",
    pattern: /\b(charging points?|power outlets?|device charging)\b/,
  },
  { label: "a prayer room", pattern: /\bprayer room\b/ },
  {
    label: "medical or first-aid support",
    pattern: /\b(first aid|medical support|medical assistance)\b/,
  },
  {
    label: "the venue security or bag policy",
    pattern: /\b(bag policy|security checks?|security policy)\b/,
  },
];

function getUnpublishedLogisticsTopics(normalized) {
  return UNPUBLISHED_LOGISTICS_TOPICS
    .filter((topic) => topic.pattern.test(normalized))
    .map((topic) => topic.label);
}

function answerUnpublishedLogistics(snapshot, topics) {
  const contacts = compact([
    snapshot.conference.contactEmail,
    snapshot.conference.contactPhone,
    snapshot.conference.mainWebsiteUrl,
  ]);
  const subject = topics.length === 1
    ? `**${topics[0]}**`
    : topics.map((topic) => `**${topic}**`).join(", ");
  const followUp = contacts.length > 0
    ? `For confirmation, use the published conference contact details: ${contacts.join(", ")}.`
    : "Please confirm this directly with the conference organizers.";

  return joinMarkdownSections([
    `I could not find published information about ${subject} in the conference materials.`,
    followUp,
  ]);
}

function isUnlistedOfficialAvailabilityQuestion(normalized) {
  return (
    /^(is|are|will|would|does|do|has|have|can)\b/.test(normalized) &&
    /\b(available|availability|provided|offered|included|allowed|permitted|required|there be)\b/.test(
      normalized
    )
  ) || /^what\b.*\b(available|provided|offered|included)\b/.test(normalized);
}

function answerUnlistedOfficialAvailability(snapshot) {
  const contacts = compact([
    snapshot.conference.contactEmail,
    snapshot.conference.contactPhone,
    snapshot.conference.mainWebsiteUrl,
  ]);
  const followUp = contacts.length > 0
    ? `For confirmation, use the published conference contact details: ${contacts.join(", ")}.`
    : "Please confirm this directly with the conference organizers.";

  return joinMarkdownSections([
    "I could not find that information in the published conference materials.",
    followUp,
  ]);
}

function summarizeDaySessions(snapshot, dayNumber, limit = 3) {
  const sessions = snapshot.sessions
    .filter((session) => session.day === dayNumber)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const listed = sessions
    .slice(0, limit)
    .map((session) =>
      compact([session.title, session.venueHall ? `at ${session.venueHall}` : null]).join(
        " "
      )
    )
    .join("; ");

  if (!listed) return "";

  return sessions.length > limit
    ? `${listed}, plus ${sessions.length - limit} more`
    : listed;
}

function getDayPreparationAdvice(dayTheme) {
  const theme = normalizeQuestion(dayTheme || "");

  if (/policy|investment/.test(theme)) {
    return "prepare policy, regulation, financing and programme-performance questions";
  }

  if (/technology|innovation/.test(theme)) {
    return "identify the technologies, partners and investment opportunities you want to compare";
  }

  if (/implementation|sustainability/.test(theme)) {
    return "bring practical project-delivery, clean-cooking, sustainability and implementation questions";
  }

  if (/impact|scale|regional/.test(theme)) {
    return "focus on scale-up, regional leadership, productive use and the commitments you want to follow up";
  }

  return "prepare questions tied to this day's published focus area";
}

function getPreparationLogisticsAdvice(snapshot) {
  const sessionStart = snapshot.timeBlocks
    .filter((block) => block.type === "SESSION")
    .sort((a, b) => (a.startMinutes || 0) - (b.startMinutes || 0))[0];
  const teaBreak = snapshot.timeBlocks
    .filter((block) => block.type === "BREAK" && /tea/i.test(block.label || ""))
    .sort((a, b) => (a.startMinutes || 0) - (b.startMinutes || 0))[0];
  const lunchBreak = snapshot.timeBlocks
    .filter((block) => block.type === "LUNCH" || /lunch/i.test(block.label || ""))
    .sort((a, b) => (a.startMinutes || 0) - (b.startMinutes || 0))[0];
  const logistics = compact([
    sessionStart?.startTime
      ? `morning sessions start around ${formatTime(sessionStart.startTime)}`
      : null,
    teaBreak?.startTime
      ? `the first listed refreshment break is Tea Break at ${formatTime(
          teaBreak.startTime
        )}`
      : null,
    lunchBreak?.startTime
      ? `lunch is listed from ${formatTime(lunchBreak.startTime)}`
      : null,
  ]);

  if (logistics.length === 0) {
    return "";
  }

  return `For practical logistics, ${logistics.join(", and ")}. I would have breakfast before arriving, carry anything you need for the morning sessions, and use the tea and lunch breaks for networking.`;
}

function answerConferencePreparation(snapshot) {
  const days = getConferenceDays(snapshot.conference);

  if (days.length === 0) {
    return "I could not find the four-day conference structure in the published materials.";
  }

  const dayPlans = days.map((day, index) => {
    const dayNumber = getDayNumberFromDay(day, index);
    const dateText = day.date ? ` (${day.date})` : "";
    const sessions = summarizeDaySessions(snapshot, dayNumber);
    const sessionText = sessions ? ` Sessions to watch: ${sessions}.` : "";

    return `Day ${dayNumber}${dateText} - ${day.theme}: ${getDayPreparationAdvice(
      day.theme
    )}.${sessionText}`;
  });

  return joinMarkdownSections([
    `Based on the published ${snapshot.conference.shortName || snapshot.conference.title} programme, I would prepare around the four-day progression instead of treating it as one long agenda.`,
    "Before the event, shortlist your main questions, target contacts and must-attend sessions for each day, then leave room for updates because some session details are still marked TBC.",
    getPreparationLogisticsAdvice(snapshot),
    `**Day-by-day preparation**\n${markdownList(dayPlans)}`,
    "After each day, capture follow-ups, contacts and decisions while they are still fresh so Day 4 becomes a clear action plan rather than just a closing day.",
  ]);
}

function getConferencePreparationSources(snapshot) {
  const days = getConferenceDays(snapshot.conference);

  return days.flatMap((day, index) => {
    const dayNumber = getDayNumberFromDay(day, index);
    return snapshot.sessions
      .filter((session) => session.day === dayNumber)
      .slice(0, 3)
      .map((session) => sourceFor("session", session, session.title));
  });
}

function answerDayThemeAttendance(snapshot, day) {
  const days = getConferenceDays(snapshot.conference);
  const dayIndex = days.indexOf(day);
  const dayNumber = getDayNumberFromDay(day, dayIndex);
  const sessions = snapshot.sessions
    .filter((session) => session.day === dayNumber)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return `For ${day.theme}, I would focus on Day ${dayNumber}, but I could not find listed sessions for that day.`;
  }

  return joinMarkdownSections([
    `If you care about ${day.theme}, focus on Day ${dayNumber}.`,
    `**Relevant listed sessions**\n${formatRecommendedSessions(sessions)}`,
  ]);
}

function uniqueSources(sources) {
  const seen = new Set();

  return sources.filter((source) => {
    const key = `${source.sourceType}:${source.rowId || source.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getCompoundDirectAnswer(normalized, snapshot, sources) {
  const parts = [];
  const compoundSources = [...sources];
  const conference = snapshot.conference;
  const dayThemeMatch = getDayThemeMatch(normalized, snapshot);
  const requestedDays = extractRequestedDays(normalized);
  const requestedDay = requestedDays[0] || null;
  const requestedDayPart = getRequestedDayPart(normalized);
  const requestedHall = findRequestedHall(normalized, snapshot);
  const mentionedSession = findMentionedSession(normalized, snapshot.sessions);
  const ceremonyBlocks = findCeremonyBlocks(snapshot, normalized);
  const ceremonyBlock = ceremonyBlocks[0] || null;
  const topicRecommendationMatches = getTopicRecommendationMatches(
    snapshot,
    normalized
  );
  const wantsTopicRecommendation = isTopicRecommendationQuestion(normalized);
  const wantsTopicSessionDetails =
    wantsTopicRecommendation || isTopicSessionQuestion(normalized);
  const asksConferenceStart =
    /\bwhen\b.*\b(conference|rec|expo|event)\b.*\b(start|starts|starting|begin|begins|beginning)\b/.test(
      normalized
    ) ||
    /\b(conference|rec|expo|event)\b.*\b(start|starts|starting|begin|begins|beginning)\b/.test(
      normalized
    ) ||
    /\bactually start\b/.test(normalized);
  const asksTechnologyAreas = isTechnologyAreasQuestion(normalized);
  const asksPreparation = isConferencePreparationQuestion(normalized);
  const asksConferenceLocation = isExplicitConferenceLocationQuestion(normalized);
  const operationalMatches = getOperationalInfoMatches(normalized, snapshot);
  const publishedLogisticsLabels = getPublishedLogisticsLabels(
    operationalMatches
  );
  const unpublishedLogisticsTopics = getUnpublishedLogisticsTopics(
    normalized
  ).filter((label) => !publishedLogisticsLabels.has(label));
  const oneDayOnly = /\b(only have one day|just one day|single day|one day)\b/.test(
    normalized
  );
  const wantsProgramOverview =
    /(overview|summary|summarise|summarize|tell me about|give me).*(program|programme|agenda)|\b(program|programme|agenda)\s+overview\b/.test(
      normalized
    ) ||
    (/\b(program|programme|agenda)\b/.test(normalized) &&
      /(overview|summary|more|about|tell|give|what)/.test(normalized));
  const wantsConferenceOverview = isConferenceOverviewQuestion(normalized);
  const wantsAllSessionsList = isAllSessionsListQuestion(normalized);
  const wantsProgrammeProgression = isProgrammeProgressionQuestion(normalized);
  const wantsProgrammeTradeOffs = isProgrammeTradeOffQuestion(normalized);

  function addPart(answer, partSources = []) {
    if (!answer) return;
    parts.push(answer);
    compoundSources.push(...partSources);
  }

  if (wantsProgramOverview) {
    addPart(
      answerProgramOverview(snapshot),
      snapshot.programs.map((program) =>
        sourceFor("program_overview", program, program.title)
      )
    );
  }

  if (
    wantsConferenceOverview &&
    !wantsProgramOverview &&
    !isFocusedConferenceFactQuestion(normalized)
  ) {
    addPart(
      isConferenceDeepDiveQuestion(normalized)
        ? answerConferenceDeepDive(snapshot)
        : answerConferenceOverview(snapshot),
      sources
    );
  }

  if (asksPreparation) {
    addPart(
      answerConferencePreparation(snapshot),
      getConferencePreparationSources(snapshot)
    );
  }

  if (wantsProgrammeProgression) {
    addPart(
      answerProgrammeProgression(snapshot),
      getConferencePreparationSources(snapshot)
    );
  }

  if (wantsProgrammeTradeOffs) {
    addPart(
      answerProgrammeTradeOffs(snapshot),
      getProgrammeTradeOffEvidence(snapshot).map((session) =>
        sourceFor("session", session, session.title)
      )
    );
  }

  if (operationalMatches.length > 0) {
    addPart(
      answerOperationalInfo(operationalMatches),
      operationalMatches.map(({ item }) =>
        sourceFor("operational_info", item, item.title)
      )
    );
  }

  if (unpublishedLogisticsTopics.length > 0) {
    addPart(answerUnpublishedLogistics(snapshot, unpublishedLogisticsTopics), sources);
  }

  if (wantsAllSessionsList || isGenericSessionsOverviewQuestion(normalized)) {
    const overviewSessions = getSessionsForDays(snapshot, requestedDays);
    addPart(
      answerSessionsOverview(snapshot, requestedDays, {
        includeAll: wantsAllSessionsList || requestedDays.length > 0,
      }),
      overviewSessions
        .slice(
          0,
          wantsAllSessionsList || requestedDays.length > 0
            ? overviewSessions.length
            : 8
        )
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (asksTechnologyAreas) {
    const areas = getTechnologyDiscussionAreas(snapshot);
    addPart(
      answerTechnologyDiscussionAreas(snapshot),
      areas
        .flatMap((area) => area.sessions)
        .slice(0, 10)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (asksConferenceStart) {
    const firstBlock = findFirstScheduledBlock(snapshot);
    const firstSession = findFirstSession(snapshot);
    addPart(
      answerConferenceStart(snapshot),
      [
        firstBlock
          ? sourceFor("program_time_block", firstBlock, firstBlock.label)
          : null,
        firstSession ? sourceFor("session", firstSession, firstSession.title) : null,
      ].filter(Boolean)
    );
  }

  if (isSpeakerQuestion(normalized)) {
    const speakerSessions = getSessionsForDays(snapshot, requestedDays);
    addPart(
      answerSpeakersOverview(snapshot, requestedDays),
      speakerSessions
        .slice(0, requestedDays.length > 0 ? speakerSessions.length : 12)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (
    !asksConferenceStart &&
    !ceremonyBlock &&
    !requestedHall &&
    (!mentionedSession || /\b(conference|rec|expo|event)\b/.test(normalized)) &&
    (asksConferenceLocation ||
      /\b(date|dates)\b/.test(normalized) ||
      (/\bwhen\b/.test(normalized) &&
        /\b(conference|rec|expo|event|it)\b/.test(normalized) &&
        !/\b(lunch|meal|tea|break|sessions?|forum)\b/.test(normalized)))
  ) {
    addPart(answerConferenceDatesAndVenue(snapshot), sources);
  }

  if (
    mentionedSession &&
    !wantsTopicSessionDetails &&
    /\b(when|where|venue|time|schedule|details?|about|tell|sessions?|forum)\b/.test(
      normalized
    )
  ) {
    addPart(answerSpecificSession(mentionedSession, normalized), [
      sourceFor("session", mentionedSession, mentionedSession.title),
    ]);
  }

  for (const block of ceremonyBlocks) {
    addPart(answerCeremonyBlock(snapshot, block), [
      sourceFor("program_time_block", block, block.label),
    ]);
  }

  if (/theme/.test(normalized) && !/\bsessions?\b/.test(normalized)) {
    addPart(`The theme for ${conference.title} is "${conference.theme}".`, sources);
  }

  if (/(daily theme|day themes|focus areas|each day.*theme|daily focus)/.test(normalized)) {
    addPart(answerDailyThemes(snapshot), sources);
  }

  if (/(contact|phone|email)/.test(normalized)) {
    addPart(
      compact([
        conference.contactPhone ? `Phone: ${conference.contactPhone}` : null,
        conference.contactEmail ? `Email: ${conference.contactEmail}` : null,
      ]).join(". ") || "No public contact information is currently listed.",
      sources
    );
  }

  if (/(website|site|link|url)/.test(normalized)) {
    addPart(
      conference.mainWebsiteUrl
        ? `The conference website is ${conference.mainWebsiteUrl}.`
        : "No public website is currently listed.",
      sources
    );
  }

  if (/(register|registration)/.test(normalized)) {
    const hasDeadlineQuestion = /\b(when|deadline|close|closes|closing|end|ends)\b/.test(
      normalized
    );
    const status = conference.registrationOpen
      ? `Registration is currently open for ${conference.title}.`
      : conference.regClosedMessage ||
        `Registration is currently closed for ${conference.title}.`;
    addPart(
      hasDeadlineQuestion
        ? `${withTerminalPeriod(status)} I could not find a registration deadline in the published conference materials.`
        : withTerminalPeriod(status),
      sources
    );
  }

  if (/(learn|expect|what do i expect|what will i learn)/.test(normalized)) {
    addPart(
      answerLearningOutcomes(snapshot),
      snapshot.sessions
        .filter((session) => session.theme && !/^tbc$/i.test(session.theme))
        .slice(0, 8)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (/\b(new|beginner|first time|newcomer)\b/.test(normalized)) {
    addPart(answerBeginnerGuidance(snapshot), sources);
  }

  if (
    dayThemeMatch &&
    /(attend|care|interested|focus|should|recommend|guide|what should)/.test(
      normalized
    )
  ) {
    addPart(
      answerDayThemeAttendance(snapshot, dayThemeMatch),
      getThemeSources(snapshot, dayThemeMatch)
    );
  }

  if (
    /(finance|financial|investment|investor|capital|bank|funding|fund|business)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|relevant|relation|related|interested|guide|opportunit)/.test(
      normalized
    )
  ) {
    const rankedSessions = getRankedFinanceSessions(snapshot).map(
      (item) => item.session
    );

    addPart(
      answerFinanceRecommendations(snapshot, { oneDayOnly }),
      rankedSessions
        .slice(0, 6)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (
    /(policy ?makers?|policymakers?|government|regulator|regulators|ministry|public sector)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|useful|relevant|focus|interested)/.test(
      normalized
    )
  ) {
    const policySessions = findSessionsByTitleParts(snapshot, [
      "sustainable energy development programme",
      "subregional forum",
      "world resource institute",
      "united nations",
      "uganda - european",
    ]);

    addPart(
      answerPolicyRecommendations(snapshot),
      policySessions
        .slice(0, 6)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (
    /(project developer|project developers|developer|developers|renewable energy company|energy company)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|useful|relevant|focus|interested)/.test(
      normalized
    )
  ) {
    const developerSessions = findSessionsByTitleParts(snapshot, [
      "uganda - european",
      "productive use energy",
      "sustainable energy development programme",
      "clean cooking",
      "biofuels",
    ]);

    addPart(
      answerProjectDeveloperRecommendations(snapshot),
      developerSessions
        .slice(0, 8)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (wantsTopicSessionDetails) {
    for (const topicMatch of topicRecommendationMatches) {
      addPart(
        answerTopicRecommendation(topicMatch, {
          recommendation: wantsTopicRecommendation,
        }),
        topicMatch.sessions
          .map((session) => sourceFor("session", session, session.title))
      );
    }
  }

  if (requestedHall && /\b(what|happen|happens|scheduled|schedule|agenda|activity|activities|event|events|in|at)\b/.test(normalized)) {
    const hallSessions = getHallSessions(snapshot, requestedHall);
    const hallBlocks = getHallTimeBlocks(snapshot, requestedHall);
    addPart(
      answerScheduleByHall(snapshot, requestedHall),
      [
        ...hallSessions
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
        ...hallBlocks
          .slice(0, hallSessions.length ? 0 : 6)
          .map((block) => sourceFor("program_time_block", block, block.label)),
      ]
    );
  }

  if (
    !requestedHall &&
    !/\bsessions?\b/.test(normalized) &&
    (/(which|what|list|show).*\b(halls?|rooms?|spaces?)\b|\b(halls?|rooms?|spaces?)\b.*\b(used|available|venue|venues|list|which|what)\b/.test(
      normalized
    ))
  ) {
    addPart(
      answerVenueHalls(snapshot),
      snapshot.programs.map((program) =>
        sourceFor("program_overview", program, program.title)
      )
    );
  }

  if (isExhibitionScheduleQuestion(normalized)) {
    const exhibitionBlocks = snapshot.timeBlocks.filter(
      (block) => block.type === "EXHIBITION"
    );
    addPart(
      answerTimeBlocksByType(snapshot, "EXHIBITION", "exhibition"),
      exhibitionBlocks.map((block) =>
        sourceFor("program_time_block", block, block.label)
      )
    );
  }

  if (/(lunch|meal|tea|break)/.test(normalized)) {
    const breakFilter = /tea/.test(normalized)
      ? "tea"
      : /(lunch|meal)/.test(normalized)
        ? "lunch"
        : "all";
    const matchingBreaks = snapshot.timeBlocks.filter((block) => {
      if (breakFilter === "tea") {
        return block.type === "BREAK" && /tea/i.test(block.label || "");
      }
      if (breakFilter === "lunch") {
        return block.type === "LUNCH" || /lunch/i.test(block.label || "");
      }

      return ["LUNCH", "BREAK"].includes(block.type);
    });

    addPart(
      answerFilteredBreaks(snapshot, breakFilter),
      matchingBreaks
        .slice(0, 8)
        .map((block) => sourceFor("program_time_block", block, block.label))
    );
  }

  if (/(morning.*evening|morning to evening|full day|all day|most of the day)/.test(normalized)) {
    const longSessions = snapshot.sessions.filter(
      (session) => getSessionDurationMinutes(session) >= 420
    );

    addPart(
      answerLongRunningSessions(snapshot),
      longSessions
        .slice(0, 8)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (requestedDay && isDayDateQuestion(normalized)) {
    addPart(answerDayDate(snapshot, requestedDay), sources);
  }

  if (
    requestedDay &&
    (isDayScheduleQuestion(normalized) ||
      isDayFollowUpQuestion(normalized) ||
      requestedDayPart)
  ) {
    addPart(
      answerDaySchedule(requestedDay, snapshot, { dayPart: requestedDayPart }),
      [
        ...snapshot.timeBlocks
          .filter((block) => block.day === requestedDay)
          .filter((block) => blockOverlapsDayPart(block, requestedDayPart))
          .slice(0, 10)
          .map((block) => sourceFor("program_time_block", block, block.label)),
        ...snapshot.sessions
          .filter((session) => session.day === requestedDay)
          .filter((session) => sessionOverlapsDayPart(session, requestedDayPart))
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ]
    );
  }

  if (dayThemeMatch && /\bsessions?\b/.test(normalized)) {
    addPart(
      answerSessionsForDayTheme(snapshot, dayThemeMatch),
      getThemeSources(snapshot, dayThemeMatch)
    );
  }

  if (!wantsTopicSessionDetails && isFilteredSessionQuestion(normalized)) {
    const topicSessions = findSessionsByTopicQuestion(snapshot, normalized);
    addPart(
      answerSessionsByTopic(topicSessions),
      topicSessions
        .slice(0, 8)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (/sponsors?/.test(normalized)) {
    if (/(categor|tiers?|levels?)/.test(normalized)) {
      addPart(
        answerSponsorCategories(snapshot),
        snapshot.sponsorCategories.map((category) =>
          sourceFor("sponsor_category", category, category.name)
        )
      );
    } else if (/featured/.test(normalized)) {
      addPart(
        answerFeaturedSponsors(snapshot),
        getActiveSponsors(snapshot)
          .filter((sponsor) => sponsor.isFeatured === true)
          .map((sponsor) => sourceFor("sponsor", sponsor, sponsor.name))
      );
    } else {
      addPart(
        answerSponsors(snapshot),
        getActiveSponsors(snapshot).map((sponsor) =>
          sourceFor("sponsor", sponsor, sponsor.name)
        )
      );
    }
  }

  if (/partners?/.test(normalized) && !/sponsors?/.test(normalized)) {
    const categoriesById = getCategoryNameById(snapshot);
    addPart(
      answerPartners(snapshot),
      getActiveSponsors(snapshot)
        .filter(
          (sponsor) =>
            normalizeQuestion(categoriesById.get(sponsor.categoryId)) === "partners"
        )
        .map((partner) => sourceFor("sponsor", partner, partner.name))
    );
  }

  const uniqueParts = uniqueValues(parts);

  if (uniqueParts.length < 2) return null;

  return {
    answer: uniqueParts.join("\n\n"),
    sources: uniqueSources(compoundSources),
  };
}

export async function getDirectRecAnswer(
  question,
  { signal, snapshot: providedSnapshot } = {}
) {
  const normalized = normalizeQuestion(question);
  const unpublishedLogisticsTopics = getUnpublishedLogisticsTopics(normalized);
  const wantsProgrammeTradeOffs = isProgrammeTradeOffQuestion(normalized);
  const wantsHistoricalThemeEvolution =
    isHistoricalThemeEvolutionQuestion(normalized);
  const hasPotentialHistoricalScope =
    /\b(previous|past|historical|history|archive|archived|earlier|former|prior)\b/.test(
      normalized
    ) ||
    /\b20\d{2}\b/.test(normalized) ||
    /\brec\s*[-']?\s*\d{2}\b/.test(normalized);
  const hasPotentialMediaRequest = isConferenceMediaQuestion(normalized);
  const hasPotentialReportRequest = isConferenceReportQuestion(normalized);

  if (
    unpublishedLogisticsTopics.length === 0 &&
    !wantsProgrammeTradeOffs &&
    !hasPotentialHistoricalScope &&
    !hasPotentialMediaRequest &&
    !hasPotentialReportRequest &&
    !/(conference|rec|expo|venue|location|visitor|guest|help desk|lost and found|register|registration|date|when|where|theme|focus|sponsor|partner|contact|website|fee|cost|price|capacity|limit|days?|program|programme|agenda|schedule|session|speaker|speakers|presenter|presenters|panelist|panelists|business forum|giz|fcdo|european union|serena|hall|room|lunch|meal|tea|break|exhibition|exhibit|finance|financial|investment|investor|capital|bank|funding|policy|policymaker|government|developer|renewable|energy|beginner|new|implementation|sustainability|technology|technologies|technical|ceremony|opening|closing|start|starts|starting|begin|begins|prepare|preparation|planning|maximize|maximise|cooking|cookstove|solco|biofuel|geothermal|nuclear|productive use|efficiency|wifi|internet|parking|transport|shuttle|accessibility|wheelchair|dress code|attire|breakfast|dinner|charging|prayer|first aid|medical|security|bag policy)/.test(normalized)
  ) {
    return null;
  }

  if (
    isOpenEndedSynthesisQuestion(normalized) &&
    !isProgrammeProgressionQuestion(normalized) &&
    !wantsProgrammeTradeOffs &&
    !wantsHistoricalThemeEvolution &&
    !hasPotentialHistoricalScope &&
    !hasPotentialMediaRequest &&
    !hasPotentialReportRequest
  ) {
    return null;
  }

  const snapshot = providedSnapshot
    ? snapshotToRuntimeData(providedSnapshot)
    : await getRecPublicSnapshot({ signal });
  const conference = snapshot.conference;
  const sources = [sourceFor("conference_overview", conference, conference.title)];
  const hasHistoricalScope = hasHistoricalConferenceScope(normalized, snapshot);

  if (wantsHistoricalThemeEvolution) {
    return answerHistoricalThemeEvolution(normalized, snapshot);
  }

  if (
    hasHistoricalScope ||
    hasPotentialMediaRequest ||
    hasPotentialReportRequest
  ) {
    return answerConferenceEditions(normalized, snapshot);
  }

  const operationalMatches = getOperationalInfoMatches(normalized, snapshot);
  const publishedLogisticsLabels = getPublishedLogisticsLabels(
    operationalMatches
  );
  const unresolvedLogisticsTopics = unpublishedLogisticsTopics.filter(
    (label) => !publishedLogisticsLabels.has(label)
  );
  const mentionedSponsor = findMentionedSponsor(normalized, snapshot.sponsors);
  const requestedDays = extractRequestedDays(normalized);
  const requestedDay = requestedDays[0] || null;
  const requestedDayPart = getRequestedDayPart(normalized);
  const mentionedSession = findMentionedSession(normalized, snapshot.sessions);
  const requestedHall = findRequestedHall(normalized, snapshot);
  const dayThemeMatch = getDayThemeMatch(normalized, snapshot);
  const compoundAnswer = getCompoundDirectAnswer(normalized, snapshot, sources);
  const wantsAllSessionsList = isAllSessionsListQuestion(normalized);
  const topicRecommendationMatches = getTopicRecommendationMatches(
    snapshot,
    normalized
  );
  const wantsTopicRecommendation = isTopicRecommendationQuestion(normalized);
  const wantsTopicSessionDetails =
    wantsTopicRecommendation || isTopicSessionQuestion(normalized);

  if (compoundAnswer) {
    return compoundAnswer;
  }

  if (operationalMatches.length > 0) {
    return {
      answer: answerOperationalInfo(operationalMatches),
      sources: operationalMatches.map(({ item }) =>
        sourceFor("operational_info", item, item.title)
      ),
    };
  }

  if (unresolvedLogisticsTopics.length > 0) {
    return {
      answer: answerUnpublishedLogistics(snapshot, unresolvedLogisticsTopics),
      sources,
    };
  }

  if (wantsProgrammeTradeOffs) {
    return {
      answer: answerProgrammeTradeOffs(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...getProgrammeTradeOffEvidence(snapshot).map((session) =>
          sourceFor("session", session, session.title)
        ),
      ],
    };
  }

  if (isProgrammeProgressionQuestion(normalized)) {
    return {
      answer: answerProgrammeProgression(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...getConferencePreparationSources(snapshot),
      ],
    };
  }

  if (isConferencePreparationQuestion(normalized)) {
    return {
      answer: answerConferencePreparation(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...getConferencePreparationSources(snapshot),
      ],
    };
  }

  if (wantsAllSessionsList || isGenericSessionsOverviewQuestion(normalized)) {
    const overviewSessions = getSessionsForDays(snapshot, requestedDays);
    return {
      answer: answerSessionsOverview(snapshot, requestedDays, {
        includeAll: wantsAllSessionsList || requestedDays.length > 0,
      }),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...overviewSessions
          .slice(
            0,
            wantsAllSessionsList || requestedDays.length > 0
              ? overviewSessions.length
              : 8
          )
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  const asksTechnologyAreas = isTechnologyAreasQuestion(normalized);

  if (asksTechnologyAreas) {
    const areas = getTechnologyDiscussionAreas(snapshot);

    return {
      answer: answerTechnologyDiscussionAreas(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...areas
          .flatMap((area) => area.sessions)
          .slice(0, 10)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  const ceremonyBlocks = findCeremonyBlocks(snapshot, normalized);
  const ceremonyBlock = ceremonyBlocks[0] || null;

  if (ceremonyBlock) {
    return {
      answer: joinMarkdownSections(
        ceremonyBlocks.map((block) => answerCeremonyBlock(snapshot, block))
      ),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...ceremonyBlocks.map((block) =>
          sourceFor("program_time_block", block, block.label)
        ),
      ],
    };
  }

  if (isSpeakerQuestion(normalized)) {
    const speakerSessions = getSessionsForDays(snapshot, requestedDays);

    return {
      answer: answerSpeakersOverview(snapshot, requestedDays),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...speakerSessions
          .slice(0, requestedDays.length > 0 ? speakerSessions.length : 12)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    /\bwhen\b.*\b(conference|rec|expo|event)\b.*\b(start|starts|starting|begin|begins|beginning)\b/.test(
      normalized
    ) ||
    /\b(conference|rec|expo|event)\b.*\b(start|starts|starting|begin|begins|beginning)\b/.test(
      normalized
    ) ||
    /\bactually start\b/.test(normalized)
  ) {
    const firstBlock = findFirstScheduledBlock(snapshot);
    const firstSession = findFirstSession(snapshot);

    return {
      answer: answerConferenceStart(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        firstBlock
          ? sourceFor("program_time_block", firstBlock, firstBlock.label)
          : null,
        firstSession ? sourceFor("session", firstSession, firstSession.title) : null,
      ].filter(Boolean),
    };
  }

  if (mentionedSponsor) {
    return {
      answer: answerSpecificSponsor(mentionedSponsor, snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        sourceFor("sponsor", mentionedSponsor, mentionedSponsor.name),
      ],
    };
  }

  if (mentionedSession && !wantsTopicSessionDetails) {
    return {
      answer: answerSpecificSession(mentionedSession, normalized),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        sourceFor("session", mentionedSession, mentionedSession.title),
      ],
    };
  }

  if (
    /(daily theme|day themes|themes by day|each day.*theme|day.*focus|daily focus)/.test(
      normalized
    )
  ) {
    return {
      answer: answerDailyThemes(snapshot),
      sources,
    };
  }

  if (/theme/.test(normalized) && !/\bsessions?\b/.test(normalized)) {
    return {
      answer: `The theme for ${conference.title} is "${conference.theme}".`,
      sources,
    };
  }

  if (/(contact|phone|email)/.test(normalized)) {
    return {
      answer:
        compact([
          conference.contactPhone ? `Phone: ${conference.contactPhone}` : null,
          conference.contactEmail ? `Email: ${conference.contactEmail}` : null,
        ]).join(". ") || "No public contact information is currently listed.",
      sources,
    };
  }

  if (/(website|site|link|url)/.test(normalized)) {
    return {
      answer: conference.mainWebsiteUrl
        ? `The conference website is ${conference.mainWebsiteUrl}.`
        : "No public website is currently listed.",
      sources,
    };
  }

  if (
    requestedHall &&
    /\b(what|happen|happens|scheduled|schedule|agenda|activity|activities|event|events|in|at)\b/.test(
      normalized
    )
  ) {
    const hallSessions = getHallSessions(snapshot, requestedHall);
    const hallBlocks = getHallTimeBlocks(snapshot, requestedHall);

    return {
      answer: answerScheduleByHall(snapshot, requestedHall),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...hallSessions
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
        ...hallBlocks
          .slice(0, hallSessions.length ? 0 : 6)
          .map((block) => sourceFor("program_time_block", block, block.label)),
      ],
    };
  }

  if (
    !/\bsessions?\b/.test(normalized) &&
    (/(which|what|list|show).*\b(halls?|rooms?|spaces?)\b|\b(halls?|rooms?|spaces?)\b.*\b(used|available|venue|venues|list|which|what)\b/.test(
      normalized
    ))
  ) {
    return {
      answer: answerVenueHalls(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.programs.map((program) =>
          sourceFor("program_overview", program, program.title)
        ),
      ],
    };
  }

  if (/\b(new|beginner|first time|newcomer)\b/.test(normalized)) {
    return {
      answer: answerBeginnerGuidance(snapshot),
      sources,
    };
  }

  if (
    /(finance|financial|investment|investor|capital|bank|funding|fund|business)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|relevant|relation|related|interested)/.test(
      normalized
    )
  ) {
    const rankedSessions = getRankedFinanceSessions(snapshot).map(
      (item) => item.session
    );
    const oneDayOnly = /\b(only have one day|just one day|single day|one day)\b/.test(
      normalized
    );

    return {
      answer: answerFinanceRecommendations(snapshot, { oneDayOnly }),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...rankedSessions
          .slice(0, 6)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    dayThemeMatch &&
    /(attend|care|interested|focus|should|recommend|guide|what should)/.test(
      normalized
    )
  ) {
    const days = getConferenceDays(conference);
    const dayNumber = getDayNumberFromDay(dayThemeMatch, days.indexOf(dayThemeMatch));

    return {
      answer: answerDayThemeAttendance(snapshot, dayThemeMatch),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.sessions
          .filter((session) => session.day === dayNumber)
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    /(policy ?makers?|policymakers?|government|regulator|regulators|ministry|public sector)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|useful|relevant|focus|interested)/.test(
      normalized
    )
  ) {
    const policySessions = findSessionsByTitleParts(snapshot, [
      "sustainable energy development programme",
      "subregional forum",
      "world resource institute",
      "united nations",
      "uganda - european",
    ]);

    return {
      answer: answerPolicyRecommendations(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...policySessions
          .slice(0, 6)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    /(project developer|project developers|developer|developers|renewable energy company|energy company)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|useful|relevant|focus|interested)/.test(
      normalized
    )
  ) {
    const developerSessions = findSessionsByTitleParts(snapshot, [
      "uganda - european",
      "productive use energy",
      "sustainable energy development programme",
      "clean cooking",
      "biofuels",
    ]);

    return {
      answer: answerProjectDeveloperRecommendations(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...developerSessions
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    /(learn|learning|take away|takeaway|gain|expect|benefit|course of)/.test(
      normalized
    )
  ) {
    return {
      answer: answerLearningOutcomes(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.sessions
          .filter((session) => session.theme && !/^tbc$/i.test(session.theme))
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    topicRecommendationMatches.length > 0 &&
    wantsTopicSessionDetails
  ) {
    return {
      answer: topicRecommendationMatches
        .map((match) =>
          answerTopicRecommendation(match, {
            recommendation: wantsTopicRecommendation,
          })
        )
        .join("\n\n"),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...topicRecommendationMatches.flatMap((match) =>
          match.sessions
            .map((session) => sourceFor("session", session, session.title))
        ),
      ],
    };
  }

  if (
    /(overview|summary|summarise|summarize|tell me about|give me).*(program|programme|agenda)|\b(program|programme|agenda)\s+overview\b/.test(
      normalized
    ) ||
    (/\b(program|programme|agenda)\b/.test(normalized) &&
      /(overview|summary|more|about|tell|give|what)/.test(normalized))
  ) {
    return {
      answer: answerProgramOverview(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.programs.map((program) =>
          sourceFor("program_overview", program, program.title)
        ),
      ],
    };
  }

  if (isConferenceOverviewQuestion(normalized)) {
    return {
      answer: isConferenceDeepDiveQuestion(normalized)
        ? answerConferenceDeepDive(snapshot)
        : answerConferenceOverview(snapshot),
      sources,
    };
  }

  if (isExhibitionScheduleQuestion(normalized)) {
    const exhibitionBlocks = snapshot.timeBlocks.filter(
      (block) => block.type === "EXHIBITION"
    );

    return {
      answer: answerTimeBlocksByType(snapshot, "EXHIBITION", "exhibition"),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...exhibitionBlocks.map((block) =>
          sourceFor("program_time_block", block, block.label)
        ),
      ],
    };
  }

  if (/(lunch|meal|tea|break)/.test(normalized)) {
    const breakFilter = /tea/.test(normalized)
      ? "tea"
      : /(lunch|meal)/.test(normalized)
        ? "lunch"
        : "all";
    const matchingBreaks = snapshot.timeBlocks.filter((block) => {
      if (breakFilter === "tea") {
        return block.type === "BREAK" && /tea/i.test(block.label || "");
      }
      if (breakFilter === "lunch") {
        return block.type === "LUNCH" || /lunch/i.test(block.label || "");
      }

      return ["LUNCH", "BREAK"].includes(block.type);
    });

    return {
      answer: answerFilteredBreaks(snapshot, breakFilter),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...matchingBreaks
          .slice(0, 8)
          .map((block) => sourceFor("program_time_block", block, block.label)),
      ],
    };
  }

  if (
    /(how many|number of|duration|how long|days will|days does|days is)/.test(
      normalized
    ) &&
    /(day|days|conference|rec|expo)/.test(normalized)
  ) {
    return {
      answer: answerDaysCount(snapshot),
      sources,
    };
  }

  if (/(morning.*evening|morning to evening|full day|all day|most of the day)/.test(normalized)) {
    const longSessions = snapshot.sessions.filter(
      (session) => getSessionDurationMinutes(session) >= 420
    );

    return {
      answer: answerLongRunningSessions(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...longSessions
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (requestedDay && isDayDateQuestion(normalized)) {
    return {
      answer: answerDayDate(snapshot, requestedDay),
      sources,
    };
  }

  if (
    requestedDay &&
    (isDayScheduleQuestion(normalized) ||
      isDayFollowUpQuestion(normalized) ||
      requestedDayPart)
  ) {
    return {
      answer: answerDaySchedule(requestedDay, snapshot, {
        dayPart: requestedDayPart,
      }),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.timeBlocks
          .filter((block) => block.day === requestedDay)
          .filter((block) => blockOverlapsDayPart(block, requestedDayPart))
          .slice(0, 10)
          .map((block) => sourceFor("program_time_block", block, block.label)),
        ...snapshot.sessions
          .filter((session) => session.day === requestedDay)
          .filter((session) => sessionOverlapsDayPart(session, requestedDayPart))
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (requestedHall && /\bsessions?\b/.test(normalized)) {
    const hallSessions = snapshot.sessions.filter((session) => {
      const venue = normalizeQuestion(session.venueHall || "");
      const hall = normalizeQuestion(requestedHall);
      const shortHall = hall.replace(/\s*\(.*?\)\s*/g, "").trim();
      return venue.includes(hall) || venue.includes(shortHall);
    });

    return {
      answer: answerSessionsByHall(snapshot, requestedHall),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...hallSessions
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (dayThemeMatch && /\bsessions?\b/.test(normalized)) {
    const days = getConferenceDays(conference);
    const dayNumber = getDayNumberFromDay(dayThemeMatch, days.indexOf(dayThemeMatch));

    return {
      answer: answerSessionsForDayTheme(snapshot, dayThemeMatch),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.sessions
          .filter((session) => session.day === dayNumber)
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (isFilteredSessionQuestion(normalized)) {
    const topicSessions = findSessionsByTopicQuestion(snapshot, normalized);
    const topicAnswer = answerSessionsByTopic(topicSessions);

    if (topicAnswer) {
      return {
        answer: topicAnswer,
        sources: [
          sourceFor("conference_overview", conference, conference.title),
          ...topicSessions
            .slice(0, 8)
            .map((session) => sourceFor("session", session, session.title)),
        ],
      };
    }
  }

  if (
    /(are there|any|list|what|which|show|tell me).*\bsessions?\b/.test(
      normalized
    ) &&
    !isFilteredSessionQuestion(normalized)
  ) {
    const overviewSessions = getSessionsForDays(snapshot, requestedDays);
    return {
      answer: answerSessionsOverview(snapshot, requestedDays, {
        includeAll: wantsAllSessionsList || requestedDays.length > 0,
      }),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...overviewSessions
          .slice(
            0,
            wantsAllSessionsList || requestedDays.length > 0
              ? overviewSessions.length
              : 8
          )
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (/(where|venue|location|held|take place)/.test(normalized)) {
    if (/\bwhen\b/.test(normalized)) {
      return {
        answer: answerConferenceDatesAndVenue(snapshot),
        sources,
      };
    }

    return {
      answer: `${conference.title} will take place at ${formatConferenceVenue(conference)}.`,
      sources,
    };
  }

  if (/(register|registration)/.test(normalized)) {
    const hasDeadlineQuestion = /\b(when|deadline|close|closes|closing|end|ends)\b/.test(
      normalized
    );
    const status = conference.registrationOpen
      ? `Registration is currently open for ${conference.title}.`
      : conference.regClosedMessage ||
        `Registration is currently closed for ${conference.title}.`;

    return {
      answer: hasDeadlineQuestion
        ? `${withTerminalPeriod(status)} I could not find a registration deadline in the published conference materials.`
        : withTerminalPeriod(status),
      sources,
    };
  }

  if (/\b(when|date|dates|day|days|start|starts|end|ends|run|runs|running)\b/.test(normalized)) {
    const days = parseJson(conference.days, []);
    const dayText = days
      .map((day) => `${day.label}: ${day.date}${day.theme ? `, ${day.theme}` : ""}`)
      .join("; ");

    return {
      answer: `${conference.title} runs from ${formatConferenceDates(conference)}. ${dayText}`,
      sources,
    };
  }

  if (/(fee|cost|price)/.test(normalized)) {
    const fee = parseJson(conference.registrationFee, {});

    return {
      answer: `The current registration fees are: attendee ${fee.attendee ?? "not listed"}, exhibitor ${fee.exhibitor ?? "not listed"}, sponsor ${fee.sponsor ?? "not listed"}.`,
      sources,
    };
  }

  if (/(capacity|limit|maximum|max|slots?)/.test(normalized)) {
    const limits = parseJson(conference.maxLimits, {});

    return {
      answer: `The listed capacity limits are: attendees ${limits.attendee ?? conference.maxAttendees ?? "not listed"}, exhibitors ${limits.exhibitor ?? "not listed"}, sponsors ${limits.sponsor ?? "not listed"}.`,
      sources,
    };
  }

  if (/sponsor/.test(normalized)) {
    if (/(categor|tiers?|levels?)/.test(normalized)) {
      const activeCategories = snapshot.sponsorCategories.filter(
        (category) => category.isActive !== false
      );

      return {
        answer: answerSponsorCategories(snapshot),
        sources: activeCategories.map((category) =>
          sourceFor("sponsor_category", category, category.name)
        ),
      };
    }

    if (/featured/.test(normalized)) {
      return {
        answer: answerFeaturedSponsors(snapshot),
        sources: getActiveSponsors(snapshot).map((sponsor) =>
          sourceFor("sponsor", sponsor, sponsor.name)
        ),
      };
    }

    return {
      answer: answerSponsors(snapshot),
      sources: getActiveSponsors(snapshot).map((sponsor) =>
        sourceFor("sponsor", sponsor, sponsor.name)
      ),
    };
  }

  if (/partners?/.test(normalized)) {
    const categoriesById = getCategoryNameById(snapshot);
    const partners = getActiveSponsors(snapshot).filter(
      (sponsor) => normalizeQuestion(categoriesById.get(sponsor.categoryId)) === "partners"
    );

    return {
      answer: answerPartners(snapshot),
      sources: partners.map((partner) =>
        sourceFor("sponsor", partner, partner.name)
      ),
    };
  }

  if (isUnlistedOfficialAvailabilityQuestion(normalized)) {
    return {
      answer: answerUnlistedOfficialAvailability(snapshot),
      sources,
    };
  }

  return null;
}
