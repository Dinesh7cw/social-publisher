"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not sign you in. Please try again.");
        setPending(false);
        return;
      }

      // Only follow `next` when it is a local path: an absolute URL here would
      // be an open redirect.
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.replace(safeNext);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="login-form" noValidate>
      <div className="field">
        <label className="field-label" htmlFor="email">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          autoComplete="username"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
        />
      </div>

      {error ? (
        <p className="field-error" id="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary login-submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>

      <p className="login-hint">
        Accounts are created by a CW admin. Ask them if you need access.
      </p>
    </form>
  );
}
