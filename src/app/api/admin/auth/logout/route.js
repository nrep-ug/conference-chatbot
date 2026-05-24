import {
  ADMIN_SESSION_COOKIE,
  destroyAdminSession,
  getClearSessionCookie,
  getCookieValue,
} from "@/lib/admin-auth";

export const runtime = "nodejs";

export async function POST(request) {
  const token = getCookieValue(request, ADMIN_SESSION_COOKIE);
  await destroyAdminSession(token);

  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": getClearSessionCookie(),
      },
    }
  );
}
