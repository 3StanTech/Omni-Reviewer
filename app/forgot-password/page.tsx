import { headers } from "next/headers";

import { AuthPageShell } from "@/components/auth-page-shell";
import {
  ForgotPasswordForm,
  type ForgotPasswordState,
} from "@/components/forgot-password-form";
import { isUsableAuthSecret } from "@/lib/auth-secret";
import { isMailConfigured, sendPasswordResetEmail } from "@/lib/mail";
import { normalizeLoginEmail } from "@/lib/login-throttle";
import { resetThrottleKey } from "@/lib/password-reset";
import { logRedactedError } from "@/lib/public-errors";
import {
  isLoginEmailLocked,
  issuePasswordResetToken,
  recordLoginFailure,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

async function appOrigin(): Promise<string | null> {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  if (!host) return null;
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

async function requestResetAction(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  "use server";

  if (!isUsableAuthSecret(process.env.AUTH_SECRET) || !process.env.DATABASE_URL) {
    return { error: "Server is misconfigured. Try again later.", sent: false };
  }
  if (!isMailConfigured()) {
    return { error: "Server is misconfigured. Try again later.", sent: false };
  }

  const emailRaw = formData.get("email");
  if (typeof emailRaw !== "string" || emailRaw.trim().length === 0) {
    return { error: "Email is required.", sent: false };
  }
  const email = normalizeLoginEmail(emailRaw);
  const throttleKey = resetThrottleKey(email);

  try {
    if (await isLoginEmailLocked(throttleKey)) {
      return { error: null, sent: true };
    }
  } catch {
    return { error: "Server is misconfigured. Try again later.", sent: false };
  }

  try {
    await recordLoginFailure(throttleKey);
  } catch {
    return { error: "Server is misconfigured. Try again later.", sent: false };
  }

  let token: string | null = null;
  try {
    token = await issuePasswordResetToken(email);
  } catch (error) {
    logRedactedError("Password reset email failed", error);
    return { error: null, sent: true };
  }

  if (!token) {
    return { error: null, sent: true };
  }

  const origin = await appOrigin();
  if (!origin) {
    logRedactedError("Password reset email failed", null);
    return { error: null, sent: true };
  }

  try {
    await sendPasswordResetEmail({
      to: email,
      resetUrl: `${origin}/reset-password?token=${encodeURIComponent(token)}`,
    });
  } catch (error) {
    logRedactedError("Password reset email failed", error);
  }

  return { error: null, sent: true };
}

export default function ForgotPasswordPage() {
  return (
    <AuthPageShell
      title="Forgot password"
      subtitle="Enter your invite email and we will send a reset link if it matches an account."
    >
      <ForgotPasswordForm action={requestResetAction} />
    </AuthPageShell>
  );
}
