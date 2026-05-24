import { logChatEvent } from "@/lib/chat-diagnostics";
import { requireAdmin } from "@/lib/admin-auth";
import { ingestRecSnapshotToQdrant } from "@/lib/rec-qdrant-ingest";
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

  const startedAt = Date.now();
  const body = await readJson(request);

  try {
    const refresh = await refreshGeneratedRecSnapshot({
      signal: request.signal,
    });
    let qdrant = null;

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
