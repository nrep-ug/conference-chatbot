import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { listAllRows } from "./appwrite.js";
import { getConferenceOperationalInfo } from "./conference-knowledge.js";

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
  mediaItems:
    process.env.APPWRITE_REC_MEDIA_ITEMS_TABLE_ID || "rec_media_items",
  reports:
    process.env.APPWRITE_REC_CONFERENCE_REPORTS_TABLE_ID ||
    "rec_conference_reports",
};

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");
const SNAPSHOT_JSON_PATH = path.join(GENERATED_DIR, "rec-current.json");
const SNAPSHOT_MD_PATH = path.join(GENERATED_DIR, "rec-current.md");
export const REC_SNAPSHOT_SCHEMA_VERSION = "3.1";
const SUPPORTED_GENERATED_SCHEMA_VERSIONS = new Set(["2.0", "3.0", "3.1"]);

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

export function normalizeSpeakerText(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeSpeakerText).filter(Boolean).join("; ");
  }

  if (typeof value !== "string") {
    return stripHtml(value);
  }

  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return normalizeSpeakerText(parsed);
    }
  } catch {
    // Speaker fields are usually plain text or HTML, not JSON.
  }

  return stripHtml(
    trimmed
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/(?:li|p|div|h[1-6])\s*>/gi, "; ")
      .replace(/\r?\n+/g, "; ")
  )
    .replace(/(?:\s*;\s*){2,}/g, "; ")
    .replace(/^\s*;\s*|\s*;\s*$/g, "")
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

function formatConferenceVenue(conference) {
  const parts = compact([conference.venue, conference.location])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set();

  return parts
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

function dateOnly(value) {
  if (!value) return "";

  return String(value).slice(0, 10);
}

function isDraft(row) {
  return String(row?.status || "").trim().toUpperCase() === "DRAFT";
}

function rowId(row) {
  return row?.$id || row?.id || "";
}

function overlaps(startA, endA, startB, endB) {
  const aStart = Date.parse(startA || "");
  const aEnd = Date.parse(endA || "");
  const bStart = Date.parse(startB || "");
  const bEnd = Date.parse(endB || "");

  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false;

  return aStart < bEnd && aEnd > bStart;
}

function sessionBelongsToAllowedBlock(session, allowedBlocks) {
  const allowedIds = new Set(allowedBlocks.map(rowId).filter(Boolean));
  const linkedIds = Array.isArray(session.timeBlockIds)
    ? session.timeBlockIds.filter(Boolean)
    : [];

  if (linkedIds.length > 0) {
    return linkedIds.some((id) => allowedIds.has(id));
  }

  return allowedBlocks.some((block) => {
    if (Number(block.day) !== Number(session.day)) return false;

    const halls = Array.isArray(block.venueHalls) ? block.venueHalls : [];
    const hallMatches = halls.length === 0 || halls.includes(session.venueHall);

    return (
      hallMatches &&
      overlaps(
        session.startTime,
        session.toTime,
        block.startTime,
        block.endTime
      )
    );
  });
}

function sanitizeConferenceBundle(snapshot) {
  const sourcePrograms = snapshot.programs || [];
  const programs = sourcePrograms.filter((program) => !isDraft(program));
  const programIds = new Set(programs.map(rowId).filter(Boolean));
  const belongsToPublishedProgram = (row) =>
    sourcePrograms.length === 0 ||
    !row?.programId ||
    programIds.has(row.programId);
  const timeBlocks = (snapshot.timeBlocks || []).filter(belongsToPublishedProgram);
  const allowedBlocks = timeBlocks.filter((block) => block.allowSessions === true);
  const sessions = (snapshot.sessions || []).filter(
    (session) =>
      !isDraft(session) &&
      belongsToPublishedProgram(session) &&
      sessionBelongsToAllowedBlock(session, allowedBlocks)
  );
  const sponsorCategories = (snapshot.sponsorCategories || []).filter(
    (category) => category.isActive !== false
  );
  const categoryIds = new Set(sponsorCategories.map(rowId).filter(Boolean));
  const sponsors = (snapshot.sponsors || []).filter(
    (sponsor) =>
      sponsor.isActive !== false &&
      (!sponsor.categoryId || categoryIds.has(sponsor.categoryId))
  );
  const mediaItems = (snapshot.mediaItems || []).filter(
    (item) => item.isPublished === true
  );
  const reports = (snapshot.reports || []).filter(
    (report) => report.isPublished === true
  );

  return {
    ...snapshot,
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
    mediaItems,
    reports,
  };
}

function sanitizeRuntimeSnapshot(snapshot) {
  const sanitized = sanitizeConferenceBundle(snapshot);
  const operationalInfo = (snapshot.operationalInfo || [])
    .filter((item) => item.isPublished === true)
    .map((item) => ({
      ...item,
      $id: rowId(item) || item.id,
      $tableId: item.$tableId || "admin_operational_info",
    }));
  const pastConferences = (snapshot.pastConferences || [])
    .map(sanitizeConferenceBundle)
    .filter((bundle) => bundle.conference?.$id)
    .sort(
      (left, right) =>
        Number(right.conference?.year || 0) - Number(left.conference?.year || 0)
    );

  return {
    ...sanitized,
    operationalInfo,
    pastConferences,
  };
}

function normalizeRuntimeSnapshot(snapshot, metadata = {}) {
  const sanitized = sanitizeRuntimeSnapshot(snapshot);

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: "appwrite",
      databaseId: HR_DATABASE_ID,
      activeConferenceId: sanitized.conference?.$id,
      ...metadata,
      tables: {
        ...REC_TABLES,
        ...(metadata.tables || {}),
      },
    },
    conference: sanitized.conference,
    programs: sanitized.programs,
    timeBlocks: sanitized.timeBlocks,
    sessions: sanitized.sessions,
    sponsorCategories: sanitized.sponsorCategories,
    sponsors: sanitized.sponsors,
    mediaItems: sanitized.mediaItems,
    reports: sanitized.reports,
    operationalInfo: sanitized.operationalInfo,
    pastConferences: sanitized.pastConferences,
  };
}

function rowsForProgramIds(rows, programIds) {
  const allowedIds = new Set(programIds);
  return rows.filter((row) => allowedIds.has(row.programId));
}

function conferenceBundleFromRows(
  conference,
  {
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
    mediaItems,
    reports,
  }
) {
  const conferencePrograms = programs.filter(
    (program) => program.conferenceId === conference.$id
  );
  const programIds = conferencePrograms.map((program) => program.$id);

  return {
    conference,
    programs: conferencePrograms,
    timeBlocks: rowsForProgramIds(timeBlocks, programIds),
    sessions: rowsForProgramIds(sessions, programIds),
    sponsorCategories: sponsorCategories.filter(
      (category) => category.conferenceId === conference.$id
    ),
    sponsors: sponsors.filter(
      (sponsor) => sponsor.conferenceId === conference.$id
    ),
    mediaItems: mediaItems.filter(
      (item) => item.conferenceId === conference.$id
    ),
    reports: reports.filter(
      (report) => report.conferenceId === conference.$id
    ),
  };
}

export async function fetchRecSnapshotFromAppwrite({ signal } = {}) {
  const [
    conferences,
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
    mediaItems,
    reports,
  ] = await Promise.all([
    listAllRows(HR_DATABASE_ID, REC_TABLES.conferences, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.programs, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.timeBlocks, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.sessions, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.sponsorCategories, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.sponsors, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.mediaItems, { signal }),
    listAllRows(HR_DATABASE_ID, REC_TABLES.reports, { signal }),
  ]);
  const conference = conferences.find((item) => item.isActive === true);

  if (!conference) {
    throw new Error("No active REC conference found in Appwrite.");
  }

  const allRows = {
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
    mediaItems,
    reports,
  };
  const current = conferenceBundleFromRows(conference, allRows);
  const operationalInfo = await getConferenceOperationalInfo(conference.$id);
  const pastConferences = conferences
    .filter((item) => item.$id !== conference.$id)
    .map((item) => conferenceBundleFromRows(item, allRows));

  return normalizeRuntimeSnapshot({
    ...current,
    operationalInfo,
    pastConferences,
  });
}

function normalizedTimeBlock(block) {
  return {
    id: rowId(block),
    label: stripHtml(block.label),
    type: block.type || "",
    startTime: formatTime(block.startTime),
    endTime: formatTime(block.endTime),
    startAt: block.startTime || "",
    endAt: block.endTime || "",
    startMinutes: block.startMinutes ?? null,
    endMinutes: block.endMinutes ?? null,
    sortOrder: block.sortOrder ?? null,
    allowSessions: block.allowSessions === true,
    halls: Array.isArray(block.venueHalls)
      ? block.venueHalls.map(stripHtml).filter(Boolean)
      : [],
    notes: stripHtml(block.notes),
  };
}

function normalizedSession(session) {
  return {
    id: rowId(session),
    status: session.status || "",
    startTime: formatTime(session.startTime),
    endTime: formatTime(session.toTime),
    startAt: session.startTime || "",
    endAt: session.toTime || "",
    hall: stripHtml(session.venueHall),
    theme: stripHtml(session.theme),
    title: stripHtml(session.title),
    preamble: stripHtml(session.preamble),
    organizer: stripHtml(session.organizer),
    speakers: normalizeSpeakerText(session.speakers),
    timeBlockIds: Array.isArray(session.timeBlockIds)
      ? session.timeBlockIds
      : [],
    spanType: session.sessionSpanType || "",
  };
}

function normalizedOperationalInfo(item) {
  return {
    id: rowId(item) || item.id,
    category: item.category || "other",
    title: stripHtml(item.title),
    answer: String(item.answer || "").trim(),
    keywords: Array.isArray(item.keywords) ? item.keywords.filter(Boolean) : [],
    isPublished: item.isPublished === true,
    updatedAt: item.updatedAt || "",
  };
}

function normalizedMediaItem(item) {
  const sampleImages = parseJson(item.sampleImagesJson, []);

  return {
    id: rowId(item),
    mediaType: item.mediaType || "",
    title: stripHtml(item.title),
    slug: item.slug || "",
    description: stripHtml(item.description),
    externalUrl: item.externalUrl || "",
    videoUrl: item.videoUrl || "",
    thumbnailUrl: item.thumbnailUrl || "",
    thumbnailFileId: item.thumbnailFileId || "",
    sampleImages: Array.isArray(sampleImages)
      ? sampleImages.slice(0, 12).map((image, index) => ({
          fileId: image.fileId || "",
          url: image.url || "",
          name: stripHtml(image.name),
          caption: stripHtml(image.caption),
          sortOrder: image.sortOrder ?? index + 1,
        }))
      : [],
    displayOrder: item.displayOrder ?? null,
    featured: item.isFeatured === true,
    isPublished: item.isPublished === true,
    updatedAt: item.updatedAt || item.$updatedAt || "",
  };
}

function normalizedReport(report) {
  return {
    id: rowId(report),
    reportType: report.reportType || "",
    title: stripHtml(report.title),
    summary: stripHtml(report.summary),
    reportUrl: report.reportUrl || "",
    coverImageUrl: report.coverImageUrl || "",
    publicationDate: dateOnly(report.publicationDate),
    displayOrder: report.displayOrder ?? null,
    featured: report.isFeatured === true,
    isPublished: report.isPublished === true,
    updatedAt: report.updatedAt || report.$updatedAt || "",
  };
}

function getProgrammeDays(snapshot) {
  const configuredDays = parseJson(snapshot.conference?.days, []);
  const configuredByDay = new Map(
    configuredDays.map((day, index) => [index + 1, day])
  );
  const dayNumbers = new Set(configuredDays.map((_, index) => index + 1));

  for (const row of [...snapshot.timeBlocks, ...snapshot.sessions]) {
    const day = Number(row.day);
    if (Number.isInteger(day) && day > 0) dayNumbers.add(day);
  }

  return [...dayNumbers]
    .sort((a, b) => a - b)
    .map((dayNumber) => {
      const configured = configuredByDay.get(dayNumber) || {};
      const blocks = snapshot.timeBlocks
        .filter((block) => Number(block.day) === dayNumber)
        .sort(
          (a, b) =>
            new Date(a.startTime || 0) - new Date(b.startTime || 0) ||
            (a.sortOrder || 0) - (b.sortOrder || 0)
        );
      const sessions = snapshot.sessions
        .filter((session) => Number(session.day) === dayNumber)
        .sort(
          (a, b) =>
            new Date(a.startTime || 0) - new Date(b.startTime || 0) ||
            String(a.title || "").localeCompare(String(b.title || ""))
        );
      const date =
        configured.date ||
        blocks.find((block) => block.date)?.date ||
        dateOnly(sessions[0]?.startTime);

      return {
        day: dayNumber,
        date: dateOnly(date),
        dateLabel: formatDate(date),
        label: configured.label || `Day ${dayNumber}`,
        theme: configured.theme || "",
        timeBlocks: blocks.map(normalizedTimeBlock),
        sessions: sessions.map(normalizedSession),
      };
    });
}

function getGroupedSponsors(snapshot) {
  const sponsorsByCategory = new Map();

  for (const sponsor of snapshot.sponsors) {
    const list = sponsorsByCategory.get(sponsor.categoryId) || [];
    list.push(sponsor);
    sponsorsByCategory.set(sponsor.categoryId, list);
  }

  return [...snapshot.sponsorCategories]
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
    .map((category) => ({
      id: rowId(category),
      category: stripHtml(category.name),
      description: stripHtml(category.description),
      displayOrder: category.displayOrder ?? null,
      sponsorList: (sponsorsByCategory.get(rowId(category)) || [])
        .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
        .map((sponsor) => ({
          id: rowId(sponsor),
          name: stripHtml(sponsor.name),
          description: stripHtml(sponsor.description),
          websiteUrl: sponsor.siteUrl || "",
          featured: sponsor.isFeatured === true,
          displayOrder: sponsor.displayOrder ?? null,
        })),
    }));
}

function buildGeneratedPastConference(bundle) {
  const sanitized = sanitizeConferenceBundle(bundle);
  const conference = sanitized.conference;
  const primaryProgram = sanitized.programs[0] || {};

  return {
    id: rowId(conference),
    title: conference.title || "",
    shortName: conference.shortName || "",
    description: stripHtml(conference.description),
    year: conference.year || Number(dateOnly(conference.startDate).slice(0, 4)),
    startDate: dateOnly(conference.startDate),
    endDate: dateOnly(conference.endDate),
    location: conference.location || "",
    venue: conference.venue || "",
    theme: conference.theme || "",
    websiteUrl: conference.mainWebsiteUrl || "",
    contactEmail: conference.contactEmail || "",
    contactPhone: conference.contactPhone || "",
    programTitle: primaryProgram.title || "",
    programDescription: stripHtml(primaryProgram.description),
    program: getProgrammeDays(sanitized),
    sponsors: getGroupedSponsors(sanitized),
    media: sanitized.mediaItems.map(normalizedMediaItem),
    reports: sanitized.reports.map(normalizedReport),
  };
}

export function buildGeneratedRecSnapshot(snapshot, metadata = {}) {
  const runtime = normalizeRuntimeSnapshot(snapshotToRuntimeData(snapshot), metadata);
  const conference = runtime.conference;
  const primaryProgram = runtime.programs[0] || {};
  const maxLimits = parseJson(conference.maxLimits, {});
  const registrationFees = parseJson(conference.registrationFee, {});

  return {
    schemaVersion: REC_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: runtime.metadata.generatedAt,
    source: {
      provider: runtime.metadata.source || "appwrite",
      databaseId: runtime.metadata.databaseId || HR_DATABASE_ID,
      activeConferenceId:
        runtime.metadata.activeConferenceId || rowId(conference),
      programId: rowId(primaryProgram),
      tables: runtime.metadata.tables || REC_TABLES,
    },
    title: conference.title || "",
    shortName: conference.shortName || "",
    description: stripHtml(conference.description),
    year: conference.year || Number(dateOnly(conference.startDate).slice(0, 4)),
    startDate: dateOnly(conference.startDate),
    endDate: dateOnly(conference.endDate),
    location: conference.location || "",
    venue: conference.venue || "",
    registrationStatus: conference.registrationOpen ? "open" : "closed",
    registrationMessage: conference.regClosedMessage || "",
    registrationFees,
    capacity: {
      attendees: maxLimits.attendee ?? conference.maxAttendees ?? null,
      exhibitors: maxLimits.exhibitor ?? conference.maxExhibitors ?? null,
      sponsors: maxLimits.sponsor ?? conference.maxSponsors ?? null,
    },
    currentRegistrationCounts: parseJson(conference.currentCounts, {}),
    theme: conference.theme || "",
    tagline: conference.heroTagline || "",
    websiteUrl: conference.mainWebsiteUrl || "",
    sponsorshipPackageUrl: conference.sponsorshipPackageUrl || "",
    contactEmail: conference.contactEmail || "",
    contactPhone: conference.contactPhone || "",
    programTitle: primaryProgram.title || "",
    programDescription: stripHtml(primaryProgram.description),
    program: getProgrammeDays(runtime),
    sponsors: getGroupedSponsors(runtime),
    operationalInfo: runtime.operationalInfo.map(normalizedOperationalInfo),
    media: runtime.mediaItems.map(normalizedMediaItem),
    reports: runtime.reports.map(normalizedReport),
    previousConferences: runtime.pastConferences.map(
      buildGeneratedPastConference
    ),
  };
}

function generatedBundleToRuntime(
  snapshot,
  tables,
  { conferenceId, programId, isActive }
) {
  const days = Array.isArray(snapshot.program) ? snapshot.program : [];
  const venueHalls = [
    ...new Set(
      days.flatMap((day) =>
        (day.timeBlocks || []).flatMap((block) => block.halls || [])
      )
    ),
  ];
  const conference = {
    $id: conferenceId,
    $tableId: tables.conferences,
    year: snapshot.year,
    title: snapshot.title,
    shortName: snapshot.shortName,
    description: snapshot.description,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    location: snapshot.location,
    venue: snapshot.venue,
    isActive,
    registrationOpen: snapshot.registrationStatus === "open",
    registrationFee: JSON.stringify(snapshot.registrationFees || {}),
    maxLimits: JSON.stringify({
      attendee: snapshot.capacity?.attendees ?? null,
      exhibitor: snapshot.capacity?.exhibitors ?? null,
      sponsor: snapshot.capacity?.sponsors ?? null,
    }),
    currentCounts: JSON.stringify(snapshot.currentRegistrationCounts || {}),
    maxAttendees: snapshot.capacity?.attendees ?? null,
    maxExhibitors: snapshot.capacity?.exhibitors ?? null,
    maxSponsors: snapshot.capacity?.sponsors ?? null,
    sponsorshipPackageUrl: snapshot.sponsorshipPackageUrl || null,
    theme: snapshot.theme,
    mainWebsiteUrl: snapshot.websiteUrl,
    heroTagline: snapshot.tagline,
    contactEmail: snapshot.contactEmail || null,
    contactPhone: snapshot.contactPhone || null,
    regClosedMessage: snapshot.registrationMessage || "",
    days: JSON.stringify(
      days.map((day) => ({
        date: day.date,
        label: day.label || `${day.dateLabel} - Day ${day.day}`,
        theme: day.theme,
      }))
    ),
  };
  const hasProgram = Boolean(
    snapshot.programTitle ||
      days.some(
        (day) =>
          (day.timeBlocks || []).length > 0 || (day.sessions || []).length > 0
      )
  );
  const programs = hasProgram
    ? [
        {
          $id: programId,
          $tableId: tables.programs,
          conferenceId: conference.$id,
          title: snapshot.programTitle,
          description: snapshot.programDescription || "",
          daysCount: days.length,
          venueHalls,
          status: isActive ? "PUBLISHED" : "ARCHIVED",
        },
      ]
    : [];
  const timeBlocks = days.flatMap((day) =>
    (day.timeBlocks || []).map((block) => ({
      $id: block.id,
      $tableId: tables.timeBlocks,
      conferenceId: conference.$id,
      programId,
      day: day.day,
      date: day.date,
      startTime: block.startAt,
      endTime: block.endAt,
      startMinutes: block.startMinutes,
      endMinutes: block.endMinutes,
      sortOrder: block.sortOrder,
      type: block.type,
      label: block.label,
      allowSessions: block.allowSessions === true,
      venueHalls: block.halls || [],
      notes: block.notes || "",
    }))
  );
  const sessions = days.flatMap((day) =>
    (day.sessions || []).map((session) => ({
      $id: session.id,
      $tableId: tables.sessions,
      conferenceId: conference.$id,
      programId,
      day: day.day,
      startTime: session.startAt,
      toTime: session.endAt,
      venueHall: session.hall,
      theme: session.theme,
      title: session.title,
      preamble: session.preamble,
      organizer: session.organizer,
      speakers: session.speakers,
      status: session.status,
      timeBlockIds: session.timeBlockIds || [],
      sessionSpanType: session.spanType || "",
    }))
  );
  const sponsorCategories = (snapshot.sponsors || []).map((group, index) => ({
    $id: group.id || `generated-sponsor-category-${index + 1}`,
    $tableId: tables.sponsorCategories,
    conferenceId: conference.$id,
    name: group.category,
    description: group.description,
    displayOrder: group.displayOrder,
    isActive: true,
  }));
  const sponsors = (snapshot.sponsors || []).flatMap((group, groupIndex) => {
    const categoryId =
      group.id || `generated-sponsor-category-${groupIndex + 1}`;

    return (group.sponsorList || []).map((sponsor) => ({
      $id: sponsor.id,
      $tableId: tables.sponsors,
      conferenceId: conference.$id,
      categoryId,
      name: sponsor.name,
      description: sponsor.description,
      siteUrl: sponsor.websiteUrl,
      isFeatured: sponsor.featured === true,
      displayOrder: sponsor.displayOrder,
      isActive: true,
    }));
  });

  const mediaItems = (snapshot.media || []).map((item, index) => ({
    $id: item.id || `generated-media-${conference.$id}-${index + 1}`,
    $tableId: tables.mediaItems,
    conferenceId: conference.$id,
    mediaType: item.mediaType || "",
    title: item.title || "",
    slug: item.slug || "",
    description: item.description || "",
    externalUrl: item.externalUrl || "",
    videoUrl: item.videoUrl || "",
    thumbnailUrl: item.thumbnailUrl || "",
    thumbnailFileId: item.thumbnailFileId || "",
    sampleImagesJson: JSON.stringify(item.sampleImages || []),
    displayOrder: item.displayOrder,
    isFeatured: item.featured === true,
    isPublished: item.isPublished !== false,
    updatedAt: item.updatedAt || "",
  }));
  const reports = (snapshot.reports || []).map((report, index) => ({
    $id: report.id || `generated-report-${conference.$id}-${index + 1}`,
    $tableId: tables.reports || REC_TABLES.reports,
    conferenceId: conference.$id,
    reportType: report.reportType || "",
    title: report.title || "",
    summary: report.summary || "",
    reportUrl: report.reportUrl || "",
    coverImageUrl: report.coverImageUrl || "",
    publicationDate: report.publicationDate || null,
    displayOrder: report.displayOrder,
    isFeatured: report.featured === true,
    isPublished: report.isPublished !== false,
    updatedAt: report.updatedAt || "",
  }));

  return {
    conference,
    programs,
    timeBlocks,
    sessions,
    sponsorCategories,
    sponsors,
    mediaItems,
    reports,
  };
}

function generatedSnapshotToRuntimeData(snapshot) {
  const source = snapshot.source || {};
  const tables = {
    ...REC_TABLES,
    ...(source.tables || {}),
  };
  const activeConferenceId =
    source.activeConferenceId || "active-rec-conference";
  const current = generatedBundleToRuntime(snapshot, tables, {
    conferenceId: activeConferenceId,
    programId: source.programId || "generated-rec-program",
    isActive: true,
  });
  const operationalInfo = (snapshot.operationalInfo || []).map((item, index) => ({
    $id: item.id || `generated-operational-info-${index + 1}`,
    $tableId: "admin_operational_info",
    conferenceId: activeConferenceId,
    category: item.category || "other",
    title: item.title || "",
    answer: item.answer || "",
    keywords: Array.isArray(item.keywords) ? item.keywords : [],
    isPublished: item.isPublished === true,
    updatedAt: item.updatedAt || "",
  }));
  const pastConferences = (snapshot.previousConferences || []).map(
    (pastConference, index) =>
      generatedBundleToRuntime(pastConference, tables, {
        conferenceId:
          pastConference.id || `generated-past-conference-${index + 1}`,
        programId: `generated-past-program-${
          pastConference.id || pastConference.year || index + 1
        }`,
        isActive: false,
      })
  );

  return normalizeRuntimeSnapshot(
    {
      ...current,
      operationalInfo,
      pastConferences,
    },
    {
      generatedAt: snapshot.generatedAt,
      source: source.provider || "appwrite",
      databaseId: source.databaseId || HR_DATABASE_ID,
      tables,
      activeConferenceId,
    }
  );
}

export function snapshotToRuntimeData(snapshot) {
  if (
    SUPPORTED_GENERATED_SCHEMA_VERSIONS.has(snapshot?.schemaVersion) &&
    Array.isArray(snapshot.program)
  ) {
    return generatedSnapshotToRuntimeData(snapshot);
  }

  return normalizeRuntimeSnapshot(
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
      pastConferences: snapshot.pastConferences || [],
    },
    snapshot.metadata || {}
  );
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

  const isLegacySnapshot = Boolean(snapshot?.conference?.$id);
  const isNormalizedSnapshot =
    SUPPORTED_GENERATED_SCHEMA_VERSIONS.has(snapshot?.schemaVersion) &&
    Boolean(snapshot?.source?.activeConferenceId) &&
    Array.isArray(snapshot?.program);

  if (!isLegacySnapshot && !isNormalizedSnapshot) {
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
      rowId(category),
      category.name,
    ])
  );
}

function renderConferenceBundleMarkdown(
  bundle,
  { label, operationalInfo = [], question = "" }
) {
  const conference = bundle.conference;
  const normalizedQuestion = String(question || "").toLowerCase();
  const compactThemeHistoryContext =
    Boolean(normalizedQuestion) &&
    /\bthemes?\b/.test(normalizedQuestion) &&
    (/\b(evolv(?:e|ed|ing|ution)|chang(?:e|ed|ing)|progress(?:ion|ed|ing)?|develop(?:ed|ment)?|trends?|patterns?|over time|year[- ]to[- ]year)\b/.test(
      normalizedQuestion
    ) ||
      /\b(across|through|between|among)\b.*\b(editions?|years?|conferences?)\b/.test(
        normalizedQuestion
      ));
  const days = parseJson(conference.days, []);
  const categoriesById = categoryNameById(bundle);
  const activeSponsors = (bundle.sponsors || [])
    .filter((sponsor) => sponsor.isActive !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  const sessions = [...(bundle.sessions || [])].sort(
    (a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime)
  );
  const blocks = [...(bundle.timeBlocks || [])].sort(
    (a, b) => a.day - b.day || new Date(a.startTime) - new Date(b.startTime)
  );
  const mediaItems = [...(bundle.mediaItems || [])].sort(
    (a, b) => (a.displayOrder || 0) - (b.displayOrder || 0)
  );
  const reports = [...(bundle.reports || [])].sort(
    (a, b) => (a.displayOrder || 0) - (b.displayOrder || 0)
  );

  return [
    `## ${label}: ${conference.title}`,
    compact([
      `Conference ID: ${rowId(conference)}`,
      `Short name: ${conference.shortName}`,
      `Year: ${conference.year || dateOnly(conference.startDate).slice(0, 4)}`,
      `Theme: ${conference.theme}`,
      `Dates: ${formatConferenceDates(conference)}`,
      `Venue: ${formatConferenceVenue(conference)}`,
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
    "### Days",
    markdownTable(
      ["Day", "Date", "Theme"],
      days.map((day, index) => [
        day.label || `Day ${index + 1}`,
        day.date,
        day.theme,
      ])
    ),
    compactThemeHistoryContext ? null : "### Program Time Blocks",
    compactThemeHistoryContext
      ? null
      : markdownTable(
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
    compactThemeHistoryContext ? null : "### Sessions",
    compactThemeHistoryContext
      ? null
      : markdownTable(
          [
            "Day",
            "Title",
            "Theme",
            "Time",
            "Venue",
            "Organizer",
            "Speakers",
            "Details",
          ],
          sessions.map((session) => [
            session.day,
            session.title,
            session.theme,
            `${formatTime(session.startTime)} to ${formatTime(session.toTime)}`,
            session.venueHall,
            session.organizer,
            stripHtml(session.speakers),
            stripHtml(session.preamble),
          ])
        ),
    compactThemeHistoryContext ? null : "### Sponsors And Partners",
    compactThemeHistoryContext
      ? null
      : markdownTable(
          ["Name", "Category", "Featured", "Website", "Description"],
          activeSponsors.map((sponsor) => [
            sponsor.name,
            categoriesById.get(sponsor.categoryId) || "",
            sponsor.isFeatured ? "yes" : "no",
            sponsor.siteUrl,
            stripHtml(sponsor.description),
          ])
        ),
    operationalInfo.length > 0 && !compactThemeHistoryContext
      ? "### Published Venue And Visitor Information"
      : null,
    operationalInfo.length > 0 && !compactThemeHistoryContext
      ? markdownTable(
          ["Category", "Topic", "Published answer", "Keywords"],
          operationalInfo.map((item) => [
            item.category,
            item.title,
            item.answer,
            (item.keywords || []).join(", "),
          ])
        )
      : null,
    mediaItems.length > 0 && !compactThemeHistoryContext
      ? "### Published Media"
      : null,
    mediaItems.length > 0 && !compactThemeHistoryContext
      ? markdownTable(
          ["Title", "Type", "Description", "Album or external link", "Video link", "Sample images"],
          mediaItems.map((item) => [
            item.title,
            item.mediaType,
            stripHtml(item.description),
            item.externalUrl,
            item.videoUrl,
            parseJson(item.sampleImagesJson, [])
              .map((image) => image.url)
              .filter(Boolean)
              .join(", "),
          ])
        )
      : null,
    reports.length > 0 && !compactThemeHistoryContext
      ? "### Published Conference Reports"
      : null,
    reports.length > 0 && !compactThemeHistoryContext
      ? markdownTable(
          ["Title", "Type", "Summary", "Report link", "Cover image", "Publication date"],
          reports.map((report) => [
            report.title,
            report.reportType,
            stripHtml(report.summary),
            report.reportUrl,
            report.coverImageUrl,
            dateOnly(report.publicationDate),
          ])
        )
      : null,
  ].filter(Boolean);
}

function extractConferenceYears(question) {
  const years = new Set(
    [...String(question || "").matchAll(/\b(20\d{2})\b/g)].map((match) =>
      Number(match[1])
    )
  );

  for (const match of String(question || "").matchAll(/\brec\s*[-']?\s*(\d{2})\b/gi)) {
    years.add(2000 + Number(match[1]));
  }

  return years;
}

function orderConferenceBundles(runtime, question) {
  const current = {
    ...runtime,
    label: "Active Conference",
    operationalInfo: runtime.operationalInfo || [],
  };
  const past = (runtime.pastConferences || []).map((bundle) => ({
    ...bundle,
    label: "Previous Conference",
    operationalInfo: [],
  }));
  const bundles = [current, ...past];
  const requestedYears = extractConferenceYears(question);
  const normalizedQuestion = String(question || "").toLowerCase();
  const prioritizesHistory =
    requestedYears.size > 0 ||
    /\b(previous|past|histor|archive|earlier|former)\b/.test(normalizedQuestion) ||
    /\b(photo|photos|album|albums|gallery|galleries|media|video|videos|recording|recordings)\b/.test(
      normalizedQuestion
    ) ||
    /\b(report|reports|document|documents|publication|publications|proceedings|communique|communiques|pdf|pdfs)\b|\bpublished outcomes?\b/.test(
      normalizedQuestion
    );

  if (!prioritizesHistory) return bundles;

  return bundles.sort((left, right) => {
    const leftYear = Number(left.conference?.year || 0);
    const rightYear = Number(right.conference?.year || 0);
    const leftRequested = requestedYears.has(leftYear) ? 1 : 0;
    const rightRequested = requestedYears.has(rightYear) ? 1 : 0;

    if (leftRequested !== rightRequested) return rightRequested - leftRequested;

    const leftPast = left.conference?.isActive === true ? 0 : 1;
    const rightPast = right.conference?.isActive === true ? 0 : 1;
    if (leftPast !== rightPast) return rightPast - leftPast;

    return rightYear - leftYear;
  });
}

export function renderRecSnapshotMarkdown(snapshot, { question = "" } = {}) {
  const runtime = snapshotToRuntimeData(snapshot);
  const orderedBundles = orderConferenceBundles(runtime, question);
  const conferenceSummary = orderedBundles.map((bundle) => [
    bundle.conference?.year || "",
    bundle.conference?.shortName || bundle.conference?.title || "",
    formatConferenceDates(bundle.conference || {}),
    bundle.conference?.venue || "",
    bundle.conference?.theme || "",
    (bundle.mediaItems || []).length,
    (bundle.reports || []).length,
  ]);
  const sections = [
    "# REC Public Conference Knowledge Snapshot",
    compact([
      `Generated: ${runtime.metadata?.generatedAt || new Date().toISOString()}`,
      `Source: Appwrite conference ${runtime.conference?.$id} plus published prior editions`,
      "Default scope: the active conference. Use a year, REC edition, or explicit past/previous wording to select historical data.",
    ]).join("\n"),
    "## Available Conference Editions",
    markdownTable(
      [
        "Year",
        "Edition",
        "Dates",
        "Venue",
        "Theme",
        "Published media items",
        "Published reports",
      ],
      conferenceSummary
    ),
    ...orderedBundles.flatMap((bundle) =>
      renderConferenceBundleMarkdown(bundle, {
        label: bundle.label,
        operationalInfo: bundle.operationalInfo,
        question,
      })
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
  const runtimeInput = snapshotToRuntimeData(snapshot);
  const runtime = normalizeRuntimeSnapshot(runtimeInput, {
    ...(runtimeInput.metadata || {}),
    generatedAt: new Date().toISOString(),
  });
  const generated = buildGeneratedRecSnapshot(runtime, runtime.metadata);
  const markdown = renderRecSnapshotMarkdown(runtime);

  await mkdir(GENERATED_DIR, { recursive: true });
  await Promise.all([
    writeAtomic(SNAPSHOT_JSON_PATH, `${JSON.stringify(generated, null, 2)}\n`),
    writeAtomic(SNAPSHOT_MD_PATH, markdown),
  ]);

  return {
    snapshot: runtime,
    generatedSnapshot: generated,
    paths: getSnapshotPaths(),
    counts: {
      programs: runtime.programs.length,
      timeBlocks: runtime.timeBlocks.length,
      sessions: runtime.sessions.length,
      sponsorCategories: runtime.sponsorCategories.length,
      sponsors: runtime.sponsors.length,
      operationalInfo: runtime.operationalInfo.length,
      mediaItems: runtime.mediaItems.length,
      reports: runtime.reports.length,
      previousConferences: runtime.pastConferences.length,
      historicalSessions: runtime.pastConferences.reduce(
        (total, bundle) => total + bundle.sessions.length,
        0
      ),
      historicalMediaItems: runtime.pastConferences.reduce(
        (total, bundle) => total + bundle.mediaItems.length,
        0
      ),
      historicalReports: runtime.pastConferences.reduce(
        (total, bundle) => total + bundle.reports.length,
        0
      ),
    },
  };
}

export async function refreshGeneratedRecSnapshot({ signal } = {}) {
  const snapshot = await fetchRecSnapshotFromAppwrite({ signal });
  return writeGeneratedRecSnapshot(snapshot);
}
