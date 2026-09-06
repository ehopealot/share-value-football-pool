import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { betterAuthSchema } from "../db/schema";
import type { EmailSender } from "./email-sender";

/** Creates the Better Auth instance, which owns credential and token generation, storage, and validation while this boundary forwards generated auth-mail data. */
export function createAuthBoundary(input: { db: D1Database; baseURL: string; secret: string; emailSender: EmailSender; autoVerifyEmail?: boolean }) {
  const secure = new URL(input.baseURL).protocol === "https:";
  const autoVerifyEmail = input.autoVerifyEmail === true;
  return betterAuth({
    baseURL: input.baseURL,
    secret: input.secret,
    database: drizzleAdapter(drizzle(input.db, { schema: betterAuthSchema }), { provider: "sqlite", schema: betterAuthSchema, camelCase: true }),
    verification: { storeInDatabase: true },
    ...(autoVerifyEmail ? { databaseHooks: { user: { create: { async before() { return { data: { emailVerified: true } }; } } } } } : {}),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token, url }) => input.emailSender.send({ kind: "password-reset", to: user.email, token, url })
    },
    emailVerification: {
      sendOnSignUp: !autoVerifyEmail,
      sendVerificationEmail: async ({ user, token, url }) => input.emailSender.send({ kind: "verification", to: user.email, token, url })
    },
    advanced: { defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure } }
  });
}
