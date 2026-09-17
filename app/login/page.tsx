import { BookOpen } from "@phosphor-icons/react/dist/ssr";
import { AuthError } from "next-auth";

import { LoginForm } from "@/components/login-form";
import { signIn } from "@/auth";
import { isUsableAuthSecret } from "@/lib/auth-secret";
import {
  LOGIN_THROTTLE_LOCKED_MESSAGE,
  normalizeLoginEmail,
} from "@/lib/login-throttle";
import {
  clearLoginThrottle,
  isLoginEmailLocked,
  recordLoginFailure,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

async function loginAction(
  _prevState: string | null,
  formData: FormData,
): Promise<string | null> {
  "use server";

  if (!isUsableAuthSecret(process.env.AUTH_SECRET) || !process.env.DATABASE_URL) {
    return "Server is misconfigured. Try again later.";
  }

  const emailRaw = formData.get("email");
  const password = formData.get("password");
  if (typeof emailRaw !== "string" || emailRaw.trim().length === 0) {
    return "Email is required.";
  }
  if (typeof password !== "string" || password.length === 0) {
    return "Password is required.";
  }

  const normalized = normalizeLoginEmail(emailRaw);

  try {
    if (await isLoginEmailLocked(normalized)) {
      return LOGIN_THROTTLE_LOCKED_MESSAGE;
    }
  } catch {
    return "Server is misconfigured. Try again later.";
  }

  try {
    await signIn("credentials", {
      email: normalized,
      password,
      redirectTo: "/",
    });
    await clearLoginThrottle(normalized);
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      if (
        "code" in error &&
        (error as { code?: string }).code === "server_misconfigured"
      ) {
        return "Server is misconfigured. Try again later.";
      }
      try {
        const recorded = await recordLoginFailure(normalized);
        if (recorded.locked) {
          return LOGIN_THROTTLE_LOCKED_MESSAGE;
        }
      } catch {
        return "Server is misconfigured. Try again later.";
      }
      return "Invalid email or password.";
    }
    try {
      await clearLoginThrottle(normalized);
    } catch {
      // Redirect must still propagate.
    }
    throw error;
  }
}

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary shadow-[0_0_40px_oklch(0.78_0.12_75/20%)]">
            <BookOpen weight="duotone" className="size-6" />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">
              Omni-Reviewer
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Late-night study desk. Sign in with your invite email and password.
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-border/80 bg-surface/50 p-5 shadow-[0_12px_40px_oklch(0_0_0/25%)] sm:p-6">
          <LoginForm action={loginAction} />
        </div>
      </div>
    </main>
  );
}
