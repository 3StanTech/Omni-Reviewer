"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CircleNotch, EnvelopeSimple } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ForgotPasswordState = {
  error: string | null;
  sent: boolean;
};

type ForgotAction = (
  prevState: ForgotPasswordState,
  formData: FormData,
) => Promise<ForgotPasswordState>;

export function ForgotPasswordForm({ action }: { action: ForgotAction }) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
    sent: false,
  });

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <div className="relative">
          <EnvelopeSimple
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            weight="bold"
          />
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={pending || state.sent}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={
              state.error ? "forgot-error" : state.sent ? "forgot-sent" : undefined
            }
            className="pl-9"
            placeholder="you@example.com"
          />
        </div>
      </div>

      {state.error ? (
        <p id="forgot-error" role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      {state.sent ? (
        <p id="forgot-sent" role="status" className="text-sm text-muted-foreground">
          If that email has an invite, we sent a reset link.
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending || state.sent} size="lg">
        {pending ? (
          <>
            <CircleNotch className="animate-spin" weight="bold" />
            Sending
          </>
        ) : (
          "Send reset link"
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
