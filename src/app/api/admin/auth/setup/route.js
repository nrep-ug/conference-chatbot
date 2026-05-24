import {
  createAdminSession,
  getSessionCookie,
  setupAdminAccount,
} from "@/lib/admin-auth";

export const runtime = "nodejs";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function POST(request) {
  const body = await readJson(request);

  try {
    const user = await setupAdminAccount({
      email: body.email,
      code: body.code,
      username: body.username,
      clientPasswordHash: body.passwordHash,
    });
    const session = await createAdminSession(user.email);

    return Response.json(
      {
        ok: true,
        user: session.user,
        expiresAt: session.expiresAt,
      },
      {
        headers: {
          "Set-Cookie": getSessionCookie(session.token, session.expiresAt),
        },
      }
    );
  } catch (error) {
    return Response.json(
      { error: error.message || "Unable to set up account." },
      { status: 400 }
    );
  }
}
