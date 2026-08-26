const BACKUP_FORMAT = "share-value-pool-backup-aes-gcm-v1";
const keyPattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Avoid argument-list limits when exports make encrypted ciphertext large. */
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

/** Strictly accepts one canonical 256-bit AES key; malformed and ambiguous encodings fail closed. */
export function decodeBackupKey(encoded: string): Uint8Array {
  if (!keyPattern.test(encoded)) throw new Error("BACKUP_KEY_INVALID");
  let decoded: string;
  try { decoded = atob(encoded); } catch { throw new Error("BACKUP_KEY_INVALID"); }
  const key = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (key.byteLength !== 32 || bytesToBase64(key) !== encoded) throw new Error("BACKUP_KEY_INVALID");
  return key;
}

export type EncryptedBackupEnvelope = { format: typeof BACKUP_FORMAT; algorithm: "AES-GCM"; nonce: string; ciphertext: string };

/** Encrypts a self-describing JSON envelope with a fresh nonce for every object. */
export async function encryptBackup(value: unknown, rawKey: Uint8Array): Promise<EncryptedBackupEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  return { format: BACKUP_FORMAT, algorithm: "AES-GCM", nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export type BackupDependencies = { db: D1Database; pools: DurableObjectNamespace; bucket: R2Bucket; encryptionKey: string; backupServiceToken?: string };

/**
 * Bounded infrastructure-only backup. Individual pools may fail without
 * stopping subsequent backups, and errors deliberately contain no data/key.
 */
export async function backupPools(dependencies: BackupDependencies): Promise<{ attempted: number; stored: number }> {
  const rawKey = decodeBackupKey(dependencies.encryptionKey);
  if (!dependencies.backupServiceToken) return { attempted: 0, stored: 0 };
  await dependencies.db.prepare("CREATE TABLE IF NOT EXISTS backup_cursor (name TEXT PRIMARY KEY, last_pool_id TEXT)").run();
  const cursor = await dependencies.db.prepare("SELECT last_pool_id FROM backup_cursor WHERE name = 'scheduled'").first<{ last_pool_id: string | null }>();
  const after = cursor?.last_pool_id ?? "";
  let result = await dependencies.db.prepare("SELECT pool_id FROM pool_registry WHERE status = 'ready' AND pool_id > ? ORDER BY pool_id LIMIT 100").bind(after).all<{ pool_id: string }>();
  if (!result.results.length && after) result = await dependencies.db.prepare("SELECT pool_id FROM pool_registry WHERE status = 'ready' ORDER BY pool_id LIMIT 100").all<{ pool_id: string }>();
  let stored = 0;
  let lastAttempted: string | null = null;
  for (const row of result.results) {
    lastAttempted = row.pool_id;
    try {
      const response = await dependencies.pools.get(dependencies.pools.idFromName(row.pool_id)).fetch("https://pool.internal/internal/audit-export", { headers: { "x-backup-service-token": dependencies.backupServiceToken } });
      if (!response.ok) continue;
      const envelope = await encryptBackup(await response.json(), rawKey);
      await dependencies.bucket.put(`${row.pool_id}/audit-${new Date().toISOString()}-${crypto.randomUUID()}.json.aesgcm`, JSON.stringify(envelope), { httpMetadata: { contentType: "application/json" } });
      stored++;
    } catch {
      // Backup failures are intentionally bounded and silent to avoid leaking data or secrets.
    }
  }
  if (lastAttempted !== null) await dependencies.db.prepare("INSERT INTO backup_cursor (name, last_pool_id) VALUES ('scheduled', ?) ON CONFLICT(name) DO UPDATE SET last_pool_id = excluded.last_pool_id").bind(lastAttempted).run();
  return { attempted: result.results.length, stored };
}

export function backupConfigured(env: { BACKUPS?: R2Bucket; BACKUP_ENCRYPTION_KEY?: string; POOL_BACKUP_SERVICE_TOKEN?: string }): boolean {
  if (!env.BACKUPS || !env.BACKUP_ENCRYPTION_KEY || !env.POOL_BACKUP_SERVICE_TOKEN) return false;
  try { decodeBackupKey(env.BACKUP_ENCRYPTION_KEY); return true; } catch { return false; }
}

export async function runBackupCron(env: BackupDependencies): Promise<void> {
  try { await backupPools(env); } catch { /* invalid configuration and D1 failures remain disabled/fail-closed */ }
}
