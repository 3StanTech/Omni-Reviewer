"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CircleNotch, LockSimple } from "@phosphor-icons/react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type ResetPasswordState = {
  error: string | null;
  done: boolean;
};

type ResetAction = (
  prevState: ResetPasswordState,
  formData: FormData,
) => Promise<ResetPasswordState>;

export function ResetPasswordForm({
  action,
  token,
}: {
  action: ResetAction;
  token: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
    done: false,
  });

  if (state.done) {
    return (
      <div className="space-y-5">
        <p role="status" className="text-sm text-muted-foreground">
          Your password was updated. You can sign in with the new password.
        </p>
        <Link
          href="/login"
          className={cn(buttonVariants({ size: "lg" }), "w-full")}
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <div className="relative">
          <LockSimple
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            weight="bold"
          />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            disabled={pending}
            aria-invalid={state.error ? true : undefined}
            className="pl-9"
            placeholder="New password"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirm password</Label>
        <div className="relative">
          <LockSimple
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            weight="bold"
          />
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            disabled={pending}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "reset-error" : undefined}
            className="pl-9"
            placeholder="Confirm password"
          />
        </div>
      </div>

      {state.error ? (
        <p id="reset-error" role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending} size="lg">
        {pending ? (
          <>
            <CircleNotch className="animate-spin" weight="bold" />
            Saving
          </>
        ) : (
          "Update password"
        )}
      </Button>

      <p className="text-center text-sm">
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
