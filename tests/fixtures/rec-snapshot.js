export function createSnapshot() {
  const conferenceId = "conference-1";
  const programId = "program-1";
  const dayDetails = [
    ["2026-10-19", "Day 1", "Renewable Energy Policy & Investment"],
    ["2026-10-20", "Day 2", "Technology & Innovation"],
    ["2026-10-21", "Day 3", "Implementation & Sustainability"],
    ["2026-10-22", "Day 4", "Impact, Scale & Regional Leadership"],
  ];
  const blocks = dayDetails.flatMap(([date], index) => {
    const day = index + 1;

    return [
      {
        $id: `day-${day}-sessions`,
        $tableId: "time-blocks",
        conferenceId,
        programId,
        day,
        date,
        startTime: `${date}T08:30:00+03:00`,
        endTime: `${date}T15:30:00+03:00`,
        startMinutes: 510,
        endMinutes: 930,
        type: "SESSION",
        label: "Conference Sessions",
        allowSessions: true,
        venueHalls: ["Victoria Hall", "Katonga Hall"],
        sortOrder: 1,
      },
      {
        $id: `day-${day}-lunch`,
        $tableId: "time-blocks",
        conferenceId,
        programId,
        day,
        date,
        startTime: `${date}T13:00:00+03:00`,
        endTime: `${date}T14:00:00+03:00`,
        startMinutes: 780,
        endMinutes: 840,
        type: "LUNCH",
        label: "Lunch Break",
        allowSessions: false,
        venueHalls: ["Restaurant/Food Court"],
        sortOrder: 2,
      },
    ];
  });

  blocks.push(
    {
      $id: "opening",
      $tableId: "time-blocks",
      conferenceId,
      programId,
      day: 1,
      date: "2026-10-19",
      startTime: "2026-10-19T15:30:00+03:00",
      endTime: "2026-10-19T17:00:00+03:00",
      type: "CEREMONY",
      label: "Opening Ceremony",
      allowSessions: false,
      venueHalls: ["Victoria Hall"],
      sortOrder: 3,
    },
    {
      $id: "closing",
      $tableId: "time-blocks",
      conferenceId,
      programId,
      day: 4,
      date: "2026-10-22",
      startTime: "2026-10-22T15:30:00+03:00",
      endTime: "2026-10-22T17:00:00+03:00",
      type: "CEREMONY",
      label: "Closing Ceremony",
      allowSessions: false,
      venueHalls: ["Victoria Hall"],
      sortOrder: 3,
    }
  );

  const session = (id, day, title, theme, hall = "Victoria Hall") => ({
    $id: id,
    $tableId: "sessions",
    conferenceId,
    programId,
    day,
    startTime: `2026-10-${18 + day}T08:30:00+03:00`,
    toTime: `2026-10-${18 + day}T15:30:00+03:00`,
    venueHall: hall,
    theme,
    title,
    preamble: `${title} programme details`,
    organizer: "NREP",
    speakers: "TBC",
    status: "PUBLISHED",
    timeBlockIds: [`day-${day}-sessions`],
  });

  const historicalConference = {
    $id: "conference-2025",
    $tableId: "conferences",
    title: "Renewable Energy Conference & Expo 2025",
    shortName: "REC25",
    year: 2025,
    startDate: "2025-10-20T00:00:00.000Z",
    endDate: "2025-10-22T00:00:00.000Z",
    location: "Kampala, Uganda",
    venue: "Kampala Serena Hotel",
    isActive: false,
    theme: "Transforming Energy Systems for Livelihoods and Conservation",
    days: JSON.stringify([
      {
        date: "2025-10-20",
        label: "Day 1",
        theme: "Policy and investment",
      },
    ]),
  };
  const historicalProgram = {
    $id: "program-2025",
    $tableId: "programs",
    conferenceId: historicalConference.$id,
    title: "REC25 archived programme",
    description: "Published historical programme",
    daysCount: 1,
    venueHalls: ["Victoria Hall"],
    status: "ARCHIVED",
  };
  const historicalBlock = {
    $id: "rec25-day-1-sessions",
    $tableId: "time-blocks",
    conferenceId: historicalConference.$id,
    programId: historicalProgram.$id,
    day: 1,
    date: "2025-10-20",
    startTime: "2025-10-20T09:00:00+03:00",
    endTime: "2025-10-20T12:00:00+03:00",
    type: "SESSION",
    label: "Morning sessions",
    allowSessions: true,
    venueHalls: ["Victoria Hall"],
  };
  const historicalSession = {
    $id: "rec25-finance",
    $tableId: "sessions",
    conferenceId: historicalConference.$id,
    programId: historicalProgram.$id,
    day: 1,
    startTime: "2025-10-20T09:00:00+03:00",
    toTime: "2025-10-20T12:00:00+03:00",
    venueHall: "Victoria Hall",
    theme: "Green finance",
    title: "REC25 Green Finance Forum",
    preamble: "Financing energy access projects",
    organizer: "NREP",
    speakers: "Jane Doe",
    status: "PUBLISHED",
    timeBlockIds: [historicalBlock.$id],
  };
  const historicalMedia = {
    $id: "rec25-photos",
    $tableId: "media-items",
    conferenceId: historicalConference.$id,
    mediaType: "image_album",
    title: "REC25 Photos",
    description: "Official REC25 photo album",
    externalUrl: "https://example.org/rec25-photos",
    sampleImagesJson: JSON.stringify([
      { url: "https://example.org/rec25-sample.jpg", name: "REC25 sample" },
    ]),
    displayOrder: 1,
    isPublished: true,
  };
  const historicalReport = {
    $id: "rec25-report",
    $tableId: "conference-reports",
    conferenceId: historicalConference.$id,
    reportType: "conference_report",
    title: "REC 25 Conference Report",
    summary: "Published REC25 conference outcomes and proceedings.",
    reportUrl: "https://example.org/rec25-report.pdf",
    coverImageUrl: "https://example.org/rec25-report-cover.jpg",
    publicationDate: "2026-03-01T00:00:00.000Z",
    displayOrder: 0,
    isFeatured: true,
    isPublished: true,
  };
  const unpublishedHistoricalReport = {
    ...historicalReport,
    $id: "hidden-rec25-report",
    title: "Internal REC25 Draft Report",
    reportUrl: "https://example.org/internal-report.pdf",
    isPublished: false,
  };
  const rec24Conference = {
    $id: "conference-2024",
    $tableId: "conferences",
    title: "Renewable Energy Conference & Expo 2024",
    shortName: "REC24",
    year: 2024,
    startDate: "2024-10-31T00:00:00.000Z",
    endDate: "2024-11-02T00:00:00.000Z",
    location: "Munyonyo, Uganda",
    venue: "Speke Resort Convention Centre",
    isActive: false,
    theme: "Transforming Livelihoods Through Clean Energy Access",
    days: "[]",
  };

  return {
    metadata: {
      generatedAt: "2026-08-22T00:00:00.000Z",
      source: "test",
      activeConferenceId: conferenceId,
    },
    conference: {
      $id: conferenceId,
      $tableId: "conferences",
      title: "Renewable Energy Conference & Expo 2026",
      shortName: "REC26 & EXPO",
      year: 2026,
      description: "Uganda's renewable energy conference",
      startDate: "2026-10-19T00:00:00.000Z",
      endDate: "2026-10-22T00:00:00.000Z",
      location: "Kampala, Uganda",
      venue: "Kampala Serena Hotel",
      isActive: true,
      registrationOpen: false,
      regClosedMessage: "Registration opening soon",
      registrationFee: JSON.stringify({ attendee: 0 }),
      maxLimits: JSON.stringify({ attendee: 800 }),
      currentCounts: JSON.stringify({ attendee: 0 }),
      theme: "From Systems to Scale: Powering Uganda's Green Economy",
      mainWebsiteUrl: "https://nrep.ug/rec/",
      contactEmail: "conference@example.org",
      contactPhone: "+256000000000",
      days: JSON.stringify(
        dayDetails.map(([date, label, theme]) => ({ date, label, theme }))
      ),
    },
    programs: [
      {
        $id: programId,
        $tableId: "programs",
        conferenceId,
        title: "Main programme",
        description: "Published REC programme",
        daysCount: 4,
        venueHalls: ["Victoria Hall", "Katonga Hall"],
        status: "PUBLISHED",
      },
    ],
    timeBlocks: blocks,
    sessions: [
      session(
        "finance-day-1",
        1,
        "Financing Universal Energy Access ",
        "Finance and Investment",
        "Katonga Hall"
      ),
      session(
        "cooking-day-2",
        2,
        "Clean Cooking Technology Forum",
        "Clean Cooking"
      ),
      session(
        "investment-day-2",
        2,
        "Renewable Energy Investment Forum",
        "Investment and Blended Finance",
        "Katonga Hall"
      ),
      session(
        "implementation-day-3",
        3,
        "Productive Use Energy",
        "Implementation & Sustainability"
      ),
      session(
        "scale-day-4",
        4,
        "Regional Energy Leadership",
        "Impact and Scale"
      ),
      {
        ...session("draft-session", 2, "Draft Session", "Draft"),
        status: "DRAFT",
      },
      {
        ...session("unlinked-session", 2, "Unlinked Session", "Test"),
        timeBlockIds: ["missing-block"],
      },
    ],
    sponsorCategories: [
      {
        $id: "partners",
        $tableId: "sponsor-categories",
        conferenceId,
        name: "Partners",
        displayOrder: 1,
        isActive: true,
      },
    ],
    sponsors: [
      {
        $id: "giz",
        $tableId: "sponsors",
        conferenceId,
        categoryId: "partners",
        name: "GIZ Uganda",
        description: "Energy and climate partner",
        siteUrl: "https://example.org/giz",
        displayOrder: 1,
        isActive: true,
      },
    ],
    mediaItems: [],
    reports: [],
    operationalInfo: [],
    pastConferences: [
      {
        conference: historicalConference,
        programs: [historicalProgram],
        timeBlocks: [historicalBlock],
        sessions: [historicalSession],
        sponsorCategories: [],
        sponsors: [],
        mediaItems: [historicalMedia],
        reports: [historicalReport, unpublishedHistoricalReport],
      },
      {
        conference: rec24Conference,
        programs: [],
        timeBlocks: [],
        sessions: [],
        sponsorCategories: [],
        sponsors: [],
        mediaItems: [
          {
            ...historicalMedia,
            $id: "rec24-photos",
            conferenceId: rec24Conference.$id,
            title: "REC24 Photos",
            description: "Official REC24 photo album",
            externalUrl: "https://example.org/rec24-photos",
            sampleImagesJson: "[]",
          },
        ],
        reports: [],
      },
    ],
  };
}

