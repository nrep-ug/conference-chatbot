import { timingSafeEqual } from "node:crypto";

import { logChatEvent } from "@/lib/chat-diagnostics";
import { ingestRecSnapshotToQdrant } from "@/lib/rec-qdrant-ingest";
import { invalidateRecPublicSnapshotCache } from "@/lib/rec-data";
import { refreshGeneratedRecSnapshot } from "@/lib/rec-snapshot";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getProvidedToken(request, body) {
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];

  return (
    bearer ||
    request.headers.get("x-rec-refresh-token") ||
    body?.token ||
    ""
  );
}

export async function POST(request) {
  const startedAt = Date.now();
  const expectedToken = process.env.REC_REFRESH_TOKEN || "";

  if (!expectedToken) {
    return Response.json(
      { error: "REC_REFRESH_TOKEN is not configured." },
      { status: 503 }
    );
  }

  const body = await readJson(request);
  const providedToken = getProvidedToken(request, body);

  if (!safeEqual(providedToken, expectedToken)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const refresh = await refreshGeneratedRecSnapshot({
      signal: request.signal,
    });
    let qdrant = null;

    invalidateRecPublicSnapshotCache();

    if (body?.rebuildQdrant === true) {
      qdrant = await ingestRecSnapshotToQdrant(refresh.snapshot);
    }

    logChatEvent("rec_snapshot_refresh", {
      durationMs: Date.now() - startedAt,
      rebuiltQdrant: Boolean(qdrant),
      counts: refresh.counts,
      qdrant,
    });

    return Response.json({
      ok: true,
      generatedAt: refresh.snapshot.metadata.generatedAt,
      counts: refresh.counts,
      qdrant,
    });
  } catch (error) {
    console.error(error);
    logChatEvent("rec_snapshot_refresh_error", {
      durationMs: Date.now() - startedAt,
      error: error.message,
    });

    return Response.json(
      { error: "Failed to refresh REC snapshot." },
      { status: 500 }
    );
  }
}
