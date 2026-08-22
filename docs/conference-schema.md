# REC & EXPO Conference Schema

This document describes the public Appwrite TablesDB data and admin-published operational data used by the Renewable Energy Conference & Expo chatbot.

The default conference is selected from `REC_Conferences` where `isActive = true`. Previous editions are available only when a user explicitly supplies a year or REC edition, or uses wording such as “previous”, “past”, or “history”. At the time this schema was updated, the active conference row is:

- Title: Renewable Energy Conference & Expo 2026
- Short name: REC26 & EXPO
- Year: 2026
- Active row id: `6863b66b0016bd6d77ff`
- Dates: 2026-10-19 to 2026-10-22
- Venue: Kampala Serena Hotel, Kampala, Uganda
- Theme: From Systems to Scale: Powering Uganda's Green Economy

Conference rows are available for 2022 through 2026, published media albums are available for REC22 through REC25, and one published conference report is available for REC25. REC25 has an archived programme and published session rows, but no matching programme time blocks currently exist. Because eligible sessions must belong to an `allowSessions=true` block, those REC25 session rows are intentionally omitted from the public snapshot until the relationship data is restored. Missing historical programme, media, or report data must be reported as unavailable rather than inferred.

The chatbot must use only the public REC tables and the published operational store below. Registration records, coupons, locks, verifications, attendee data, and other private/security tables are not available to the planner.

## Generated Snapshot Schema

`data/generated/rec-current.json` uses normalized schema version `3.1`. It is intentionally conference-centric rather than a dump of Appwrite collections:

- Conference facts such as dates, venue, registration status, theme, website, and contacts are top-level fields.
- `program[]` contains one object per conference day.
- Each day contains all public `timeBlocks[]` and eligible `sessions[]` for that day.
- A session is eligible when its status is not `DRAFT` and it is linked to a time block where `allowSessions = true`.
- `sponsors[]` contains active sponsor categories, each with its active `sponsorList[]`.
- `operationalInfo[]` contains admin-published public venue and visitor facts for the active conference.
- `media[]` contains published media for the active conference.
- `reports[]` contains published reports and public report links for the active conference.
- `previousConferences[]` contains previous edition facts and, where available, normalized `program[]`, `sponsors[]`, `media[]`, and `reports[]`.
- Readable times are stored in `startTime` and `endTime`; original ISO timestamps are retained in `startAt` and `endAt` for reliable sorting and runtime conversion.

The runtime adapter converts this normalized document back into the logical table arrays described below. It also accepts schema versions `2.0` and `3.0` plus the legacy collection-shaped snapshot during migration.

## Table Relationships

- `REC_Conferences` is the parent table.
- `REC_Program.conferenceId` points to its conference edition.
- `REC_ProgramTimeBlocks.programId` points to `REC_Program.$id`.
- `REC_ProgramTimeBlocks.conferenceId` points to `REC_Conferences.$id`.
- `REC_Sessions.programId` points to `REC_Program.$id`.
- `REC_Sessions.timeBlockIds[]` can point to one or more `REC_ProgramTimeBlocks.$id` values.
- `REC_SponsorCategories.conferenceId` points to `REC_Conferences.$id`.
- `REC_Sponsors.conferenceId` points to `REC_Conferences.$id`.
- `REC_Sponsors.categoryId` points to `REC_SponsorCategories.$id`.
- `REC Media Items.conferenceId` points to `REC_Conferences.$id`.
- `REC Conference Reports.conferenceId` points to `REC_Conferences.$id`.
- Admin operational entries are stored locally and are bound server-side to the active `REC_Conferences.$id`.

## Query Policy

The planner may request lookups against these logical tables only:

- `conferences`
- `programs`
- `timeBlocks`
- `sessions`
- `sponsorCategories`
- `sponsors`
- `mediaItems`
- `reports`
- `operationalInfo`

The server defaults every planner operation to the active conference. Historical rows become eligible only when an operation contains the explicitly requested `year` or `conferenceYear`, or `isActive=false`. The planner should not request Appwrite table ids directly, raw query strings, private tables, or unlisted columns.

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
- `isPublished`: media, report, or operational-information published flag.
- `year` or `conferenceYear`: explicit conference edition year.
- `mediaType`: `image_album` or `video`.
- `reportType`: `conference_report`, `proceedings`, `outcomes`, `communique`, or `other`.
- `isFeatured`: media, report, or sponsor featured flag.
- `category`: operational-information category.

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
- `year`
- `conferenceYear`
- `publicationDate`

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

Use `{"lookup": false, "reason": "..."}` when the user is not asking for public REC & EXPO information.

## REC_Conferences

Logical planner table: `conferences`

Appwrite table id: `6863ae070028061694f1`

Purpose: one row per conference edition. The active row is the default; inactive rows support explicitly historical questions.

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

Purpose: programme container for a conference edition. REC25 is archived and REC26 is published.

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

Purpose: public sponsors and partners grouped by conference edition.

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

## REC Media Items

Logical planner table: `mediaItems`

Appwrite table id: `rec_media_items`

Purpose: published photo albums and videos grouped by conference edition. At the time of this update, four published image albums exist for REC22, REC23, REC24, and REC25.

Columns:

- `conferenceId` string, references `REC_Conferences.$id`
- `mediaType` enum: `image_album` or `video`
- `title` string
- `slug` string
- `description` text
- `externalUrl` URL for an external album or media page
- `videoUrl` URL for video media
- `thumbnailUrl` URL
- `thumbnailFileId` string
- `sampleImagesJson` stringified JSON array of public sample image objects
- `displayOrder` integer
- `isFeatured` boolean
- `isPublished` boolean; only `true` rows enter public context
- `createdBy` string, not exposed in public answers
- `updatedBy` string, not exposed in public answers
- `createdAt` datetime
- `updatedAt` datetime

## REC Conference Reports

Logical planner table: `reports`

Appwrite table id: `rec_conference_reports`

Purpose: published reports and conference documents grouped by conference edition. At the time of this update, one featured and published report exists for REC25: `REC 25 Conference Report`.

Columns:

- `conferenceId` string, required; references `REC_Conferences.$id`
- `reportType` enum: `conference_report`, `proceedings`, `outcomes`, `communique`, or `other`
- `title` string, required
- `summary` text
- `reportUrl` URL string, required
- `coverImageUrl` URL string
- `publicationDate` datetime
- `displayOrder` integer
- `isFeatured` boolean
- `isPublished` boolean; only `true` rows enter snapshots, model context, and Qdrant
- `createdBy` string, not exposed in public answers
- `updatedBy` string, not exposed in public answers
- `createdAt` datetime
- `updatedAt` datetime

Reports are separate from media items. A report query must use this table and return `reportUrl`; it must not infer report availability from a photo album or video row.

## Admin Published Operational Information

Logical planner table: `operationalInfo`

Runtime file: `data/admin/conference-knowledge.json`

Purpose: public active-conference venue and visitor guidance that does not belong in the core Appwrite conference schema, such as guest Wi-Fi, transport, accessibility, catering, and safety information.

Fields:

- `id` generated identifier
- `conferenceId` server-assigned active conference id
- `category` enum: `venue`, `connectivity`, `transport`, `accessibility`, `catering`, `registration`, `safety`, or `other`
- `title` public topic
- `answer` public Markdown answer
- `keywords[]` matching terms
- `isPublished` boolean; only `true` entries enter snapshots, model context, and Qdrant
- `createdAt` datetime
- `updatedAt` datetime
- `updatedBy` admin email, not exposed in public answers

Admins manage these entries through `/admin`. The API ignores client-supplied conference ids and always binds updates to the active conference. Only public guest information is appropriate; staff networks, internal systems, and private credentials must not be stored here.
