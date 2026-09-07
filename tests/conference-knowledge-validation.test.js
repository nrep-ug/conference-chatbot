import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  assertValidConferenceKnowledgeItems,
  CONFERENCE_KNOWLEDGE_LIMITS,
  ConferenceKnowledgeValidationError,
  isConferenceKnowledgeItemPublishable,
  normalizeConferenceKnowledgeKeywords,
  validateConferenceKnowledgeItemForPublishing,
  validateConferenceKnowledgeItems,
} from "../src/lib/conference-knowledge-validation.js";

function validItem(overrides = {}) {
  return {
    id: "visitor-info-1",
    category: "connectivity",
    title: "Guest Wi-Fi",
    answer: "Connect to the public conference guest network.",
    keywords: ["wifi", "internet"],
    isPublished: true,
    ...overrides,
  };
}

test("allows incomplete operational entries only while they remain drafts", () => {
  const draft = {
    id: "",
    category: "venue",
    title: "",
    answer: "",
    keywords: [],
    isPublished: false,
  };

  assert.equal(validateConferenceKnowledgeItems([draft]).valid, true);

  const publication = validateConferenceKnowledgeItemForPublishing(draft);
  assert.equal(publication.valid, false);
  assert.deepEqual(
    publication.issues.map((issue) => issue.field),
    ["title", "answer", "keywords"]
  );
});

test("requires every published entry to satisfy the complete field contract", () => {
  const validation = validateConferenceKnowledgeItems([
    validItem({
      category: "internal",
      title: "x".repeat(CONFERENCE_KNOWLEDGE_LIMITS.title + 1),
      answer: "",
      keywords: [
        "x".repeat(CONFERENCE_KNOWLEDGE_LIMITS.keyword + 1),
      ],
    }),
  ]);

  assert.equal(validation.valid, false);
  assert.deepEqual(
    new Set(validation.issues.map((issue) => issue.field)),
    new Set(["category", "title", "answer", "keywords"])
  );
  assert.throws(
    () => assertValidConferenceKnowledgeItems([validItem({ answer: "" })]),
    ConferenceKnowledgeValidationError
  );
});

test("flags duplicate public topics on every conflicting entry", () => {
  const validation = validateConferenceKnowledgeItems([
    validItem(),
    validItem({ id: "visitor-info-2", title: " guest wi-fi " }),
  ]);
  const duplicateIssues = validation.issues.filter(
    (issue) => issue.code === "duplicate_title"
  );

  assert.equal(validation.valid, false);
  assert.deepEqual(
    duplicateIssues.map((issue) => issue.index),
    [0, 1]
  );
});

test("normalizes keyword input and exposes only valid published records", () => {
  assert.deepEqual(
    normalizeConferenceKnowledgeKeywords("WiFi, internet, wifi,  ACCESS "),
    ["wifi", "internet", "access"]
  );
  assert.equal(isConferenceKnowledgeItemPublishable(validItem()), true);
  assert.equal(
    isConferenceKnowledgeItemPublishable(validItem({ answer: "" })),
    false
  );
  assert.equal(
    isConferenceKnowledgeItemPublishable(validItem({ isPublished: false })),
    false
  );
});

test("rejects invalid publication before storage and hides malformed stored records", async (t) => {
  const storeName = `conference-knowledge.test-${process.pid}-${Date.now()}.json`;
  process.env.CONFERENCE_KNOWLEDGE_FILE = storeName;

  const knowledgeStore = await import(
    `../src/lib/conference-knowledge.js?store=${encodeURIComponent(storeName)}`
  );
  const storePath = knowledgeStore.getConferenceKnowledgePath();

  t.after(async () => {
    await rm(storePath, { force: true });
    await rm(`${storePath}.lock`, { force: true });
    delete process.env.CONFERENCE_KNOWLEDGE_FILE;
  });

  await knowledgeStore.replaceConferenceOperationalInfo(
    "conference-test",
    [
      {
        category: "venue",
        title: "",
        answer: "",
        keywords: [],
        isPublished: false,
      },
      validItem(),
    ],
    "test@example.com"
  );

  assert.equal(
    (
      await knowledgeStore.getConferenceOperationalInfo("conference-test", {
        includeUnpublished: true,
      })
    ).length,
    2
  );
  assert.equal(
    (await knowledgeStore.getConferenceOperationalInfo("conference-test")).length,
    1
  );

  await assert.rejects(
    knowledgeStore.replaceConferenceOperationalInfo(
      "conference-test",
      [validItem({ answer: "" })],
      "test@example.com"
    ),
    ConferenceKnowledgeValidationError
  );
  assert.equal(
    (await knowledgeStore.getConferenceOperationalInfo("conference-test"))[0]
      .title,
    "Guest Wi-Fi"
  );

  await writeFile(
    storePath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: [
          {
            ...validItem({ answer: "" }),
            conferenceId: "conference-test",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  assert.equal(
    (await knowledgeStore.getConferenceOperationalInfo("conference-test")).length,
    0
  );
});
