import { AuthPageShell } from "@/components/auth-page-shell";
import {
  ResetPasswordForm,
  type ResetPasswordState,
} from "@/components/reset-password-form";
import { isUsableAuthSecret } from "@/lib/auth-secret";
import { normalizeLoginEmail } from "@/lib/login-throttle";
import {
  PASSWORD_RESET_INVALID_MESSAGE,
  passwordValidationError,
  resetThrottleKey,
} from "@/lib/password-reset";
import {
  clearLoginThrottle,
  consumePasswordResetAndSetPassword,
  getUserEmailById,
  peekPasswordResetToken,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  "use server";

  if (!isUsableAuthSecret(process.env.AUTH_SECRET) || !process.env.DATABASE_URL) {
    return { error: "Server is misconfigured. Try again later.", done: false };
  }

  const tokenRaw = formData.get("token");
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  if (typeof tokenRaw !== "string" || tokenRaw.trim().length === 0) {
    return { error: PASSWORD_RESET_INVALID_MESSAGE, done: false };
  }
  if (typeof password !== "string" || typeof confirm !== "string") {
    return { error: "Password is required.", done: false };
  }
  if (password !== confirm) {
    return { error: "Passwords do not match.", done: false };
  }
  const passwordError = passwordValidationError(password);
  if (passwordError) {
    return { error: passwordError, done: false };
  }

  const userId = await consumePasswordResetAndSetPassword(tokenRaw, password).catch(
    () => null,
  );
  if (!userId) {
    return { error: PASSWORD_RESET_INVALID_MESSAGE, done: false };
  }

  try {
    const emailRaw = await getUserEmailById(userId);
    if (emailRaw) {
      const email = normalizeLoginEmail(emailRaw);
      await clearLoginThrottle(email);
      await clearLoginThrottle(resetThrottleKey(email));
    }
  } catch {
    // Password is already updated; sign-in can still proceed.
  }

  return { error: null, done: true };
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const usable =
    typeof token === "string" && token.trim().length > 0
      ? await peekPasswordResetToken(token).catch(() => null)
      : null;

  return (
    <AuthPageShell
      title="Choose a new password"
      subtitle="This link works once and expires after one hour."
    >
      {usable && token ? (
        <ResetPasswordForm action={resetPasswordAction} token={token} />
      ) : (
        <p className="text-sm text-muted-foreground">{PASSWORD_RESET_INVALID_MESSAGE}</p>
      )}
    </AuthPageShell>
  );
}
