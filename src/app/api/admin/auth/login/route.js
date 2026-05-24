import { getSessionCookie, loginAdmin } from "@/lib/admin-auth";

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
    const session = await loginAdmin({
      email: body.email,
      code: body.code,
      clientPasswordHash: body.passwordHash,
    });

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
      { error: error.message || "Unable to sign in." },
      { status: 401 }
    );
  }
}
