import { randomUUID } from "node:crypto";
import { logChatEvent } from "@/lib/chat-diagnostics";
import { isAdministrator, requireAdmin } from "@/lib/admin-auth";
import { apiErrorResponse, checkAdminOrigin } from "@/lib/chat-api";
import { ApiError } from "@/lib/api-integrations";
import { ingestRecSnapshotToQdrant } from "@/lib/rec-qdrant-ingest";
import { invalidateRecPublicSnapshotCache } from "@/lib/rec-data";
import { refreshGeneratedRecSnapshot } from "@/lib/rec-snapshot";

export const runtime = "nodejs";
export const maxDuration = 300;

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function POST(request) {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  if (!isAdministrator(auth.user))
    return apiErrorResponse(
      new ApiError(403, "forbidden", "Administrator access is required."),
      randomUUID(),
      false,
    );
  try {
    checkAdminOrigin(request);
  } catch (error) {
    return apiErrorResponse(error, randomUUID(), false);
  }

  const startedAt = Date.now();
  const body = await readJson(request);

  try {
    const refresh = await refreshGeneratedRecSnapshot({
      signal: request.signal,
    });
    let qdrant = null;

    invalidateRecPublicSnapshotCache();

    if (body?.rebuildQdrant === true) {
      qdrant = await ingestRecSnapshotToQdrant(refresh.snapshot);
    }

    logChatEvent("admin_rec_snapshot_refresh", {
      durationMs: Date.now() - startedAt,
      user: auth.user.email,
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
    logChatEvent("admin_rec_snapshot_refresh_error", {
      durationMs: Date.now() - startedAt,
      user: auth.user.email,
      error: error.message,
    });

    return Response.json(
      { error: "Failed to refresh REC bot data." },
      { status: 500 }
    );
  }
}
