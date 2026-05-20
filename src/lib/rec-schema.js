import fs from "node:fs";
import path from "node:path";

export const REC_SCHEMA_VERSION = "2026-05-20";
export const REC_SCHEMA_MARKDOWN_PATH = "docs/conference-schema.md";

export const REC_SCHEMA = {
  activeConference: {
    title: "Renewable Energy Conference & Expo 2026",
    shortName: "REC26 & EXPO",
    activeRowId: "6863b66b0016bd6d77ff",
    enforcedFilter: "REC_Conferences.isActive = true",
  },
  tables: {
    conferences: {
      label: "REC_Conferences",
      purpose: "Active conference facts, dates, venue, registration status, theme, limits, contact, and website.",
      fields: [
        "year",
        "title",
        "description",
        "startDate",
        "endDate",
        "location",
        "venue",
        "isActive",
        "registrationOpen",
        "maxAttendees",
        "registrationFee",
        "days",
        "maxExhibitors",
        "maxSponsors",
        "maxLimits",
        "currentCounts",
        "sponsorshipPackageUrl",
        "theme",
        "shortName",
        "fullName",
        "mainWebsiteUrl",
        "heroTagline",
        "contactEmail",
        "contactPhone",
        "regClosedMessage",
        "successMessage",
        "couponRequired",
      ],
      defaultFields: [
        "title",
        "shortName",
        "year",
        "theme",
        "startDate",
        "endDate",
        "venue",
        "location",
        "registrationOpen",
        "regClosedMessage",
        "mainWebsiteUrl",
      ],
      searchableFields: [
        "title",
        "shortName",
        "fullName",
        "description",
        "theme",
        "venue",
        "location",
        "heroTagline",
      ],
    },
    programs: {
      label: "REC_Program",
      purpose: "Programme container for the active conference.",
      fields: [
        "conferenceId",
        "description",
        "daysCount",
        "venueHalls",
        "status",
        "slug",
        "title",
        "createdAt",
        "updatedAt",
      ],
      defaultFields: ["title", "description", "daysCount", "venueHalls", "status"],
      searchableFields: ["title", "description", "venueHalls", "status"],
    },
    timeBlocks: {
      label: "REC_ProgramTimeBlocks",
      purpose: "Scheduled blocks such as sessions, exhibition blocks, tea breaks, and lunch.",
      fields: [
        "conferenceId",
        "programId",
        "day",
        "date",
        "startTime",
        "endTime",
        "startMinutes",
        "endMinutes",
        "type",
        "label",
        "allowSessions",
        "venueScope",
        "venueHalls",
        "sortOrder",
        "notes",
      ],
      defaultFields: [
        "label",
        "day",
        "date",
        "startTime",
        "endTime",
        "type",
        "venueHalls",
        "notes",
      ],
      searchableFields: ["label", "type", "venueHalls", "notes", "date"],
    },
    sessions: {
      label: "REC_Sessions",
      purpose: "Published programme sessions.",
      fields: [
        "programId",
        "day",
        "startTime",
        "toTime",
        "venueHall",
        "theme",
        "title",
        "preamble",
        "organizer",
        "speakers",
        "status",
        "timeBlockIds",
        "sessionSpanType",
      ],
      defaultFields: [
        "title",
        "day",
        "startTime",
        "toTime",
        "venueHall",
        "theme",
        "preamble",
        "organizer",
        "speakers",
        "status",
      ],
      searchableFields: [
        "title",
        "theme",
        "preamble",
        "organizer",
        "speakers",
        "venueHall",
        "status",
      ],
    },
    sponsorCategories: {
      label: "REC_SponsorCategories",
      purpose: "Public sponsor and partner groupings.",
      fields: [
        "conferenceId",
        "name",
        "slug",
        "description",
        "accentColor",
        "displayOrder",
        "isActive",
      ],
      defaultFields: ["name", "slug", "description", "displayOrder", "isActive"],
      searchableFields: ["name", "slug", "description"],
    },
    sponsors: {
      label: "REC_Sponsors",
      purpose: "Public sponsors and partners.",
      fields: [
        "conferenceId",
        "categoryId",
        "name",
        "description",
        "siteUrl",
        "logoUrl",
        "displayOrder",
        "isActive",
        "isFeatured",
      ],
      defaultFields: [
        "name",
        "categoryId",
        "description",
        "siteUrl",
        "displayOrder",
        "isActive",
        "isFeatured",
      ],
      searchableFields: ["name", "description", "siteUrl"],
    },
  },
  allowedFilters: [
    "day",
    "date",
    "keywords",
    "title",
    "theme",
    "venueHall",
    "type",
    "categoryName",
    "status",
    "isActive",
  ],
  allowedSortFields: [
    "day",
    "date",
    "startTime",
    "toTime",
    "endTime",
    "startMinutes",
    "sortOrder",
    "displayOrder",
    "title",
    "name",
  ],
};

function compactPlannerSchema() {
  const tables = Object.entries(REC_SCHEMA.tables)
    .map(([name, table]) => {
      return [
        `- ${name} (${table.label}): ${table.purpose}`,
        `  Fields: ${table.fields.join(", ")}`,
        `  Default fields: ${table.defaultFields.join(", ")}`,
      ].join("\n");
    })
    .join("\n");

  return [
    `Schema version: ${REC_SCHEMA_VERSION}`,
    `Active conference: ${REC_SCHEMA.activeConference.title} (${REC_SCHEMA.activeConference.shortName})`,
    `Scope rule: ${REC_SCHEMA.activeConference.enforcedFilter}`,
    "Planner-allowed tables and fields:",
    tables,
    `Allowed filters: ${REC_SCHEMA.allowedFilters.join(", ")}`,
    `Allowed sort fields: ${REC_SCHEMA.allowedSortFields.join(", ")}`,
    "Do not request private registration, coupon, lock, verification, or attendee tables.",
  ].join("\n");
}

export function getPlannerSchemaMarkdown() {
  const fullPath = path.join(process.cwd(), REC_SCHEMA_MARKDOWN_PATH);

  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return compactPlannerSchema();
  }
}

export function getPlannerSchemaPrompt() {
  return [
    `Schema version: ${REC_SCHEMA_VERSION}`,
    "Scope: only public REC26 & EXPO data. Active conference is enforced by server.",
    "Never request registrations, coupons, locks, verifications, attendees, users, or private tables.",
    "Tables:",
    "- conferences: dates, venue, location, theme, registration status, fees, limits, contact, website.",
    "- programs: programme title, description, day count, venue halls, status.",
    "- timeBlocks: day/date/time blocks, breaks, lunch, exhibition blocks, labels, halls, notes.",
    "- sessions: session title, day, start/end time, venue hall, theme, preamble/details, organizer, speakers, status.",
    "- sponsorCategories: sponsor/partner category name, description, display order, active flag.",
    "- sponsors: sponsor/partner name, category, description, website, featured/active flags.",
    "Allowed filters: day, date, keywords, title, theme, venueHall, type, categoryName, status, isActive.",
    "Allowed sort fields: day, date, startTime, toTime, endTime, startMinutes, sortOrder, displayOrder, title, name.",
    "Good table choices: session/topic/recommendation questions -> sessions; schedule/block/break/lunch questions -> timeBlocks; sponsor/partner questions -> sponsors plus sponsorCategories; overview/date/venue/theme/register/cost/contact -> conferences.",
  ].join("\n");
}
