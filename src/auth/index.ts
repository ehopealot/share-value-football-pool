import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { betterAuthSchema } from "../db/schema";
import type { EmailSender } from "./email-sender";

/** Creates the actual Better Auth instance; application code never handles account passwords or tokens. */
export function createAuthBoundary(input: { db: D1Database; baseURL: string; secret: string; emailSender: EmailSender }) {
  const secure = new URL(input.baseURL).protocol === "https:";
  return betterAuth({
    baseURL: input.baseURL,
    secret: input.secret,
    database: drizzleAdapter(drizzle(input.db, { schema: betterAuthSchema }), { provider: "sqlite", schema: betterAuthSchema, camelCase: true }),
    verification: { storeInDatabase: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => input.emailSender.send({ kind: "password-reset", to: user.email, token })
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, token }) => input.emailSender.send({ kind: "verification", to: user.email, token })
    },
    advanced: { defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure } }
  });
}
