import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuthBoundary } from "../../src/auth";
import { DevelopmentMailbox } from "../../src/auth/development-mailbox";

const db = (env as unknown as { DB: D1Database }).DB;
let migrated = false;
beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(db, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await db.exec("DELETE FROM verification; DELETE FROM session; DELETE FROM account; DELETE FROM user;");
});

describe("Better Auth D1 boundary", () => {
  it("persists signup/login, verification/reset mail, reset, and rotating sessions", async () => {
    const mailbox = new DevelopmentMailbox();
    const auth = createAuthBoundary({ db, baseURL: "https://pool.example.test", secret: "a-long-test-secret-that-is-never-production", emailSender: mailbox });
    const signup = await auth.api.signUpEmail({ body: { name: "Member", email: "member@example.test", password: "first-password" } });
    expect(signup.user.email).toBe("member@example.test");
    expect(mailbox.messages).toContainEqual(expect.objectContaining({ kind: "verification", to: "member@example.test" }));
    const verification = mailbox.messages.find((message) => message.kind === "verification")!;
    await auth.api.verifyEmail({ query: { token: verification.token } });
    const firstLogin = await auth.api.signInEmail({ body: { email: "member@example.test", password: "first-password" }, asResponse: true });
    expect(firstLogin.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect((await db.prepare("SELECT token FROM session WHERE userId = ?").bind(signup.user.id).all<{ token: string }>()).results.length).toBeGreaterThan(0);
    await auth.api.requestPasswordReset({ body: { email: "member@example.test", redirectTo: "https://pool.example.test/reset-password" } });
    const reset = mailbox.messages.find((message) => message.kind === "password-reset")!;
    expect((await db.prepare("SELECT createdAt, updatedAt FROM verification").all<{ createdAt: number | null; updatedAt: number | null }>()).results).toContainEqual(expect.objectContaining({ createdAt: expect.any(Number), updatedAt: expect.any(Number) }));
    await auth.api.resetPassword({ body: { token: reset.token, newPassword: "second-password" } });
    expect((await db.prepare("SELECT token FROM session WHERE userId = ?").bind(signup.user.id).all<{ token: string }>()).results).toEqual([]);
    const secondLogin = await auth.api.signInEmail({ body: { email: "member@example.test", password: "second-password" }, asResponse: true });
    expect(secondLogin.headers.get("set-cookie")).not.toBe(firstLogin.headers.get("set-cookie"));
    expect((await db.prepare("SELECT token FROM session WHERE userId = ?").bind(signup.user.id).all<{ token: string }>()).results).toHaveLength(1);
  });
});
