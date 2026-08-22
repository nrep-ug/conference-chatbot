import { createAdminLoginCode } from "@/lib/admin-auth";
import { sendAdminLoginCode } from "@/lib/smtp-mailer";

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
    const loginCode = await createAdminLoginCode(body.email);
    if (!loginCode.reused) {
      await sendAdminLoginCode(loginCode);
    }

    return Response.json({
      ok: true,
      email: loginCode.email,
      mode: loginCode.mode,
      expiresAt: loginCode.expiresAt,
    });
  } catch (error) {
    const isAllowedEmailError = /not allowed/i.test(error.message || "");

    if (isAllowedEmailError) {
      return Response.json({
        ok: true,
        email: String(body.email || "").trim().toLowerCase(),
        mode: "login",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
    }

    return Response.json(
      {
        error: "Failed to send verification code. Check SMTP settings on the server.",
      },
      { status: 500 }
    );
  }
}
