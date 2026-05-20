import { refreshGeneratedRecSnapshot } from "../src/lib/rec-snapshot.js";

async function main() {
  const result = await refreshGeneratedRecSnapshot();

  console.log(
    `Wrote active REC snapshot: ${result.counts.sessions} sessions, ${result.counts.timeBlocks} time blocks, ${result.counts.sponsors} sponsors`
  );
  console.log(`JSON: ${result.paths.json}`);
  console.log(`Markdown: ${result.paths.markdown}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
