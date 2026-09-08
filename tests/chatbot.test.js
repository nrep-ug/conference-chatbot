import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecDocuments,
  getDirectRecAnswer,
} from "../src/lib/rec-data.js";
import {
  buildGeneratedRecSnapshot,
  renderRecSnapshotMarkdown,
  snapshotToRuntimeData,
} from "../src/lib/rec-snapshot.js";

import { createSnapshot } from "./fixtures/rec-snapshot.js";

test("normalizes active conference data and excludes ineligible sessions", () => {
  const snapshot = createSnapshot();
  snapshot.sessions.find((item) => item.$id === "cooking-day-2").speakers =
    "<ul><li>Speaker One</li><li><p>Speaker Two</p></li></ul>";
  const generated = buildGeneratedRecSnapshot(snapshot);
  const sessions = generated.program.flatMap((day) => day.sessions);

  assert.equal(generated.schemaVersion, "3.1");
  assert.equal(generated.program.length, 4);
  assert.equal(sessions.length, 5);
  assert.ok(sessions.every((item) => item.status === "PUBLISHED"));
  assert.ok(!sessions.some((item) => item.id === "unlinked-session"));
  assert.equal(sessions[0].title, "Financing Universal Energy Access");
  assert.equal(
    sessions.find((item) => item.id === "cooking-day-2").speakers,
    "Speaker One; Speaker Two"
  );
  assert.equal(generated.sponsors[0].sponsorList[0].name, "GIZ Uganda");
  assert.equal(generated.reports.length, 0);
  assert.equal(generated.previousConferences[0].reports.length, 1);
  assert.equal(
    generated.previousConferences[0].reports[0].reportUrl,
    "https://example.org/rec25-report.pdf"
  );
  assert.ok(
    !generated.previousConferences[0].reports.some(
      (report) => report.id === "hidden-rec25-report"
    )
  );
});

test("round trips the normalized snapshot into the runtime contract", () => {
  const generated = buildGeneratedRecSnapshot(createSnapshot());
  const runtime = snapshotToRuntimeData(generated);

  assert.equal(runtime.conference.$id, "conference-1");
  assert.equal(runtime.timeBlocks.length, 10);
  assert.equal(runtime.sessions.length, 5);
  assert.equal(runtime.sponsors.length, 1);
  assert.equal(runtime.pastConferences.length, 2);
  assert.equal(runtime.pastConferences[0].sessions.length, 1);
  assert.equal(runtime.pastConferences[0].reports.length, 1);
  assert.equal(runtime.pastConferences[1].mediaItems.length, 1);
  assert.equal(runtime.reports.length, 0);
  assert.equal(runtime.sessions[0].$tableId, generated.source.tables.sessions);
});

test("includes organizers and speakers in model and vector context", () => {
  const snapshot = createSnapshot();
  const documents = buildRecDocuments(snapshot);
  const sessionDocument = documents.find(
    (document) => document.payload?.rowId === "cooking-day-2"
  );
  const markdown = renderRecSnapshotMarkdown(snapshot);

  assert.ok(sessionDocument);
  assert.match(sessionDocument.payload.text, /Organizer: NREP/);
  assert.match(sessionDocument.payload.text, /Speakers: TBC/);
  assert.match(markdown, /\| Speakers \|/);
  assert.match(markdown, /Clean Cooking Technology Forum/);
  assert.match(markdown, /REC25 Photos/);
  assert.match(markdown, /REC 25 Conference Report/);
  assert.match(markdown, /https:\/\/example\.org\/rec25-report\.pdf/);
});

test("answers focused conference facts without duplicating an overview", async () => {
  const result = await getDirectRecAnswer("What is the conference theme?", {
    snapshot: createSnapshot(),
  });

  assert.match(result.answer, /^The theme for/);
  assert.match(result.answer, /From Systems to Scale/);
  assert.doesNotMatch(result.answer, /Daily focus areas/);
});

test("preserves cooking and finance sections in one compound question", async () => {
  const result = await getDirectRecAnswer(
    "Tell me about cooking technology and finance sessions",
    { snapshot: createSnapshot() }
  );

  assert.match(result.answer, /Published sessions related to cooking technologies/);
  assert.match(result.answer, /Clean Cooking Technology Forum/);
  assert.match(result.answer, /For someone in finance/);
  assert.match(result.answer, /Renewable Energy Investment Forum/);
});

test("lists topic sessions without a redundant single-session preface", async () => {
  const result = await getDirectRecAnswer(
    "Which sessions mention clean cooking?",
    { snapshot: createSnapshot() }
  );

  assert.match(result.answer, /^Published sessions related to cooking technologies/);
  assert.equal(
    result.answer.match(/Clean Cooking Technology Forum/g)?.length,
    1
  );
});

test("handles multi-day, ceremony, and day-part questions deterministically", async () => {
  const snapshot = createSnapshot();
  const allDays = await getDirectRecAnswer("List sessions for all days", {
    snapshot,
  });
  const ceremony = await getDirectRecAnswer(
    "When is the closing ceremony?",
    { snapshot }
  );
  const ceremonies = await getDirectRecAnswer(
    "When are the opening and closing ceremonies?",
    { snapshot }
  );
  const afternoon = await getDirectRecAnswer(
    "What happens on day 2 in the afternoon?",
    { snapshot }
  );

  assert.match(allDays.answer, /Day 1/);
  assert.match(allDays.answer, /Day 4/);
  assert.match(ceremony.answer, /Day 4/);
  assert.match(ceremony.answer, /3:30 pm to 5:00 pm/);
  assert.match(ceremonies.answer, /Opening Ceremony/);
  assert.match(ceremonies.answer, /Day 1/);
  assert.match(ceremonies.answer, /Closing Ceremony/);
  assert.match(ceremonies.answer, /Day 4/);
  assert.match(afternoon.answer, /Day 2/);
  assert.match(afternoon.answer, /Lunch Break/);
});

test("does not claim an off-topic question has a deterministic REC answer", async () => {
  const result = await getDirectRecAnswer("What is quantum computing?", {
    snapshot: createSnapshot(),
  });

  assert.equal(result, null);
});

test("does not reduce exhibitor guidance to exhibition hours", async () => {
  const result = await getDirectRecAnswer(
    "Based on the conference, what questions should I ask exhibitors about battery energy storage, and how should I evaluate their answers?",
    { snapshot: createSnapshot() }
  );

  assert.equal(result, null);
});

test("answers programme progression and grounded trade-off analysis", async () => {
  const snapshot = createSnapshot();
  const connectedDays = await getDirectRecAnswer(
    "How do the sessions connect across the four days?",
    { snapshot }
  );
  const tradeOffs = await getDirectRecAnswer(
    "What strategic trade-offs emerge from the programme?",
    { snapshot }
  );

  assert.match(connectedDays.answer, /four-stage progression/);
  assert.match(connectedDays.answer, /Day 1/);
  assert.match(connectedDays.answer, /Day 4/);
  assert.match(connectedDays.answer, /not necessarily direct continuations/);
  assert.match(tradeOffs.answer, /reasonable planning interpretations/);
  assert.match(tradeOffs.answer, /Breadth versus depth/);
  assert.match(tradeOffs.answer, /not positions formally stated/);
});

test("preserves progression and sponsor requests in a compound question", async () => {
  const result = await getDirectRecAnswer(
    "How do the sessions connect across the four days, and who are the sponsors?",
    { snapshot: createSnapshot() }
  );

  assert.match(result.answer, /four-stage progression/);
  assert.match(result.answer, /GIZ Uganda/);
});

test("keeps sponsor and session requests focused unless an overview is explicit", async () => {
  const snapshot = createSnapshot();
  snapshot.sponsorCategories.push({
    $id: "platinum",
    $tableId: "sponsor-categories",
    conferenceId: snapshot.conference.$id,
    name: "Platinum",
    displayOrder: 0,
    isActive: true,
  });
  snapshot.sponsors.push({
    $id: "fcdo",
    $tableId: "sponsors",
    conferenceId: snapshot.conference.$id,
    categoryId: "platinum",
    name: "FCDO",
    description: "International development partner",
    siteUrl: "https://example.org/fcdo",
    displayOrder: 0,
    isActive: true,
  });

  const genericSponsors = await getDirectRecAnswer(
    "Tell me about the sponsors?",
    { snapshot }
  );
  const scopedSponsors = await getDirectRecAnswer(
    "Tell me about the REC26 and EXPO sponsors",
    { snapshot }
  );
  const sponsorOverview = await getDirectRecAnswer(
    "Give me an overview of REC26 sponsors",
    { snapshot }
  );
  const sessions = await getDirectRecAnswer(
    "Tell me more about the REC26 sessions",
    { snapshot }
  );
  const describedSessions = await getDirectRecAnswer(
    "Describe the REC26 sessions",
    { snapshot }
  );
  const partners = await getDirectRecAnswer("Who are the REC26 partners?", {
    snapshot,
  });
  const categories = await getDirectRecAnswer(
    "What sponsor categories are available?",
    { snapshot }
  );
  const explicitCompound = await getDirectRecAnswer(
    "Give me a conference overview including sponsors",
    { snapshot }
  );

  for (const result of [genericSponsors, scopedSponsors, sponsorOverview]) {
    assert.match(result.answer, /^## REC26 & EXPO Sponsors and Partners/);
    assert.match(result.answer, /### Platinum/);
    assert.match(result.answer, /\[FCDO\]\(https:\/\/example\.org\/fcdo\)/);
    assert.match(result.answer, /### Partners/);
    assert.match(result.answer, /GIZ Uganda/);
    assert.doesNotMatch(result.answer, /Uganda's renewable energy conference/);
    assert.doesNotMatch(result.answer, /Daily focus areas/);
  }

  assert.match(sessions.answer, /listed programme sessions/);
  assert.doesNotMatch(sessions.answer, /Uganda's renewable energy conference/);
  assert.match(describedSessions.answer, /listed programme sessions/);
  assert.doesNotMatch(
    describedSessions.answer,
    /Uganda's renewable energy conference/
  );
  assert.match(partners.answer, /^## REC26 & EXPO Partners/);
  assert.doesNotMatch(partners.answer, /### Partners/);
  assert.match(categories.answer, /^## REC26 & EXPO Sponsor Categories/);
  assert.match(categories.answer, /\*\*Platinum:\*\* 1 listed sponsor/);
  assert.match(categories.answer, /\*\*Partners:\*\* 1 listed sponsor/);
  assert.match(
    explicitCompound.answer,
    /Uganda's premier renewable energy conference/
  );
  assert.match(explicitCompound.answer, /REC26 & EXPO Sponsors and Partners/);
});

test("does not mistake unpublished venue logistics for venue location", async () => {
  const snapshot = createSnapshot();
  const wifi = await getDirectRecAnswer("Is Wi-Fi available at the venue?", {
    snapshot,
  });
  const compound = await getDirectRecAnswer(
    "Where is the conference, and is parking available?",
    { snapshot }
  );
  const translation = await getDirectRecAnswer(
    "Will translation services be provided at the conference?",
    { snapshot }
  );

  assert.match(wifi.answer, /could not find published information/);
  assert.match(wifi.answer, /Wi-Fi or internet access/);
  assert.doesNotMatch(wifi.answer, /will take place at/);
  assert.doesNotMatch(wifi.answer, /Kampala Serena Hotel/);
  assert.match(compound.answer, /Kampala Serena Hotel/);
  assert.match(compound.answer, /could not find published information/);
  assert.match(compound.answer, /parking/);
  assert.match(translation.answer, /could not find that information/);
  assert.match(translation.answer, /conference@example.org/);
});

test("answers published admin venue knowledge and preserves compound facts", async () => {
  const snapshot = createSnapshot();
  snapshot.operationalInfo = [
    {
      id: "guest-wifi",
      $id: "guest-wifi",
      $tableId: "admin_operational_info",
      conferenceId: snapshot.conference.$id,
      category: "connectivity",
      title: "Guest Wi-Fi access",
      answer: "Connect to **REC-Guest** using password `GreenEnergy26`.",
      keywords: ["wifi", "internet", "password", "connectivity"],
      isPublished: true,
    },
    {
      id: "staff-note",
      $id: "staff-note",
      $tableId: "admin_operational_info",
      conferenceId: snapshot.conference.$id,
      category: "other",
      title: "Unpublished note",
      answer: "This must never reach public context.",
      keywords: ["secret note"],
      isPublished: false,
    },
  ];

  const wifi = await getDirectRecAnswer("What is the Wi-Fi password?", {
    snapshot,
  });
  const compound = await getDirectRecAnswer(
    "Where is REC26, and what is the guest Wi-Fi password?",
    { snapshot }
  );
  const historicalCompound = await getDirectRecAnswer(
    "Compare the themes of REC25 and REC26, show REC24 photos, then give me the current Wi-Fi password",
    { snapshot }
  );
  const generated = buildGeneratedRecSnapshot(snapshot);
  const documents = buildRecDocuments(snapshot);

  assert.match(wifi.answer, /REC-Guest/);
  assert.match(wifi.answer, /GreenEnergy26/);
  assert.doesNotMatch(wifi.answer, /could not find published information/);
  assert.match(compound.answer, /Kampala Serena Hotel/);
  assert.match(compound.answer, /REC-Guest/);
  assert.match(historicalCompound.answer, /Transforming Energy Systems/);
  assert.match(historicalCompound.answer, /From Systems to Scale/);
  assert.match(historicalCompound.answer, /REC24 Photos/);
  assert.doesNotMatch(historicalCompound.answer, /REC25 Photos/);
  assert.match(historicalCompound.answer, /GreenEnergy26/);
  assert.equal(generated.operationalInfo.length, 1);
  assert.ok(
    documents.some(
      (document) => document.payload.sourceType === "operational_info"
    )
  );
  assert.ok(
    !documents.some((document) => document.payload.text.includes("must never"))
  );
});

test("answers explicitly scoped historical conference questions", async () => {
  const snapshot = createSnapshot();
  const history = await getDirectRecAnswer(
    "Tell me about the previous conferences",
    { snapshot }
  );
  const editionHistory = await getDirectRecAnswer(
    "Tell me more about the previous conference editions?",
    { snapshot }
  );
  const latestPrevious = await getDirectRecAnswer(
    "Tell me more about the previous conference",
    { snapshot }
  );
  const theme = await getDirectRecAnswer("What was the theme of REC25?", {
    snapshot,
  });
  const sessions = await getDirectRecAnswer(
    "List the Day 1 sessions for REC25",
    { snapshot }
  );
  const speakers = await getDirectRecAnswer(
    "Who were the speakers on Day 1 at REC25?",
    { snapshot }
  );
  const media = await getDirectRecAnswer("Show me photos from REC24", {
    snapshot,
  });
  const comparison = await getDirectRecAnswer("Compare REC25 and REC26", {
    snapshot,
  });

  assert.match(history.answer, /REC25/);
  assert.match(history.answer, /REC24/);
  assert.match(editionHistory.answer, /previous REC editions available/i);
  assert.match(editionHistory.answer, /REC25/);
  assert.match(editionHistory.answer, /REC24/);
  assert.doesNotMatch(editionHistory.answer, /REC26/);
  assert.match(editionHistory.answer, /Archive coverage/);
  assert.match(editionHistory.answer, /\[REC25 Photos\]\(https:\/\/example\.org\/rec25-photos\)/);
  assert.equal(editionHistory.retrievalPolicy?.qdrantComplement, false);
  assert.match(latestPrevious.answer, /REC25/);
  assert.doesNotMatch(latestPrevious.answer, /REC24/);
  assert.match(theme.answer, /Transforming Energy Systems/);
  assert.doesNotMatch(theme.answer, /From Systems to Scale/);
  assert.match(sessions.answer, /REC25 Green Finance Forum/);
  assert.match(speakers.answer, /Jane Doe/);
  assert.match(media.answer, /https:\/\/example\.org\/rec24-photos/);
  assert.match(
    media.answer,
    /\[Open album\]\(https:\/\/example\.org\/rec24-photos\)/
  );
  assert.match(comparison.answer, /REC25/);
  assert.match(comparison.answer, /REC26/);
  assert.match(comparison.answer, /Archive coverage/);
});

test("synthesizes theme evolution across editions without a model call", async () => {
  const snapshot = createSnapshot();
  const question =
    "Analyze how the REC themes evolved across the available conference editions, and explain what that suggests for a first-time attendee.";
  const result = await getDirectRecAnswer(question, { snapshot });
  const focusedContext = renderRecSnapshotMarkdown(snapshot, { question });

  assert.match(result.answer, /2024 \(REC24\)/);
  assert.match(result.answer, /2025 \(REC25\)/);
  assert.match(result.answer, /2026 \(REC26 & EXPO\)/);
  assert.match(result.answer, /Grounded interpretation/);
  assert.match(result.answer, /first-time attendee/i);
  assert.match(result.answer, /Day 1/);
  assert.equal(result.sources.length, 3);
  assert.match(focusedContext, /Available Conference Editions/);
  assert.doesNotMatch(focusedContext, /REC25 Green Finance Forum/);
  assert.doesNotMatch(focusedContext, /Sponsors And Partners/);
  assert.doesNotMatch(focusedContext, /Published Media/);
});

test("keeps edition lists, venues, current media, and reports correctly scoped", async () => {
  const snapshot = createSnapshot();
  const themes = await getDirectRecAnswer(
    "What were the themes of REC24, REC25 and REC26?",
    { snapshot }
  );
  const comparison = await getDirectRecAnswer(
    "Compare the theme and venue of REC24 with REC26.",
    { snapshot }
  );
  const currentMedia = await getDirectRecAnswer(
    "Do you have media for the current conference, such as photos?",
    { snapshot }
  );
  const report = await getDirectRecAnswer("Do you have a report for REC25?", {
    snapshot,
  });
  const currentReport = await getDirectRecAnswer(
    "Do you have a report for the current conference?",
    { snapshot }
  );
  const availableReports = await getDirectRecAnswer(
    "What reports are available from previous conferences?",
    { snapshot }
  );
  const genericReport = await getDirectRecAnswer(
    "Can I download a published conference PDF?",
    { snapshot }
  );
  const proceedings = await getDirectRecAnswer(
    "Are proceedings available for REC25?",
    { snapshot }
  );
  const conferenceReport = await getDirectRecAnswer(
    "Can I read the REC25 conference report?",
    { snapshot }
  );

  assert.match(themes.answer, /Transforming Livelihoods Through Clean Energy Access/);
  assert.match(themes.answer, /Transforming Energy Systems/);
  assert.match(themes.answer, /From Systems to Scale/);
  assert.match(comparison.answer, /Speke Resort Convention Centre/);
  assert.match(comparison.answer, /Kampala Serena Hotel/);
  assert.match(currentMedia.answer, /No published media items/);
  assert.doesNotMatch(currentMedia.answer, /REC24 Photos/);
  assert.match(report.answer, /REC 25 Conference Report/);
  assert.match(
    report.answer,
    /\[Open report\]\(https:\/\/example\.org\/rec25-report\.pdf\)/
  );
  assert.match(report.answer, /Published REC25 conference outcomes/);
  assert.doesNotMatch(report.answer, /REC25 Photos/);
  assert.doesNotMatch(report.answer, /Internal REC25 Draft Report/);
  assert.match(currentReport.answer, /No published report or conference document/);
  assert.doesNotMatch(currentReport.answer, /REC 25 Conference Report/);
  assert.match(availableReports.answer, /REC 25 Conference Report/);
  assert.doesNotMatch(availableReports.answer, /Internal REC25 Draft Report/);
  assert.match(genericReport.answer, /REC 25 Conference Report/);
  assert.doesNotMatch(genericReport.answer, /REC26 & EXPO/);
  assert.match(proceedings.answer, /could not find a published proceedings document/);
  assert.doesNotMatch(proceedings.answer, /rec25-report\.pdf/);
  assert.match(conferenceReport.answer, /REC 25 Conference Report/);
});

test("indexes active and historical media and reports with edition metadata", () => {
  const snapshot = createSnapshot();
  const documents = buildRecDocuments(snapshot);
  const historicalSession = documents.find(
    (document) => document.payload.rowId === "rec25-finance"
  );
  const historicalMedia = documents.find(
    (document) => document.payload.rowId === "rec24-photos"
  );
  const historicalReport = documents.find(
    (document) => document.payload.rowId === "rec25-report"
  );
  const historicalMarkdown = renderRecSnapshotMarkdown(snapshot, {
    question: "Show REC24 photos",
  });

  assert.equal(historicalSession.payload.year, 2025);
  assert.equal(historicalSession.payload.isActiveConference, false);
  assert.equal(historicalMedia.payload.sourceType, "conference_media");
  assert.equal(historicalMedia.payload.year, 2024);
  assert.equal(historicalReport.payload.sourceType, "conference_report");
  assert.equal(historicalReport.payload.year, 2025);
  assert.equal(historicalReport.payload.isActiveConference, false);
  assert.match(
    historicalReport.payload.text,
    /https:\/\/example\.org\/rec25-report\.pdf/
  );
  assert.ok(
    !documents.some(
      (document) => document.payload.rowId === "hidden-rec25-report"
    )
  );
  assert.ok(
    historicalMarkdown.indexOf(
      "Previous Conference: Renewable Energy Conference & Expo 2024"
    ) <
      historicalMarkdown.indexOf(
        "Active Conference: Renewable Energy Conference & Expo 2026"
      )
  );
});
