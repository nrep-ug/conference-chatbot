import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  assertValidConferenceKnowledgeItems,
  CONFERENCE_KNOWLEDGE_CATEGORIES,
  CONFERENCE_KNOWLEDGE_LIMITS,
  isConferenceKnowledgeItemPublishable,
  normalizeConferenceKnowledgeKeywords,
} from "./conference-knowledge-validation.js";

const DATA_DIR = path.join(process.cwd(), "data", "admin");
const STORE_PATH = path.join(
  DATA_DIR,
  path.basename(
    process.env.CONFERENCE_KNOWLEDGE_FILE || "conference-knowledge.json"
  )
);
const EXAMPLE_PATH = path.join(DATA_DIR, "conference-knowledge.example.json");
const LOCK_PATH = `${STORE_PATH}.lock`;
const LOCK_STALE_MS = 30_000;
const CATEGORIES = new Set(CONFERENCE_KNOWLEDGE_CATEGORIES);

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeKeywords(value) {
  return normalizeConferenceKnowledgeKeywords(value)
    .map((keyword) => cleanText(keyword, CONFERENCE_KNOWLEDGE_LIMITS.keyword))
    .filter(Boolean)
    .slice(0, CONFERENCE_KNOWLEDGE_LIMITS.keywords);
}

function normalizeStoredItem(item) {
  return {
    id: cleanText(item?.id, CONFERENCE_KNOWLEDGE_LIMITS.id) || randomUUID(),
    conferenceId: cleanText(item?.conferenceId, CONFERENCE_KNOWLEDGE_LIMITS.id),
    category: CATEGORIES.has(item?.category) ? item.category : "other",
    title: cleanText(item?.title, CONFERENCE_KNOWLEDGE_LIMITS.title),
    answer: cleanText(item?.answer, CONFERENCE_KNOWLEDGE_LIMITS.answer),
    keywords: normalizeKeywords(item?.keywords),
    isPublished: item?.isPublished === true,
    createdAt: cleanText(item?.createdAt, 40),
    updatedAt: cleanText(item?.updatedAt, 40),
    updatedBy: cleanText(item?.updatedBy, 180),
  };
}

function normalizeStore(store) {
  return {
    version: 1,
    updatedAt: cleanText(store?.updatedAt, 40),
    items: Array.isArray(store?.items)
      ? store.items.map(normalizeStoredItem).filter((item) => item.conferenceId)
      : [],
  };
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

async function writeStore(store) {
  await writeAtomic(
    STORE_PATH,
    `${JSON.stringify(normalizeStore(store), null, 2)}\n`
  );
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await readFile(STORE_PATH, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    let seed = { version: 1, updatedAt: "", items: [] };

    try {
      seed = JSON.parse(await readFile(EXAMPLE_PATH, "utf8"));
    } catch (exampleError) {
      if (exampleError.code !== "ENOENT") throw exampleError;
    }

    await writeStore(seed);
    return normalizeStore(seed);
  }
}

async function removeStaleLock() {
  try {
    const lockStat = await stat(LOCK_PATH);
    if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
      await unlink(LOCK_PATH);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function withStoreLock(callback) {
  await mkdir(DATA_DIR, { recursive: true });
  let handle = null;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      handle = await open(LOCK_PATH, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeStaleLock();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!handle) {
    throw new Error("Conference knowledge is currently being updated. Try again.");
  }

  try {
    return await callback();
  } finally {
    await handle.close();
    await unlink(LOCK_PATH).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function getConferenceKnowledgePath() {
  return STORE_PATH;
}

export async function getConferenceOperationalInfo(
  conferenceId,
  { includeUnpublished = false } = {}
) {
  const normalizedConferenceId = cleanText(conferenceId, 80);
  if (!normalizedConferenceId) return [];

  const store = await readStore();

  return store.items
    .filter((item) => item.conferenceId === normalizedConferenceId)
    .filter(
      (item) => includeUnpublished || isConferenceKnowledgeItemPublishable(item)
    )
    .sort((left, right) => left.title.localeCompare(right.title, "en"));
}

export async function replaceConferenceOperationalInfo(
  conferenceId,
  items,
  updatedBy
) {
  const normalizedConferenceId = cleanText(conferenceId, 80);
  const editor = cleanText(updatedBy, 180);

  if (!normalizedConferenceId) {
    throw new Error("The active conference ID is required.");
  }

  assertValidConferenceKnowledgeItems(items);

  return withStoreLock(async () => {
    const store = await readStore();
    const existingItems = new Map(
      store.items
        .filter((item) => item.conferenceId === normalizedConferenceId)
        .map((item) => [item.id, item])
    );
    const now = new Date().toISOString();
    const normalizedItems = items.map((item) => {
      const suppliedId = cleanText(item?.id, CONFERENCE_KNOWLEDGE_LIMITS.id);
      const existing = existingItems.get(suppliedId);
      const normalized = normalizeStoredItem({
        ...item,
        id: existing?.id || randomUUID(),
        conferenceId: normalizedConferenceId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        updatedBy: editor,
      });

      return normalized;
    });

    const nextStore = {
      version: 1,
      updatedAt: now,
      items: [
        ...store.items.filter(
          (item) => item.conferenceId !== normalizedConferenceId
        ),
        ...normalizedItems,
      ],
    };

    await writeStore(nextStore);
    return normalizedItems;
  });
}
