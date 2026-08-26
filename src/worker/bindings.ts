export interface WorkerBindings {
  DB: D1Database;
  POOL_DO: DurableObjectNamespace;
  BACKUPS?: R2Bucket;
  BACKUP_ENCRYPTION_KEY?: string;
  POOL_BACKUP_SERVICE_TOKEN?: string;
  POOL_EVENTS: Queue;
  BETTER_AUTH_SECRET: string;
  POOL_COMMAND_AUTHENTICATOR_KEY: string;
  POOL_PROJECTION_SERVICE_TOKEN: string;
}
