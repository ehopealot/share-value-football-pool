export const cloudflareCredentialNames = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_API_USER_SERVICE_KEY",
]);

export const workerSecretNames = Object.freeze([
  "BACKUP_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "ODDS_API_KEY",
  "POOL_BACKUP_SERVICE_TOKEN",
  "POOL_COMMAND_AUTHENTICATOR_KEY",
  "POOL_PROJECTION_SERVICE_TOKEN",
  "RESEND_API_KEY",
  "SENTRY_DSN",
  "SETTLEMENT_SERVICE_TOKEN",
  "TURNSTILE_SECRET_KEY",
]);

const ciWranglerCredentialNames = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);

/** Returns a copy without Cloudflare credentials, except the two CI Wrangler credentials when explicitly requested. */
export function withoutCloudflareCredentials(environment, preserveCiWranglerCredentials = false) {
  const clean = { ...environment };
  for (const name of cloudflareCredentialNames) {
    if (!preserveCiWranglerCredentials || !ciWranglerCredentialNames.has(name)) delete clean[name];
  }
  return clean;
}

/** Returns a copy without known Worker secrets. */
export function withoutWorkerSecrets(environment) {
  const clean = { ...environment };
  for (const name of workerSecretNames) delete clean[name];
  return clean;
}

/** Isolates a non-publishing Wrangler/build child from dotenv, process bindings, credentials, and Worker secrets. */
export function nonPublishingCloudflareEnvironment(environment) {
  return {
    ...withoutWorkerSecrets(withoutCloudflareCredentials(environment)),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  };
}
