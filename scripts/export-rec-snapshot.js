import { refreshGeneratedRecSnapshot } from "../src/lib/rec-snapshot.js";

async function main() {
  const result = await refreshGeneratedRecSnapshot();

  console.log(
    `Wrote REC snapshot v${result.generatedSnapshot.schemaVersion}: ${result.counts.sessions} active sessions, ${result.counts.timeBlocks} active time blocks, ${result.counts.sponsors} active sponsors, ${result.counts.previousConferences} previous editions, ${result.counts.historicalMediaItems} historical media items, ${result.counts.historicalReports} historical reports`
  );
  console.log(`JSON: ${result.paths.json}`);
  console.log(`Markdown: ${result.paths.markdown}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
