import {
  ADMIN_SESSION_COOKIE,
  getAdminAuthState,
  getAdminSession,
  getCookieValue,
} from "@/lib/admin-auth";

export const runtime = "nodejs";

export async function GET(request) {
  const token = getCookieValue(request, ADMIN_SESSION_COOKIE);
  const user = await getAdminSession(token);
  const auth = await getAdminAuthState();
  const publicAuth = {
    configuredUsers: auth.configuredUsers,
    allowedUsers: auth.allowedUsers,
    hasStableSecret: auth.hasStableSecret,
  };

  return Response.json({
    authenticated: Boolean(user),
    user,
    auth: user ? auth : publicAuth,
  });
}
