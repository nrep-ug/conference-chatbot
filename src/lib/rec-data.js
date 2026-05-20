import {
  HR_DATABASE_ID,
  fetchRecSnapshotFromAppwrite,
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

export async function getRecPublicSnapshot({ signal, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = getCache();
    if (cached) return cached;
  }

  if (!forceRefresh && REC_SNAPSHOT_ENABLED) {
    try {
      const generated = snapshotToRuntimeData(await readGeneratedRecSnapshot());
      setCache(generated);
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

function answerConferenceDeepDive(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayThemes = days
    .map((day, index) => {
      const dayNumber = getDayNumberFromDay(day, index);
      return `Day ${dayNumber} (${day.date}): ${day.theme}`;
    })
    .join("; ");
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

  return compact([
    `${snapshot.conference.title} (${snapshot.conference.shortName}) is the active REC conference for ${snapshot.conference.year}.`,
    `It runs from ${formatConferenceDates(snapshot.conference)} at ${snapshot.conference.venue}, ${snapshot.conference.location}.`,
    `Theme: "${snapshot.conference.theme}".`,
    dayThemes ? `Daily focus areas: ${dayThemes}.` : null,
    `The published programme currently has ${snapshot.sessions.length} listed sessions and ${snapshot.timeBlocks.length} time blocks, including sessions, exhibitions, breaks, lunch, and ceremonies.`,
    halls.length ? `Main spaces include ${halls.join(", ")}.` : null,
    technologyAreas.length
      ? `Technology and sector areas appearing in the programme include ${technologyAreas.join(", ")}.`
      : null,
    sponsors.length ? `Listed sponsors and partners include ${sponsors.join(", ")}.` : null,
    withTerminalPeriod(registrationStatus),
    snapshot.conference.mainWebsiteUrl ? `Website: ${snapshot.conference.mainWebsiteUrl}.` : null,
  ]).join(" ");
}

function answerConferenceDatesAndVenue(snapshot) {
  return `${snapshot.conference.title} will run from ${formatConferenceDates(snapshot.conference)} at ${snapshot.conference.venue}, ${snapshot.conference.location}.`;
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

  return compact([
    `${snapshot.conference.title} starts on Day 1${firstDay?.date ? ` (${firstDay.date})` : ""}.`,
    firstBlock
      ? `The earliest listed programme block is ${firstBlock.label}, from ${formatTime(firstBlock.startTime)} to ${formatTime(firstBlock.endTime)} Kampala time${firstBlock.venueHalls?.length ? ` at ${firstBlock.venueHalls.join(", ")}` : ""}.`
      : null,
    firstSession
      ? `The first listed sessions begin at ${formatTime(firstSession.startTime)} Kampala time.`
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

  return `The listed conference spaces are: ${halls.join(", ")}.`;
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
    )
    .join("; ");

  return `Sessions listed for ${hall}: ${summary}.`;
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
    )
    .join("; ");

  return `Scheduled items listed for ${hall}: ${summary}.`;
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
    )
    .join("; ");

  return `That topic maps to Day ${dayNumber}: ${day.theme}. Listed sessions for that day are: ${summary}.`;
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
    )
    .join("; ");

  return `Matching published sessions: ${summary}.`;
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
    /\b(tell me more|more|overview|summary|summarise|summarize|in depth|in-depth|detailed|details|view)\b.*\bsessions?\b/.test(
      normalized
    ) ||
    /\bsessions?\b.*\b(overview|summary|summarise|summarize|in depth|in-depth|detailed|details|view)\b/.test(
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

function isConferenceOverviewQuestion(normalized) {
  return (
    isConferenceDeepDiveQuestion(normalized) ||
    /\btell me more\b/.test(normalized) ||
    /(overview|summary|summarise|summarize|about|describe|introduce|what is).*(conference|rec|expo)\b/.test(
      normalized
    ) ||
    /\b(conference|rec26|rec|expo)\s+overview\b/.test(normalized)
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

  return `If you can only attend one day for finance or investment, I would choose Day ${bestDay}${themeText}. Relevant published sessions that day include: ${formatRecommendedSessions(bestDaySessions)}.`;
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
  return sessions
    .map((session) =>
      compact([
        session.title,
        `Day ${session.day}`,
        session.venueHall,
        session.startTime && session.toTime
          ? `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`
          : null,
      ]).join(", ")
    )
    .join("; ");
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

  return [
    "For policymakers or government participants, I would start with Day 1 because its focus is Renewable Energy Policy & Investment.",
    `Relevant published sessions include: ${formatRecommendedSessions(sessions.slice(0, 5))}.`,
    "I would also consider the Uganda - European (EU) Business Forum because it connects policy dialogue with investment partnerships and green industrialisation.",
  ].join(" ");
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

  return [
    "For project developers, I would prioritize sessions that connect project pipelines, investment, implementation, and productive use.",
    `Relevant published sessions include: ${formatRecommendedSessions(sessions.slice(0, 6))}.`,
    "The Uganda - European (EU) Business Forum is especially relevant because it explicitly covers investors, developers, partnerships, B2B meetings, deal-making, and de-risking.",
  ].join(" ");
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

function answerTopicRecommendation(match) {
  return [
    `For ${match.profile.label}, I would prioritize: ${formatRecommendedSessions(match.sessions)}.`,
    match.profile.rationale,
  ].join(" ");
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
    })
    .join("; ");

  return `Based on the published programme, renewable-energy technology areas likely to be discussed include ${summary}. Some session details are still marked TBC, so this reflects the current published data.`;
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

function findCeremonyBlock(snapshot, normalized) {
  const ceremonyType = /\bclosing ceremony\b|\bclosing\b/.test(normalized)
    ? "closing"
    : /\bopening ceremony\b|\bopening\b/.test(normalized)
      ? "opening"
      : null;

  if (!ceremonyType) return null;

  return snapshot.timeBlocks.find((block) => {
    const label = normalizeQuestion(block.label || "");
    const type = normalizeQuestion(block.type || "");

    return (
      type === "ceremony" &&
      label.includes(ceremonyType) &&
      label.includes("ceremony")
    );
  });
}

function answerCeremonyBlock(snapshot, block) {
  const days = getConferenceDays(snapshot.conference);
  const day = days[block.day - 1];
  const dateText = day?.date ? ` (${day.date})` : "";
  const venueText = block.venueHalls?.length
    ? ` at ${block.venueHalls.join(", ")}`
    : "";

  return `${block.label} is scheduled for Day ${block.day}${dateText}, from ${formatTime(block.startTime)} to ${formatTime(block.endTime)} Kampala time${venueText}.`;
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
    )
    .join("; ");

  const label =
    filter === "tea"
      ? "tea breaks"
      : filter === "lunch"
        ? "lunch breaks"
        : "listed breaks";

  return `The programme includes these ${label}: ${summary}.`;
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
    )
    .join("; ");

  return `Yes. The listed ${label} blocks are: ${summary}.`;
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
    )
    .join("; ");

  return `The sessions that run for most of the day are: ${summary}.`;
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

  return `The active sponsor categories are: ${categories.map((category) => category.name).join(", ")}.`;
}

function answerPartners(snapshot) {
  const categoriesById = getCategoryNameById(snapshot);
  const partners = getActiveSponsors(snapshot).filter(
    (sponsor) => normalizeQuestion(categoriesById.get(sponsor.categoryId)) === "partners"
  );

  if (partners.length === 0) {
    return "No active partners are currently listed for the conference.";
  }

  return `The listed partners are: ${partners
    .map((partner) =>
      partner.siteUrl ? `${partner.name} (${partner.siteUrl})` : partner.name
    )
    .join(", ")}.`;
}

function answerFeaturedSponsors(snapshot) {
  const categoriesById = getCategoryNameById(snapshot);
  const featured = getActiveSponsors(snapshot).filter(
    (sponsor) => sponsor.isFeatured === true
  );

  if (featured.length === 0) {
    return "No sponsors are currently marked as featured in the published conference data.";
  }

  return `The featured sponsors are: ${featured
    .map((sponsor) => {
      const category = categoriesById.get(sponsor.categoryId);
      return category ? `${sponsor.name} (${category})` : sponsor.name;
    })
    .join(", ")}.`;
}

function answerBeginnerGuidance(snapshot) {
  const days = getConferenceDays(snapshot.conference);
  const dayText = days
    .map((day, index) => {
      const dayNumber = getDayNumberFromDay(day, index);
      return `Day ${dayNumber}: ${day.theme}`;
    })
    .join("; ");

  return [
    "If you are new to renewable energy, I would use the conference structure as your guide.",
    `Start with the daily focus areas: ${dayText}.`,
    "Day 1 gives the policy and investment foundation, Day 2 introduces technology and innovation, Day 3 moves into implementation and sustainability, and Day 4 focuses on impact, scale, and regional leadership.",
  ].join(" ");
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

  return [
    `If you care about ${day.theme}, focus on Day ${dayNumber}.`,
    `Relevant listed sessions are: ${formatRecommendedSessions(sessions)}.`,
  ].join(" ");
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
  const requestedDay = extractRequestedDay(normalized);
  const requestedHall = findRequestedHall(normalized, snapshot);
  const mentionedSession = findMentionedSession(normalized, snapshot.sessions);
  const ceremonyBlock = findCeremonyBlock(snapshot, normalized);
  const topicRecommendationMatches = getTopicRecommendationMatches(
    snapshot,
    normalized
  );
  const wantsTopicRecommendation = isTopicRecommendationQuestion(normalized);
  const asksConferenceStart =
    /\bwhen\b.*\b(conference|rec|expo|event)\b.*\b(start|starts|starting|begin|begins|beginning)\b/.test(
      normalized
    ) ||
    /\b(conference|rec|expo|event)\b.*\b(start|starts|starting|begin|begins|beginning)\b/.test(
      normalized
    ) ||
    /\bactually start\b/.test(normalized);
  const asksTechnologyAreas = isTechnologyAreasQuestion(normalized);
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

  if (wantsConferenceOverview && !wantsProgramOverview) {
    addPart(
      isConferenceDeepDiveQuestion(normalized)
        ? answerConferenceDeepDive(snapshot)
        : answerConferenceOverview(snapshot),
      sources
    );
  }

  if (isGenericSessionsOverviewQuestion(normalized)) {
    addPart(
      answerSessionsOverview(snapshot, requestedDay),
      snapshot.sessions
        .filter((session) => !requestedDay || session.day === requestedDay)
        .slice(0, 8)
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

  if (
    !asksConferenceStart &&
    !ceremonyBlock &&
    !requestedHall &&
    (!mentionedSession || /\b(conference|rec|expo|event)\b/.test(normalized)) &&
    (/\b(date|dates|where|venue|location|take place|held)\b/.test(normalized) ||
      (/\bwhen\b/.test(normalized) &&
        /\b(conference|rec|expo|event|it)\b/.test(normalized) &&
        !/\b(lunch|meal|tea|break|sessions?|forum)\b/.test(normalized)))
  ) {
    addPart(answerConferenceDatesAndVenue(snapshot), sources);
  }

  if (
    mentionedSession &&
    /\b(when|where|venue|time|schedule|details?|about|tell|sessions?|forum)\b/.test(
      normalized
    )
  ) {
    addPart(answerSpecificSession(mentionedSession, normalized), [
      sourceFor("session", mentionedSession, mentionedSession.title),
    ]);
  }

  if (ceremonyBlock) {
    addPart(answerCeremonyBlock(snapshot, ceremonyBlock), [
      sourceFor("program_time_block", ceremonyBlock, ceremonyBlock.label),
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

  if (wantsTopicRecommendation) {
    for (const topicMatch of topicRecommendationMatches) {
      addPart(
        answerTopicRecommendation(topicMatch),
        topicMatch.sessions
          .slice(0, 6)
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

  if (/(exhibition|exhibit|expo block|expo area)/.test(normalized)) {
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

  if (requestedDay && isDayScheduleQuestion(normalized)) {
    addPart(
      answerDaySchedule(requestedDay, snapshot),
      snapshot.sessions
        .filter((session) => session.day === requestedDay)
        .slice(0, 8)
        .map((session) => sourceFor("session", session, session.title))
    );
  }

  if (dayThemeMatch && /\bsessions?\b/.test(normalized)) {
    addPart(
      answerSessionsForDayTheme(snapshot, dayThemeMatch),
      getThemeSources(snapshot, dayThemeMatch)
    );
  }

  if (!wantsTopicRecommendation && isFilteredSessionQuestion(normalized)) {
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
        snapshot.sponsors.map((sponsor) =>
          sourceFor("sponsor", sponsor, sponsor.name)
        )
      );
    } else {
      addPart(
        answerSponsors(snapshot),
        snapshot.sponsors.map((sponsor) =>
          sourceFor("sponsor", sponsor, sponsor.name)
        )
      );
    }
  }

  if (/partners?/.test(normalized)) {
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

export async function getDirectRecAnswer(question, { signal } = {}) {
  const normalized = normalizeQuestion(question);

  if (
    !/(conference|rec|expo|venue|location|register|registration|date|when|where|theme|focus|sponsor|partner|contact|website|fee|cost|price|capacity|limit|days?|program|programme|agenda|schedule|session|business forum|giz|fcdo|european union|serena|hall|room|lunch|meal|tea|break|exhibition|exhibit|finance|financial|investment|investor|capital|bank|funding|policy|policymaker|government|developer|renewable|energy|beginner|new|implementation|sustainability|technology|technologies|technical|ceremony|opening|closing|start|starts|starting|begin|begins|cooking|cookstove|solco|biofuel|geothermal|nuclear|productive use|efficiency)/.test(
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
  const requestedHall = findRequestedHall(normalized, snapshot);
  const dayThemeMatch = getDayThemeMatch(normalized, snapshot);
  const compoundAnswer = getCompoundDirectAnswer(normalized, snapshot, sources);

  if (compoundAnswer) {
    return compoundAnswer;
  }

  if (isGenericSessionsOverviewQuestion(normalized)) {
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

  const ceremonyBlock = findCeremonyBlock(snapshot, normalized);

  if (ceremonyBlock) {
    return {
      answer: answerCeremonyBlock(snapshot, ceremonyBlock),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        sourceFor("program_time_block", ceremonyBlock, ceremonyBlock.label),
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

  const topicRecommendationMatches = getTopicRecommendationMatches(
    snapshot,
    normalized
  );

  if (
    topicRecommendationMatches.length > 0 &&
    isTopicRecommendationQuestion(normalized)
  ) {
    return {
      answer: topicRecommendationMatches
        .map((match) => answerTopicRecommendation(match))
        .join(" "),
      sources: [
        sourceFor("conference_overview", conference, conference.title),
        ...topicRecommendationMatches.flatMap((match) =>
          match.sessions
            .slice(0, 6)
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

  if (/(exhibition|exhibit|expo block|expo area)/.test(normalized)) {
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

  if (requestedDay && isDayScheduleQuestion(normalized)) {
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
    if (/\bwhen\b/.test(normalized)) {
      return {
        answer: answerConferenceDatesAndVenue(snapshot),
        sources,
      };
    }

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
      return {
        answer: answerSponsorCategories(snapshot),
        sources: [
          ...sources,
          ...snapshot.sponsorCategories.map((category) =>
            sourceFor("sponsor_category", category, category.name)
          ),
        ],
      };
    }

    if (/featured/.test(normalized)) {
      return {
        answer: answerFeaturedSponsors(snapshot),
        sources: [
          ...sources,
          ...snapshot.sponsors.map((sponsor) =>
            sourceFor("sponsor", sponsor, sponsor.name)
          ),
        ],
      };
    }

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

  if (/partners?/.test(normalized)) {
    const categoriesById = getCategoryNameById(snapshot);
    const partners = getActiveSponsors(snapshot).filter(
      (sponsor) => normalizeQuestion(categoriesById.get(sponsor.categoryId)) === "partners"
    );

    return {
      answer: answerPartners(snapshot),
      sources: [
        ...sources,
        ...partners.map((partner) => sourceFor("sponsor", partner, partner.name)),
      ],
    };
  }

  return null;
}
