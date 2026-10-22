import { BookOpen } from "@phosphor-icons/react/dist/ssr";
import { AuthError } from "next-auth";

import { LoginForm } from "@/components/login-form";
import { redirectIfSignedIn, signIn } from "@/auth";
import { isUsableAuthSecret } from "@/lib/auth-secret";
import {
  LOGIN_THROTTLE_LOCKED_MESSAGE,
  normalizeLoginEmail,
} from "@/lib/login-throttle";

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

  // The throttle lives in authorize (auth.ts) so direct callback posts share
  // the same lockout; this action only maps its codes to messages.
  try {
    await signIn("credentials", {
      email: normalizeLoginEmail(emailRaw),
      password,
      redirectTo: "/",
    });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      return loginErrorMessage((error as { code?: string }).code);
    }
    throw error;
  }
}

function loginErrorMessage(code: string | undefined): string {
  if (code === "login_locked") return LOGIN_THROTTLE_LOCKED_MESSAGE;
  if (code === "server_misconfigured") {
    return "Server is misconfigured. Try again later.";
  }
  return "Invalid email or password.";
}

export default async function LoginPage() {
  await redirectIfSignedIn();
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
