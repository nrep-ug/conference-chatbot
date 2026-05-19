import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { QdrantClient } from "@qdrant/js-client-rest";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text-v2-moe";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION || "conference_docs";

const qdrant = new QdrantClient({ url: QDRANT_URL });

function chunkText(text, maxLength = 900) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = paragraph;
    } else {
      current += "\n\n" + paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function getEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.embeddings || !data.embeddings[0]) {
    throw new Error("No embedding returned from Ollama.");
  }

  return data.embeddings[0];
}

async function recreateCollection(vectorSize) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);

  if (exists) {
    await qdrant.deleteCollection(COLLECTION);
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: {
      size: vectorSize,
      distance: "Cosine",
    },
  });
}

async function main() {
  const docsDir = path.join(process.cwd(), "data", "conference");

  if (!fs.existsSync(docsDir)) {
    throw new Error(`Documents folder not found: ${docsDir}`);
  }

  const files = fs.readdirSync(docsDir).filter((file) => file.endsWith(".md"));

  if (files.length === 0) {
    throw new Error("No .md conference documents found.");
  }

  const points = [];
  let collectionReady = false;

  for (const file of files) {
    const filePath = path.join(docsDir, file);
    const content = fs.readFileSync(filePath, "utf8");
    const chunks = chunkText(content);

    for (const [index, chunk] of chunks.entries()) {
      const vector = await getEmbedding(`search_document: ${chunk}`);

      if (!collectionReady) {
        await recreateCollection(vector.length);
        collectionReady = true;
      }

      points.push({
        id: randomUUID(),
        vector,
        payload: {
          source: file,
          chunk_index: index,
          text: chunk,
        },
      });
    }
  }

  await qdrant.upsert(COLLECTION, {
    points,
  });

  console.log(`Ingested ${points.length} chunks into ${COLLECTION}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});