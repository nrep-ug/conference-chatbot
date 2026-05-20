import { ingestRecSnapshotToQdrant } from "../src/lib/rec-qdrant-ingest.js";
import { getRecPublicSnapshot } from "../src/lib/rec-data.js";

async function main() {
  const snapshot = await getRecPublicSnapshot({
    forceRefresh: /^(1|true|yes|on)$/i.test(
      process.env.INGEST_FORCE_APPWRITE || ""
    ),
  });
  const result = await ingestRecSnapshotToQdrant(snapshot);

  console.log(
    `Ingested ${result.points} REC documents into ${result.collection}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
