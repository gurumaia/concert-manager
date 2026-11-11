import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AuthApiError, authApi, passwordLogin, startGoogleLogin, type AppConfig } from "../auth";

type Mode = "signin" | "signup" | "confirm" | "forgot" | "reset";

const TITLES: Record<Mode, string> = {
  signin: "Sign in", signup: "Create your account", confirm: "Check your email", forgot: "Reset your password", reset: "Choose a new password",
};

export function LoginPage({ cfg, forClaude, onSignedIn }: { cfg: AppConfig; forClaude: boolean; onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);

  // Move focus to the new heading when the step changes, so screen readers announce it.
  useEffect(() => { heading.current?.focus(); }, [mode]);

  const go = (m: Mode, message?: string) => { setMode(m); setError(undefined); setInfo(message); setCode(""); };

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(undefined); setInfo(undefined);
    try { await fn(); } catch (e) {
      if (e instanceof AuthApiError && e.code === "unconfirmed" && mode === "signin") {
        await authApi("resend", { email }).catch(() => undefined);
        go("confirm", "Your email is not confirmed yet. We sent you a new code.");
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mode === "signin") { await passwordLogin(email, password); onSignedIn(); }
      else if (mode === "signup") { await authApi("signup", { email, password, name }); go("confirm", `We sent a 6-digit code to ${email}.`); }
      else if (mode === "confirm") {
        await authApi("confirm", { email, code });
        if (password) { await passwordLogin(email, password); onSignedIn(); } else go("signin", "Email confirmed. You can sign in now.");
      }
      else if (mode === "forgot") { await authApi("forgot", { email }); go("reset", `If ${email} has an account, we sent it a code.`); }
      else if (mode === "reset") { await authApi("reset", { email, code, password }); setPassword(""); go("signin", "Password changed. Sign in with your new password."); }
    });
  };

  const needsPassword = mode === "signin" || mode === "signup" || mode === "reset";
  const newPassword = mode === "signup" || mode === "reset";
  const cta = { signin: "Sign in", signup: "Create account", confirm: "Confirm email", forgot: "Send code", reset: "Change password" }[mode];

  return (
    <main className="centered" id="main">
      <div className="login">
        <p className="brand-lg"><span className="logo" aria-hidden="true">♪</span> Show Manager</p>
        {forClaude && <p className="callout" role="status">Sign in to connect Show Manager to Claude.</p>}
        <h1 ref={heading} tabIndex={-1}>{TITLES[mode]}</h1>

        {(mode === "signin" || mode === "signup") && cfg.googleSignIn && (
          <>
            <button type="button" className="btn big google" onClick={() => void startGoogleLogin()} disabled={busy}>
              <GoogleIcon /> Continue with Google
            </button>
            <p className="divider"><span>or use your email</span></p>
          </>
        )}

        <form onSubmit={submit} className="form" noValidate={false}>
          {info && <p role="status" className="ok">{info}</p>}
          {mode === "signup" && <Field label="Your name (optional)"><input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
          <Field label="Email">
            <input type="email" required autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} readOnly={mode === "confirm" || mode === "reset"} />
          </Field>
          {(mode === "confirm" || mode === "reset") && (
            <Field label="6-digit code">
              <input required autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            </Field>
          )}
          {needsPassword && (
            <>
              <Field label={mode === "reset" ? "New password" : "Password"} hintId="pw-hint" hint={newPassword ? "At least 10 characters, with upper and lower case letters and a number." : undefined}>
                <input type={show ? "text" : "password"} required autoComplete={newPassword ? "new-password" : "current-password"} aria-describedby={newPassword ? "pw-hint" : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
            </>
          )}
          {error && <p role="alert" className="error">{error}</p>}
          <button className="btn primary big" disabled={busy}>{busy ? "One moment…" : cta}</button>
        </form>

        <nav className="login-links" aria-label="Other options">
          {mode === "signin" && (<>
            <button className="link" onClick={() => go("forgot")}>Forgot password?</button>
            <button className="link" onClick={() => go("signup")}>Create an account</button>
          </>)}
          {mode === "signup" && <button className="link" onClick={() => go("signin")}>I already have an account</button>}
          {mode === "confirm" && (<>
            <button className="link" onClick={() => void run(async () => { await authApi("resend", { email }); setInfo("A new code is on its way."); })}>Send a new code</button>
            <button className="link" onClick={() => go("signin")}>Back to sign in</button>
          </>)}
          {(mode === "forgot" || mode === "reset") && <button className="link" onClick={() => go("signin")}>Back to sign in</button>}
        </nav>
      </div>
    </main>
  );
}

function Field({ label, hint, hintId, children }: { label: string; hint?: string; hintId?: string; children: ReactNode }) {
  // The hint sits outside the <label> so the field's name stays short; aria-describedby on the input links them.
  return <div className="field"><label>{label}{children}</label>{hint && <span id={hintId} className="muted small">{hint}</span>}</div>;
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
