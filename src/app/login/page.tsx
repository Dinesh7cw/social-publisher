import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getSession } from "@/server/auth/session";
import { CwMark } from "@/components/shell/app-shell";
import { LoginForm } from "./login-form";
import "./login.css";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/");

  return (
    <main className="login-page">
      {/* Two columns, not a card floating in a void: the left half carries the
          product's purpose and what it publishes to, which is the one thing a
          first-time team member needs to know. */}
      <section className="login-intro">
        <div className="login-brand">
          <CwMark size={30} />
          <span className="login-wordmark">CW Social Publisher</span>
        </div>

        <h1 className="login-headline">
          One post, every client account.
        </h1>

        <p className="login-lede">
          ColorWhistle&rsquo;s internal console for writing once and publishing to each client&rsquo;s
          Facebook, Instagram, LinkedIn and X accounts, on a schedule the team can see.
        </p>

        <dl className="login-facts">
          <div>
            <dt>Per-account results</dt>
            <dd>Each platform reports its own outcome, so a single failure never hides three successes.</dd>
          </div>
          <div>
            <dt>Scheduled in one queue</dt>
            <dd>Jobs survive a restart, and nothing is marked published until the platform confirms it.</dd>
          </div>
          <div>
            <dt>Built for the team</dt>
            <dd>Clients stay separate, and every publish, connection and retry is logged.</dd>
          </div>
        </dl>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <h2 className="login-title" id="login-title">
          Sign in
        </h2>
        <p className="login-sub">Use the account a CW admin created for you.</p>

        <Suspense fallback={<div className="skeleton" style={{ height: 260 }} />}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
