# REC26 & EXPO Conference Schema

This document describes the public Appwrite TablesDB data used by the conference chatbot for the active Renewable Energy Conference & Expo conference.

The active conference is always selected from `REC_Conferences` where `isActive = true`. At the time this schema was generated, the active conference row is:

- Title: Renewable Energy Conference & Expo 2026
- Short name: REC26 & EXPO
- Year: 2026
- Active row id: `6863b66b0016bd6d77ff`
- Dates: 2026-10-19 to 2026-10-22
- Venue: Kampala Serena Hotel, Kampala, Uganda
- Theme: From Systems to Scale: Powering Uganda's Green Economy

The chatbot must only use the public REC tables below. Registration records, coupons, locks, verifications, attendee data, and other private/security tables are not available to the planner.

## Table Relationships

- `REC_Conferences` is the parent table.
- `REC_Program.conferenceId` points to the active conference row.
- `REC_ProgramTimeBlocks.programId` points to `REC_Program.$id`.
- `REC_ProgramTimeBlocks.conferenceId` points to `REC_Conferences.$id`.
- `REC_Sessions.programId` points to `REC_Program.$id`.
- `REC_Sessions.timeBlockIds[]` can point to one or more `REC_ProgramTimeBlocks.$id` values.
- `REC_SponsorCategories.conferenceId` points to `REC_Conferences.$id`.
- `REC_Sponsors.conferenceId` points to `REC_Conferences.$id`.
- `REC_Sponsors.categoryId` points to `REC_SponsorCategories.$id`.

## Query Policy

The planner may request lookups against these logical tables only:

- `conferences`
- `programs`
- `timeBlocks`
- `sessions`
- `sponsorCategories`
- `sponsors`

The server always enforces active REC26 scope. The planner should not request Appwrite table ids directly, raw query strings, private tables, or unlisted columns.

Allowed high-level filters:

- `day`: numeric conference day, for sessions and time blocks.
- `date`: date string, for time blocks.
- `keywords`: text terms to match against title, theme, description, preamble, label, sponsor name, or category name.
- `title`: title/name substring.
- `theme`: session or conference theme substring.
- `venueHall`: hall or room substring.
- `type`: time block type, such as `SESSION`, `BREAK`, `LUNCH`, or `EXHIBITION`.
- `categoryName`: sponsor category name substring.
- `status`: programme or session status.
- `isActive`: sponsor or sponsor category active flag.

Allowed sort fields:

- `day`
- `date`
- `startTime`
- `toTime`
- `endTime`
- `startMinutes`
- `sortOrder`
- `displayOrder`
- `title`
- `name`

The planner output should be strict JSON with this shape:

```json
{
  "lookup": true,
  "reason": "short reason",
  "operations": [
    {
      "table": "sessions",
      "purpose": "find finance-related sessions",
      "filters": {
        "keywords": ["finance", "investment", "capital"]
      },
      "fields": ["title", "day", "startTime", "toTime", "venueHall", "theme", "preamble"],
      "sort": ["day", "startTime"],
      "limit": 8
    }
  ],
  "answerStyle": "concise recommendation"
}
```

Use `{"lookup": false, "reason": "..."}` when the user is not asking for public REC26 & EXPO information.

## REC_Conferences

Logical planner table: `conferences`

Appwrite table id: `6863ae070028061694f1`

Purpose: one row per conference edition. The chatbot uses only the active conference.

Columns:

- `year` integer, required
- `title` string, required
- `description` string
- `startDate` datetime, required
- `endDate` datetime, required
- `location` string, required
- `venue` string
- `isActive` boolean, required
- `registrationOpen` boolean
- `maxAttendees` integer
- `registrationFee` stringified JSON
- `days` stringified JSON array of `{ date, label, theme }`
- `maxExhibitors` integer
- `maxSponsors` integer
- `maxLimits` stringified JSON
- `currentCounts` stringified JSON
- `sponsorshipPackageUrl` URL string
- `theme` string
- `shortName` string
- `fullName` string
- `logoUrl` string
- `mainWebsiteUrl` string
- `accentColor` string
- `heroTagline` string
- `heroImageUrl` string
- `socialsJson` stringified JSON
- `contactEmail` string
- `contactPhone` string
- `regClosedMessage` string
- `successMessage` string
- `couponRequired` boolean

## REC_Program

Logical planner table: `programs`

Appwrite table id: `68e62391001de7d5c9be`

Purpose: programme container for the active conference.

Columns:

- `conferenceId` string, required
- `description` string
- `daysCount` integer
- `venueHalls` string array
- `status` string
- `slug` string
- `title` string
- `createdBy` string
- `createdAt` datetime
- `updatedAt` datetime

## REC_ProgramTimeBlocks

Logical planner table: `timeBlocks`

Appwrite table id: `rec_program_time_blocks`

Purpose: scheduled time blocks such as sessions, exhibitions, breaks, lunch, and shared hall blocks.

Columns:

- `conferenceId` string, required
- `programId` string, required
- `day` integer, required
- `date` string
- `startTime` datetime, required
- `endTime` datetime, required
- `startMinutes` integer, required
- `endMinutes` integer, required
- `type` string, required
- `label` string, required
- `allowSessions` boolean, required
- `venueScope` string, required
- `venueHalls` string array
- `sortOrder` integer
- `notes` string
- `createdBy` string
- `createdAt` datetime
- `updatedAt` datetime

## REC_Sessions

Logical planner table: `sessions`

Appwrite table id: `68e60fc1003b0bbb05d8`

Purpose: published programme sessions.

Columns:

- `programId` string, required
- `day` integer
- `startTime` datetime
- `toTime` datetime
- `venueHall` string
- `theme` string
- `title` string
- `preamble` string, may contain HTML
- `organizer` string
- `speakers` string
- `status` string
- `createdBy` string
- `updatedAt` datetime
- `createdAt` datetime
- `timeBlockIds` string array
- `sessionSpanType` string

## REC_SponsorCategories

Logical planner table: `sponsorCategories`

Appwrite table id: `rec_sponsor_categories`

Purpose: public sponsor groupings such as partner categories.

Columns:

- `conferenceId` string, required
- `name` string, required
- `slug` string
- `description` text
- `accentColor` string
- `displayOrder` integer
- `isActive` boolean
- `createdAt` datetime
- `updatedAt` datetime

## REC_Sponsors

Logical planner table: `sponsors`

Appwrite table id: `rec_sponsors`

Purpose: public sponsors and partners for the active conference.

Columns:

- `conferenceId` string, required
- `categoryId` string, references `REC_SponsorCategories.$id`
- `name` string, required
- `description` text
- `siteUrl` string
- `logoUrl` string
- `logoFileId` string
- `displayOrder` integer
- `isActive` boolean
- `isFeatured` boolean
- `contactPerson` string
- `contactEmail` string
- `internalNotes` text, do not expose in public chatbot answers
- `createdAt` datetime
- `updatedAt` datetime

