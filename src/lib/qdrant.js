import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "conference_docs";

export const qdrant = new QdrantClient({
  url: QDRANT_URL,
});

export { QDRANT_COLLECTION };