import { randomUUID } from "node:crypto";
import { isAdministrator, requireAdmin } from "../../../../lib/admin-auth.js";
import {
  ApiError,
  getIntegrationStore,
} from "../../../../lib/api-integrations.js";
import {
  apiErrorResponse,
  checkAdminOrigin,
  readApiJson,
} from "../../../../lib/chat-api.js";

export const runtime = "nodejs";

export async function GET(request) {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  try {
    return Response.json(getIntegrationStore().list(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, randomUUID(), false);
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
    const body = await readApiJson(request, 4096);
    const store = getIntegrationStore();
    let result;
    if (body.action === "create")
      result = store.create(body.settings, auth.user.email);
    else {
      if (
        !/^[a-f0-9]{24}$/.test(body.id || "") ||
        !Number.isSafeInteger(body.version)
      )
        throw new ApiError(
          400,
          "invalid_request",
          "Integration ID and version are required.",
        );
      if (body.action === "update")
        result = store.update(
          body.id,
          body.settings,
          auth.user.email,
          body.version,
        );
      else if (body.action === "rotate")
        result = store.rotate(body.id, auth.user.email, body.version);
      else if (body.action === "revoke")
        result = store.revoke(body.id, auth.user.email, body.version);
      else
        throw new ApiError(
          400,
          "invalid_request",
          "Unknown integration action.",
        );
    }
    return Response.json(result, {
      status: body.action === "create" ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, randomUUID(), false);
  }
}
