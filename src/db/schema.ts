import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Better Auth's Drizzle schema uses the existing camelCase D1 columns. */
export const user = sqliteTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false), image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(), updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
});
export const account = sqliteTable("account", {
  id: text("id").primaryKey(), issuer: text("issuer").notNull(), accountId: text("accountId").notNull(), providerId: text("providerId").notNull(), userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"), refreshToken: text("refreshToken"), idToken: text("idToken"), accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }), refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }), scope: text("scope"), password: text("password"), createdAt: integer("createdAt", { mode: "timestamp" }).notNull(), updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
}, (table) => [uniqueIndex("account_issuer_account_id").on(table.issuer, table.accountId), index("account_user_id").on(table.userId)]);
export const session = sqliteTable("session", {
  id: text("id").primaryKey(), expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(), token: text("token").notNull().unique(), createdAt: integer("createdAt", { mode: "timestamp" }).notNull(), updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(), ipAddress: text("ipAddress"), userAgent: text("userAgent"), userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" })
}, (table) => [index("session_user_id").on(table.userId)]);
export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(), expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(), createdAt: integer("createdAt", { mode: "timestamp" }).notNull(), updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
}, (table) => [index("verification_identifier").on(table.identifier)]);
export const betterAuthSchema = { user, account, session, verification };
