// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const cfg = { cognitoDomain: "https://auth.example.com", clientId: "c", scopes: "openid", devAuth: false, googleConfigured: true, googleSignIn: true };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: Array<{ url: string; body: any }>;
function mockApi(handler: (action: string, body: any) => Response) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    return handler(url.split("/").pop()!, body);
  }));
}
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LoginPage", () => {
  it("signs in with email and password and stores the session", async () => {
    mockApi(() => reply({ ok: true, tokens: { accessToken: "a", refreshToken: "r", expiresIn: 3600 } }));
    const done = vi.fn();
    render(<LoginPage cfg={cfg} forClaude={false} onSignedIn={done} />);
    type("Email", "me@example.com");
    type("Password", "secret-password-1");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls[0]).toEqual({ url: "/api/auth/login", body: { email: "me@example.com", password: "secret-password-1" } });
    expect(JSON.parse(localStorage.getItem("sm.tokens")!).access).toBe("a");
  });

  it("shows a readable error for a wrong password", async () => {
    mockApi(() => reply({ ok: false, code: "bad_credentials", error: "Incorrect email or password." }, 401));
    render(<LoginPage cfg={cfg} forClaude={false} onSignedIn={vi.fn()} />);
    type("Email", "me@example.com");
    type("Password", "nope");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect email or password.");
  });

  it("creates an account, asks for the emailed code, then signs in", async () => {
    mockApi((action) => (action === "login" ? reply({ ok: true, tokens: { accessToken: "a", expiresIn: 3600 } }) : reply({ ok: true })));
    const done = vi.fn();
    render(<LoginPage cfg={cfg} forClaude={false} onSignedIn={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
    type("Email", "new@example.com");
    type("Password", "a-long-password-1");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    type("6-digit code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls.map((c) => c.url)).toEqual(["/api/auth/signup", "/api/auth/confirm", "/api/auth/login"]);
  });

  it("moves an unconfirmed account to the code step and sends a new code", async () => {
    mockApi((action) => (action === "login" ? reply({ ok: false, code: "unconfirmed", error: "x" }, 403) : reply({ ok: true })));
    render(<LoginPage cfg={cfg} forClaude={false} onSignedIn={vi.fn()} />);
    type("Email", "me@example.com");
    type("Password", "secret-password-1");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(["/api/auth/login", "/api/auth/resend"]);
  });

  it("offers Google only when it is configured, and says when Claude is connecting", () => {
    const { unmount } = render(<LoginPage cfg={cfg} forClaude onSignedIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Continue with Google/ })).toBeTruthy();
    expect(screen.getByText("Sign in to connect Show Manager to Claude.")).toBeTruthy();
    unmount();
    render(<LoginPage cfg={{ ...cfg, googleSignIn: false }} forClaude={false} onSignedIn={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Continue with Google/ })).toBeNull();
  });
});
