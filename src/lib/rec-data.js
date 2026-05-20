import { Query, listAllRows, listRows } from "./appwrite.js";

const HR_DATABASE_ID = process.env.APPWRITE_DATABASE_ID || "66bcc8760033a24883f6";
const REC_TABLES = {
  conferences: process.env.APPWRITE_REC_CONFERENCES_TABLE_ID || "6863ae070028061694f1",
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
const REC_DATA_CACHE_TTL_MS = readInteger("REC_DATA_CACHE_TTL_MS", 5 * 60 * 1000);
let cachedSnapshot = null;

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function sourceFor(type, row, label) {
  return {
    source: label,
    sourceType: type,
    tableId: row?.$tableId,
    rowId: row?.$id,
    score: 1,
  };
}

function getCache() {
  if (
    cachedSnapshot &&
    Date.now() - cachedSnapshot.createdAt < REC_DATA_CACHE_TTL_MS
  ) {
    return cachedSnapshot.data;
  }

  return null;
}

function setCache(data) {
  cachedSnapshot = {
    createdAt: Date.now(),
    data,
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

export async function getRecPublicSnapshot({ signal, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = getCache();
    if (cached) return cached;
  }

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

  const data = {
    conference,
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
  };

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
        `Venue: ${conference.venue}, ${conference.location}`,
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
      session.preamble ? `Details: ${stripHtml(session.preamble)}` : null,
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

export function buildRecDocuments(snapshot) {
  return [
    ...buildConferenceDocuments(snapshot.conference),
    ...buildProgramDocuments(snapshot.programs),
    ...buildTimeBlockDocuments(snapshot.timeBlocks),
    ...buildSessionDocuments(snapshot.sessions),
    ...buildSponsorDocuments(snapshot.sponsorCategories, snapshot.sponsors),
  ].map((document, index) => ({
    id: `${document.sourceType}:${document.row?.$id || index}:${index}`,
    text: document.text,
    payload: {
      source: document.title || document.sourceType,
      sourceType: document.sourceType,
      databaseId: HR_DATABASE_ID,
      tableId: document.row?.$tableId,
      rowId: document.row?.$id,
      conferenceId: snapshot.conference.$id,
      year: snapshot.conference.year,
      title: document.title,
      text: document.text,
      updatedAt: document.row?.updatedAt || document.row?.$updatedAt,
    },
  }));
}

function answerSponsors(snapshot) {
  const activeSponsors = snapshot.sponsors
    .filter((sponsor) => sponsor.isActive !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

  if (activeSponsors.length === 0) {
    return "No active sponsors are currently listed for the conference.";
  }

  const categoriesById = new Map(
    snapshot.sponsorCategories.map((category) => [category.$id, category.name])
  );
  const sponsorList = activeSponsors
    .map((sponsor) => {
      const category = categoriesById.get(sponsor.categoryId);
      return category ? `${sponsor.name} (${category})` : sponsor.name;
    })
    .join(", ");

  return `The listed sponsors are: ${sponsorList}.`;
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
  const parts = [
    `${sponsor.name} is listed as a sponsor for ${snapshot.conference.title}.`,
  ];

  if (category?.name) {
    parts.push(`Category: ${category.name}.`);
  }

  if (sponsor.description) {
    parts.push(stripHtml(sponsor.description));
  }

  if (sponsor.siteUrl) {
    parts.push(`Website: ${sponsor.siteUrl}.`);
  }

  return parts.join(" ");
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
    return compact([
      `${session.title} is scheduled in ${session.venueHall}.`,
      `Day ${session.day}.`,
      session.startTime && session.toTime
        ? `Time: ${formatTime(session.startTime)} to ${formatTime(session.toTime)}.`
        : null,
    ]).join(" ");
  }

  return compact([
    `${session.title} is scheduled for Day ${session.day}.`,
    session.startTime && session.toTime
      ? `Time: ${formatTime(session.startTime)} to ${formatTime(session.toTime)}.`
      : null,
    session.venueHall ? `Venue: ${session.venueHall}.` : null,
    session.theme ? `Theme: ${session.theme}.` : null,
    session.preamble ? truncateText(stripHtml(session.preamble)) : null,
  ]).join(" ");
}

function extractRequestedDay(normalized) {
  const numericMatch = normalized.match(/\bday\s*(\d+)\b/);
  if (numericMatch) return Number.parseInt(numericMatch[1], 10);

  const wordDays = {
    one: 1,
    first: 1,
    two: 2,
    second: 2,
    three: 3,
    third: 3,
    four: 4,
    fourth: 4,
  };
  const wordMatch = normalized.match(/\bday\s+(one|first|two|second|three|third|four|fourth)\b/);

  return wordMatch ? wordDays[wordMatch[1]] : null;
}

function answerDaySchedule(day, snapshot) {
  const days = parseJson(snapshot.conference.days, []);
  const dayInfo = days[day - 1];
  const sessions = snapshot.sessions
    .filter((session) => session.day === day)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const timeBlocks = snapshot.timeBlocks
    .filter((block) => block.day === day)
    .sort((a, b) => (a.startMinutes || 0) - (b.startMinutes || 0));

  if (!dayInfo && sessions.length === 0 && timeBlocks.length === 0) {
    return `I could not find schedule information for Day ${day} in the conference materials.`;
  }

  const sessionSummary = sessions
    .slice(0, 8)
    .map((session) =>
      compact([
        formatTime(session.startTime),
        session.title,
        session.venueHall ? `at ${session.venueHall}` : null,
      ]).join(" ")
    )
    .join("; ");
  const blockSummary = timeBlocks
    .slice(0, 5)
    .map((block) =>
      compact([
        `${formatTime(block.startTime)}-${formatTime(block.endTime)}`,
        block.label,
        block.type ? `(${block.type})` : null,
      ]).join(" ")
    )
    .join("; ");

  return compact([
    `Day ${day}${dayInfo?.date ? ` (${dayInfo.date})` : ""}${dayInfo?.theme ? ` focuses on ${dayInfo.theme}` : ""}.`,
    blockSummary ? `Main blocks: ${blockSummary}.` : null,
    sessionSummary ? `Sessions include: ${sessionSummary}.` : null,
  ]).join(" ");
}

function getConferenceDays(conference) {
  return parseJson(conference.days, []);
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
    })
    .join("; ");

  return `${snapshot.conference.title} runs for ${dayCount} days, from ${formatConferenceDates(snapshot.conference)}. The daily focus areas are: ${focusAreas}.`;
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

  return [
    `Across the four days of ${snapshot.conference.shortName || snapshot.conference.title}, you can expect a progression from policy and investment into technology, implementation, and regional scale-up.`,
    withTerminalPeriod(daySummaries.join("; ")),
    "In practical terms, the programme should help you understand renewable-energy policy, investment pathways, technology options, delivery models, sustainability issues, and how projects can scale in Uganda and the region.",
  ].join(" ");
}

function answerConferenceOverview(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayThemes = days
    .map((day, index) => {
      const dayNumber =
        day.label.match(/Day\s+(\d+)/i)?.[1] || String(index + 1);
      return `Day ${dayNumber}: ${day.theme}`;
    })
    .join("; ");

  return compact([
    `${snapshot.conference.title} (${snapshot.conference.shortName}) is Uganda's premier renewable energy conference for ${snapshot.conference.year}.`,
    `It will run from ${formatConferenceDates(snapshot.conference)} at ${snapshot.conference.venue}, ${snapshot.conference.location}.`,
    `The conference theme is "${snapshot.conference.theme}".`,
    dayThemes ? `The four daily focus areas are ${dayThemes}.` : null,
    `The active programme currently lists ${snapshot.sessions.length} sessions and ${snapshot.timeBlocks.length} time blocks, including conference sessions, exhibitions, tea breaks, and lunch breaks.`,
    snapshot.conference.mainWebsiteUrl
      ? `Website: ${snapshot.conference.mainWebsiteUrl}.`
      : null,
  ]).join(" ");
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
    })
    .join("; ");

  return `The daily themes are: ${dailyThemes}.`;
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
    })
    .join("; ");

  return compact([
    `${snapshot.conference.shortName || snapshot.conference.title} is a ${days.length || program?.daysCount || ""}-day programme at ${snapshot.conference.venue}, ${snapshot.conference.location}.`,
    `Conference theme: ${snapshot.conference.theme}.`,
    daySummary ? `Daily focus: ${daySummary}.` : null,
    `The published data currently lists ${snapshot.sessions.length} programme sessions and ${snapshot.timeBlocks.length} time blocks.`,
    sessionThemes.length ? `Session themes include ${sessionThemes.join("; ")}.` : null,
    halls.length ? `Venue halls include ${halls.join(", ")}.` : null,
  ]).join(" ");
}

function answerSessionsOverview(snapshot, requestedDay) {
  const sessions = snapshot.sessions
    .filter((session) => !requestedDay || session.day === requestedDay)
    .sort((a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime));

  if (sessions.length === 0) {
    return requestedDay
      ? `I could not find sessions listed for Day ${requestedDay}.`
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
      const titles = daySessions
        .slice(0, 4)
        .map((session) =>
          compact([
            session.title,
            session.venueHall ? `(${session.venueHall})` : null,
          ]).join(" ")
        )
        .join("; ");
      const remaining = daySessions.length > 4 ? `, plus ${daySessions.length - 4} more` : "";

      return `Day ${day}: ${titles}${remaining}`;
    })
    .join(". ");

  const prefix = requestedDay
    ? `Yes. I found ${sessions.length} listed session${sessions.length === 1 ? "" : "s"} for Day ${requestedDay}.`
    : `Yes. I found ${sessions.length} listed programme session${sessions.length === 1 ? "" : "s"} across the active conference.`;

  return `${prefix} ${daySummaries}.`;
}

function isFilteredSessionQuestion(normalized) {
  if (!/\bsessions?\b/.test(normalized)) return false;

  return (
    /\bsessions?\b.*\b(about|related|connected|relevant|involving|mention|mentions|cover|covering|focused|focus|for|under)\b/.test(
      normalized
    ) ||
    /\b(about|related|connected|relevant|involving|mention|mentions|cover|covering|focused|focus|for|under)\b.*\bsessions?\b/.test(
      normalized
    )
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
      title: session.title,
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

function answerFinanceRecommendations(snapshot) {
  const financeKeywords = [
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
  const ranked = snapshot.sessions
    .map((session) => ({
      session,
      score: scoreSessionForKeywords(session, financeKeywords),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.session);
  const groups = groupRecommendedSessions(ranked).slice(0, 4);

  if (groups.length === 0) {
    return "I could not find sessions specifically related to finance or investment in the published programme.";
  }

  const recommendations = groups
    .map((group, index) => {
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

      return `${index + 1}. ${group.title}: ${schedule}. Why: ${rationale}`;
    })
    .join(" ");

  return `For someone in finance, I would prioritize these published REC26 & EXPO sessions: ${recommendations}`;
}

function answerMealBreaks(snapshot) {
  const breaks = snapshot.timeBlocks
    .filter((block) => ["LUNCH", "BREAK"].includes(block.type))
    .sort((a, b) => a.day - b.day || (a.startMinutes || 0) - (b.startMinutes || 0));

  if (breaks.length === 0) {
    return "I could not find lunch or break information in the conference materials.";
  }

  const summary = breaks
    .map((block) =>
      compact([
        `Day ${block.day}`,
        block.label,
        `${formatTime(block.startTime)} to ${formatTime(block.endTime)}`,
      ]).join(": ")
    )
    .join("; ");

  return `The programme includes these listed breaks: ${summary}.`;
}

export async function getDirectRecAnswer(question, { signal } = {}) {
  const normalized = normalizeQuestion(question);

  if (
    !/(conference|rec|expo|venue|location|register|registration|date|when|where|theme|sponsor|contact|website|fee|cost|price|capacity|limit|days?|program|programme|agenda|schedule|session|business forum|giz|fcdo|european union|serena|hall|room|lunch|meal|tea|break|finance|financial|investment|investor|capital|bank|funding)/.test(
      normalized
    )
  ) {
    return null;
  }

  const snapshot = await getRecPublicSnapshot({ signal });
  const conference = snapshot.conference;
  const sources = [sourceFor("conference_overview", conference, conference.title)];
  const mentionedSponsor = findMentionedSponsor(normalized, snapshot.sponsors);
  const requestedDay = extractRequestedDay(normalized);
  const mentionedSession = findMentionedSession(normalized, snapshot.sessions);

  if (mentionedSponsor) {
    return {
      answer: answerSpecificSponsor(mentionedSponsor, snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        sourceFor("sponsor", mentionedSponsor, mentionedSponsor.name),
      ],
    };
  }

  if (mentionedSession) {
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

  if (
    /(finance|financial|investment|investor|capital|bank|funding|fund|business)/.test(
      normalized
    ) &&
    /(recommend|which|what|attend|session|sessions|relevant|relation|related|interested)/.test(
      normalized
    )
  ) {
    const rankedSessions = snapshot.sessions
      .map((session) => ({
        session,
        score: scoreSessionForKeywords(session, [
          "finance",
          "financier",
          "financiers",
          "financial",
          "investment",
          "investor",
          "investors",
          "capital",
          "bank",
          "business",
          "fund",
          "funding",
          "guarantee",
          "guarantees",
          "de-risking",
          "deal",
        ]),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.session);

    return {
      answer: answerFinanceRecommendations(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...rankedSessions
          .slice(0, 6)
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
    /(tell me more|overview|summary|summarise|summarize|about|describe|introduce|what is).*(conference|rec|expo)|\b(conference|rec26|rec|expo)\s+overview\b/.test(
      normalized
    )
  ) {
    return {
      answer: answerConferenceOverview(snapshot),
      sources,
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

  if (/(lunch|meal|tea|break)/.test(normalized)) {
    return {
      answer: answerMealBreaks(snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.timeBlocks
          .filter((block) => ["LUNCH", "BREAK"].includes(block.type))
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

  if (
    requestedDay &&
    /(what|happen|agenda|schedule|session|program|programme|activity|event|day)/.test(
      normalized
    )
  ) {
    return {
      answer: answerDaySchedule(requestedDay, snapshot),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.sessions
          .filter((session) => session.day === requestedDay)
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (
    /(are there|any|list|what|which|show|tell me).*\bsessions?\b/.test(
      normalized
    ) &&
    !isFilteredSessionQuestion(normalized)
  ) {
    return {
      answer: answerSessionsOverview(snapshot, requestedDay),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...snapshot.sessions
          .filter((session) => !requestedDay || session.day === requestedDay)
          .slice(0, 8)
          .map((session) => sourceFor("session", session, session.title)),
      ],
    };
  }

  if (/(where|venue|location|held|take place)/.test(normalized)) {
    return {
      answer: `${conference.title} will take place at ${conference.venue}, ${conference.location}.`,
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
        : status,
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

  if (/theme/.test(normalized)) {
    return {
      answer: `The theme for ${conference.title} is "${conference.theme}".`,
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
    return {
      answer: answerSponsors(snapshot),
      sources: [
        ...sources,
        ...snapshot.sponsors.map((sponsor) =>
          sourceFor("sponsor", sponsor, sponsor.name)
        ),
      ],
    };
  }

  if (/(contact|phone|email)/.test(normalized)) {
    return {
      answer: compact([
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

  return null;
}
