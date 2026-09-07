import { logChatEvent } from "@/lib/chat-diagnostics";
import {
  getConferenceOperationalInfo,
  replaceConferenceOperationalInfo,
} from "@/lib/conference-knowledge";
import {
  ConferenceKnowledgeValidationError,
} from "@/lib/conference-knowledge-validation";
import {
  getRecPublicSnapshot,
  invalidateRecPublicSnapshotCache,
} from "@/lib/rec-data";
import { requireAdmin } from "@/lib/admin-auth";
import { ingestRecSnapshotToQdrant } from "@/lib/rec-qdrant-ingest";
import { writeGeneratedRecSnapshot } from "@/lib/rec-snapshot";

export const runtime = "nodejs";
export const maxDuration = 300;

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function runtimeOperationalItems(items, conferenceId) {
  return items.map((item) => ({
    ...item,
    $id: item.id,
    $tableId: "admin_operational_info",
    conferenceId,
  }));
}

export async function GET(request) {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;

  try {
    const snapshot = await getRecPublicSnapshot({ signal: request.signal });
    const conferenceId = snapshot.conference.$id;
    const items = await getConferenceOperationalInfo(conferenceId, {
      includeUnpublished: true,
    });

    return Response.json({
      ok: true,
      conference: {
        id: conferenceId,
        title: snapshot.conference.title,
        shortName: snapshot.conference.shortName,
        year: snapshot.conference.year,
      },
      items,
    });
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: "Failed to load conference operational information." },
      { status: 500 }
    );
  }
}

export async function PUT(request) {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;

  const startedAt = Date.now();
  const body = await readJson(request);

  try {
    const snapshot = await getRecPublicSnapshot({ signal: request.signal });
    const conferenceId = snapshot.conference.$id;
    const items = await replaceConferenceOperationalInfo(
      conferenceId,
      body.items,
      auth.user.email
    );
    const refreshed = await writeGeneratedRecSnapshot({
      ...snapshot,
      operationalInfo: runtimeOperationalItems(items, conferenceId),
    });
    let qdrant = null;

    invalidateRecPublicSnapshotCache();

    if (body.rebuildQdrant === true) {
      qdrant = await ingestRecSnapshotToQdrant(refreshed.snapshot);
    }

    logChatEvent("admin_operational_info_saved", {
      durationMs: Date.now() - startedAt,
      user: auth.user.email,
      conferenceId,
      itemCount: items.length,
      publishedCount: items.filter((item) => item.isPublished).length,
      rebuiltQdrant: Boolean(qdrant),
    });

    return Response.json({
      ok: true,
      conferenceId,
      items,
      publishedCount: items.filter((item) => item.isPublished).length,
      generatedAt: refreshed.snapshot.metadata.generatedAt,
      qdrant,
    });
  } catch (error) {
    console.error(error);
    logChatEvent("admin_operational_info_save_error", {
      durationMs: Date.now() - startedAt,
      user: auth.user.email,
      error: error.message,
    });

    const validationError = error instanceof ConferenceKnowledgeValidationError;
    const updateConflict = /currently being updated/i.test(error.message || "");
    const clientError =
      validationError || updateConflict
        ? error.message
        : "Failed to save conference operational information.";

    return Response.json(
      {
        error: clientError,
        ...(validationError
          ? {
              code: error.code,
              issues: error.issues,
            }
          : {}),
      },
      { status: validationError ? 400 : updateConflict ? 409 : 500 }
    );
  }
}
