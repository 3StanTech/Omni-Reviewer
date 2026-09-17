import "server-only";

import { getEnv } from "@/lib/env";
import { logRedactedError, PublicError } from "@/lib/public-errors";

const RESEND_TEST_DOMAIN = ["resend", "dev"].join(".");
const DEFAULT_FROM = `Omni-Reviewer <onboarding@${RESEND_TEST_DOMAIN}>`;

export function isMailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function mailFromAddress(
  env: { EMAIL_FROM?: string } = getEnv(),
): string {
  const configured = env.EMAIL_FROM?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_FROM;
}

export async function sendPasswordResetEmail(args: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  const env = getEnv();
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new PublicError("Server is misconfigured. Try again later.");
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "omni-reviewer/0.1.0",
      },
      body: JSON.stringify({
        from: mailFromAddress(env),
        to: [args.to],
        subject: "Reset your Omni-Reviewer password",
        text:
          "Use this link to choose a new password. It expires in one hour.\n\n" +
          `${args.resetUrl}\n\n` +
          "If you did not ask for this, you can ignore this email.",
      }),
    });
  } catch (error) {
    logRedactedError("Password reset email failed", error);
    throw new PublicError("Server is misconfigured. Try again later.");
  }

  if (!response.ok) {
    logRedactedError("Password reset email failed", null, {
      providerStatus: response.status,
    });
    throw new PublicError("Server is misconfigured. Try again later.");
  }
}
