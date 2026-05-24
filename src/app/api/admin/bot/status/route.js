import { stat } from "node:fs/promises";

import { getAdminAuthState, requireAdmin } from "@/lib/admin-auth";
import { qdrant, QDRANT_COLLECTION } from "@/lib/qdrant";
import {
  getSnapshotPaths,
  readGeneratedRecSnapshot,
} from "@/lib/rec-snapshot";

export const runtime = "nodejs";

function booleanEnv(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

function publicRuntimeSettings() {
  return {
    chatModel: process.env.CHAT_MODEL || "mistral",
    plannerModel: process.env.PLANNER_MODEL || process.env.CHAT_MODEL || "mistral",
    embedModel: process.env.EMBED_MODEL || "nomic-embed-text-v2-moe",
    plannerEnabled: booleanEnv("PLANNER_ENABLED"),
    recFullContextEnabled: booleanEnv("REC_FULL_CONTEXT_ENABLED"),
    recFullContextMode: process.env.REC_FULL_CONTEXT_MODE || "fallback",
    qdrantComplementEnabled: booleanEnv("QDRANT_COMPLEMENT_ENABLED"),
    qdrantComplementMode: process.env.QDRANT_COMPLEMENT_MODE || "append",
    qdrantFullContextEnabled: booleanEnv("QDRANT_FULL_CONTEXT_ENABLED"),
    qdrantFullContextMode: process.env.QDRANT_FULL_CONTEXT_MODE || "broad",
    diagnosticLogs: booleanEnv("CHAT_DIAGNOSTIC_LOGS"),
    smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM),
  };
}

async function getSnapshotStatus() {
  const paths = getSnapshotPaths();

  try {
    const [snapshot, jsonStat, markdownStat] = await Promise.all([
      readGeneratedRecSnapshot(),
      stat(paths.json),
      stat(paths.markdown),
    ]);

    return {
      ok: true,
      generatedAt: snapshot.metadata?.generatedAt,
      conference: {
        title: snapshot.conference?.title,
        shortName: snapshot.conference?.shortName,
        activeConferenceId: snapshot.conference?.$id,
      },
      counts: {
        programs: snapshot.programs?.length || 0,
        timeBlocks: snapshot.timeBlocks?.length || 0,
        sessions: snapshot.sessions?.length || 0,
        sponsorCategories: snapshot.sponsorCategories?.length || 0,
        sponsors: snapshot.sponsors?.length || 0,
      },
      files: {
        json: paths.json,
        markdown: paths.markdown,
        jsonBytes: jsonStat.size,
        markdownBytes: markdownStat.size,
        updatedAt: jsonStat.mtime.toISOString(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      files: paths,
    };
  }
}

async function getQdrantStatus() {
  try {
    const collection = await qdrant.getCollection(QDRANT_COLLECTION);
    const pointsCount = collection.points_count ?? null;
    const vectorsCount = collection.vectors_count ?? pointsCount;
    const hasPoints =
      Number.isFinite(Number(pointsCount)) ? Number(pointsCount) > 0 : true;

    return {
      ok: hasPoints,
      reachable: true,
      collection: QDRANT_COLLECTION,
      vectorsCount,
      pointsCount,
      status: collection.status,
      issue: hasPoints ? null : "empty_collection",
      message: hasPoints
        ? "Qdrant collection is available."
        : "Qdrant is reachable, but the collection has no indexed points.",
      nextAction: hasPoints
        ? null
        : "Use Refresh + rebuild Qdrant, or run npm run ingest on the server.",
    };
  } catch (error) {
    const message = error.message || "";
    const notFound = /not found|404|doesn't exist|does not exist/i.test(message);

    return {
      ok: false,
      reachable: false,
      collection: QDRANT_COLLECTION,
      issue: notFound ? "missing_collection" : "unreachable",
      error: message,
      message: notFound
        ? `Qdrant is reachable, but the ${QDRANT_COLLECTION} collection does not exist.`
        : `Qdrant is not reachable at ${process.env.QDRANT_URL || "http://localhost:6333"}.`,
      nextAction: notFound
        ? "Use Refresh + rebuild Qdrant, or run npm run ingest on the server."
        : "Start Qdrant and confirm QDRANT_URL points to the reachable service.",
    };
  }
}

export async function GET(request) {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;

  const [snapshot, vectorStore] = await Promise.all([
    getSnapshotStatus(),
    getQdrantStatus(),
  ]);
  const authState = await getAdminAuthState();

  return Response.json({
    ok: true,
    user: auth.user,
    auth: {
      configuredUsers: authState.configuredUsers,
      allowedUsers: authState.allowedUsers,
      users: authState.users,
      hasStableSecret: authState.hasStableSecret,
    },
    snapshot,
    vectorStore,
    runtime: publicRuntimeSettings(),
  });
}
