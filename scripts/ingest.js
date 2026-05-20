import { randomUUID } from "node:crypto";
import { getEmbedding } from "../src/lib/ollama.js";
import { qdrant, QDRANT_COLLECTION } from "../src/lib/qdrant.js";
import { buildRecDocuments, getRecPublicSnapshot } from "../src/lib/rec-data.js";

async function recreateCollection(vectorSize) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(
    (collection) => collection.name === QDRANT_COLLECTION
  );

  if (exists) {
    await qdrant.deleteCollection(QDRANT_COLLECTION);
  }

  await qdrant.createCollection(QDRANT_COLLECTION, {
    vectors: {
      size: vectorSize,
      distance: "Cosine",
    },
  });
}

async function main() {
  const snapshot = await getRecPublicSnapshot({ forceRefresh: true });
  const documents = buildRecDocuments(snapshot);

  if (documents.length === 0) {
    throw new Error("No public REC documents were generated from Appwrite.");
  }

  const points = [];
  let collectionReady = false;

  for (const [index, document] of documents.entries()) {
    const vector = await getEmbedding(`search_document: ${document.text}`);

    if (!collectionReady) {
      await recreateCollection(vector.length);
      collectionReady = true;
    }

    points.push({
      id: randomUUID(),
      vector,
      payload: {
        ...document.payload,
        chunk_index: index,
      },
    });
  }

  await qdrant.upsert(QDRANT_COLLECTION, {
    points,
  });

  console.log(
    `Ingested ${points.length} Appwrite REC documents into ${QDRANT_COLLECTION}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
