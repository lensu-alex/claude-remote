"use client";

import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import { Mark } from "@/components/Icons";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (failure) {
      setError(
        failure.message === "Invalid login credentials"
          ? "That email and password don't match."
          : failure.message || "Couldn't sign in. Check your connection and try again.",
      );
      setBusy(false);
    }
    // On success the session gate sends us to the home screen.
  }

  return (
    <main className="center-screen">
      <form className="login" onSubmit={submit}>
        <Mark size={76} />
        <h1 className="login-title">Claude Remote</h1>
        <p className="login-sub">Sign in to reach your laptop.</p>

        <div className="group login-fields">
          <label className="cell">
            <div className="cell-body">
              <span className="cell-title field-label">Email</span>
              <input
                type="email"
                name="email"
                className="field-input"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="name@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </label>
          <label className="cell">
            <div className="cell-body">
              <span className="cell-title field-label">Password</span>
              <input
                type="password"
                name="password"
                className="field-input"
                autoComplete="current-password"
                placeholder="Required"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </label>
        </div>

        {error ? (
          <p className="group-footer form-error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="button button-tint login-button" type="submit" disabled={busy}>
          {busy ? "Signing In…" : "Sign In"}
        </button>
      </form>
    </main>
  );
}
