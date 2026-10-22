import { headers } from "next/headers";
import Link from "next/link";

import { redirectIfSignedIn } from "@/auth";
import { AuthPageShell } from "@/components/auth-page-shell";
import {
  ForgotPasswordForm,
  type ForgotPasswordState,
} from "@/components/forgot-password-form";
import { isUsableAuthSecret } from "@/lib/auth-secret";
import { canEmailAnyAccount, sendPasswordResetEmail } from "@/lib/mail";
import { normalizeLoginEmail } from "@/lib/login-throttle";
import { resetThrottleKey } from "@/lib/password-reset";
import { logRedactedError } from "@/lib/public-errors";
import {
  isLoginEmailLocked,
  issuePasswordResetToken,
  recordLoginFailure,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const RESET_UNAVAILABLE_NOTICE =
  "Message Tristan to reset your password. Password resets by email are coming soon.";

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
  // A stale form post must never claim "sent" while no reset email can arrive.
  if (!canEmailAnyAccount()) {
    return { error: null, sent: false, notice: RESET_UNAVAILABLE_NOTICE };
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

export default async function ForgotPasswordPage() {
  await redirectIfSignedIn();
  if (!canEmailAnyAccount()) {
    return (
      <AuthPageShell title="Forgot password" subtitle={RESET_UNAVAILABLE_NOTICE}>
        <p className="text-center text-sm">
          <Link href="/login" className="text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell
      title="Forgot password"
      subtitle="Enter your invite email and we will send a reset link if it matches an account."
    >
      <ForgotPasswordForm action={requestResetAction} />
    </AuthPageShell>
  );
}
