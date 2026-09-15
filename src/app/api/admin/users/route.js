import { randomUUID } from "node:crypto";
import {
  changeAdminUserRole,
  getAdminAuthState,
  isOwner,
  inviteAdminUser,
  requireAdmin,
  revokeAdminUser,
} from "../../../../lib/admin-auth.js";
import { ApiError } from "../../../../lib/api-integrations.js";
import { logChatEvent } from "../../../../lib/chat-diagnostics.js";
import {
  apiErrorResponse,
  checkAdminOrigin,
  readApiJson,
} from "../../../../lib/chat-api.js";

export const runtime = "nodejs";

function denyNonOwner(auth) {
  if (auth.response) return auth.response;
  if (!isOwner(auth.user))
    return apiErrorResponse(
      new ApiError(403, "forbidden", "Owner access is required."),
      randomUUID(),
      false,
    );
  return null;
}

export async function GET(request) {
  const auth = await requireAdmin(request);
  const denial = denyNonOwner(auth);
  if (denial) return denial;
  try {
    const state = await getAdminAuthState();
    return Response.json(
      { users: state.users, allowedUsers: state.allowedUsers },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, randomUUID(), false);
  }
}

export async function POST(request) {
  const auth = await requireAdmin(request);
  const denial = denyNonOwner(auth);
  if (denial) return denial;
  try {
    checkAdminOrigin(request);
    const body = await readApiJson(request, 2048);
    let user;
    if (body.action === "invite")
      user = await inviteAdminUser({ email: body.email, role: body.role, actorEmail: auth.user.email });
    else if (body.action === "role")
      user = await changeAdminUserRole({
        email: body.email,
        role: body.role,
        version: body.version,
        actorEmail: auth.user.email,
      });
    else if (body.action === "revoke")
      user = await revokeAdminUser({
        email: body.email,
        version: body.version,
        actorEmail: auth.user.email,
      });
    else
      throw new ApiError(400, "invalid_request", "Unknown account action.");
    logChatEvent("admin_account_access_changed", {
      action: body.action,
      actor: auth.user.email,
      email: user.email,
      role: user.role,
    });
    return Response.json(
      { user },
      {
        status: body.action === "invite" ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const message = error.message || "";
    const known = error instanceof ApiError;
    const conflict = /already approved|account changed/i.test(message);
    const expected = /valid email|choose owner|cannot remove|cannot change|last configured owner|account not found|owner access is required/i.test(message);
    const mapped = known || conflict || expected
      ? known
        ? error
        : new ApiError(conflict ? 409 : /owner access is required/i.test(message) ? 403 : 400, conflict ? "conflict" : "invalid_request", message)
      : error;
    return apiErrorResponse(mapped, randomUUID(), false);
  }
}
