import { formatMicros } from "../domain/fixed-point";

export type EmailKind = "verification" | "password-reset";
export interface EmailMessage { kind: EmailKind; to: string; token: string; url: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }
export interface ResendEmailSenderOptions { apiKey: string; from: string; fetcher?: typeof fetch; }
export interface PoolNotifier {
  notifyPoolJoin(message: { to: string; poolName: string; memberName: string }): Promise<void>;
  notifyCommissionerTransfer(message: { to: string; poolName: string; formerCommissionerName: string; newCommissionerName: string; recipient: "new" | "former" }): Promise<void>;
  notifyShareOrderFulfilled(message: { to: string; poolName: string; sharesMicros: string; valueMicros: string }): Promise<void>;
  notifyCommissionerAnnouncement(message: { to: string; poolName: string; authorName: string; text: string; boardUrl: string; idempotencyKey: string }): Promise<void>;
  notifyMessageBoardReply?(message: { to: string; poolName: string; replierName: string; text: string; boardUrl: string; idempotencyKey: string }): Promise<void>;
}

/** @deprecated Use PoolNotifier. */
export interface PoolJoinNotifier extends PoolNotifier {}

const resendEndpoint = "https://api.resend.com/emails";
const escapedHtmlCharacters: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapedHtmlCharacters[character]!);
}

function emailContent(message: EmailMessage): { subject: string; text: string; html: string } {
  const verification = message.kind === "verification";
  const subject = verification ? "Verify your Yourfootballpool email" : "Reset your Yourfootballpool password";
  const instruction = verification ? "Verify your email address" : "Reset your Yourfootballpool password";
  const linkLabel = verification ? "Verify email address" : "Reset password";
  const fallback = verification ? "If you did not create a Yourfootballpool account, you can ignore this email." : "If you did not request a password reset, you can ignore this email.";
  return {
    subject,
    text: `${instruction} for Yourfootballpool:\n\n${message.url}\n\n${fallback}`,
    html: `<p>${instruction} for <strong>Yourfootballpool</strong>.</p><p><a href="${escapeHtml(message.url)}">${linkLabel}</a></p><p>${fallback}</p>`
  };
}

async function sendResend(options: ResendEmailSenderOptions, to: string, content: { subject: string; text: string; html: string }, idempotencyKey?: string): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(resendEndpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "user-agent": "office-pool-reborn/1.0", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: JSON.stringify({ from: options.from, to: [to], ...content }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error("EMAIL_DELIVERY_FAILED");
  }
  if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
}

/** Sends transactional auth mail directly through Resend without logging recipient or token data. */
export function createResendEmailSender(options: ResendEmailSenderOptions): EmailSender {
  return { async send(message) { await sendResend(options, message.to, emailContent(message)); } };
}

/** Operational content is deliberately limited to safe categories and correlation IDs. */
export async function sendOperationalAlertEmail(options: ResendEmailSenderOptions, message: { to: string; title: string; description: string; scope: string; observedAt: string; count?: number }): Promise<void> {
  const count = message.count === undefined ? "" : `\nAffected open wagers: ${message.count}`;
  const text = `${message.description}\nScope: ${message.scope}\nObserved at: ${message.observedAt}${count}\n\nInspect operations and Worker logs: https://officepool.football/ops\n\nDelivery is best effort. Repeated alerts of this type for this scope are suppressed for 30 minutes.`;
  await sendResend(options, message.to, {
    subject: `Yourfootballpool: ${message.title}`,
    text,
    html: `<p>${escapeHtml(message.description)}</p><p>Scope: ${escapeHtml(message.scope)}<br>Observed at: ${escapeHtml(message.observedAt)}${message.count === undefined ? "" : `<br>Affected open wagers: ${escapeHtml(String(message.count))}`}</p><p><a href="https://officepool.football/ops">Inspect operations</a> and Worker logs.</p><p>Delivery is best effort. Repeated alerts of this type for this scope are suppressed for 30 minutes.</p>`
  });
}

/** Sends pool notifications through Resend. */
export function createResendPoolNotifier(options: ResendEmailSenderOptions): PoolNotifier {
  const amount = (micros: string) => formatMicros(BigInt(micros), 2);
  return {
    async notifyPoolJoin(message) {
      await sendResend(options, message.to, {
        subject: `New member in ${message.poolName}`,
        text: `${message.memberName} joined ${message.poolName}.`,
        html: `<p><strong>${escapeHtml(message.memberName)}</strong> joined <strong>${escapeHtml(message.poolName)}</strong>.</p>`
      });
    },
    async notifyCommissionerAnnouncement(message) {
      await sendResend(options, message.to, {
        subject: `Commissioner announcement — ${message.poolName}`,
        text: `${message.authorName} posted a commissioner announcement in ${message.poolName}:\n\n${message.text}\n\nView announcement: ${message.boardUrl}`,
        html: `<p><strong>${escapeHtml(message.authorName)}</strong> posted a commissioner announcement in <strong>${escapeHtml(message.poolName)}</strong>.</p><p>${escapeHtml(message.text)}</p><p><a href="${escapeHtml(message.boardUrl)}">View announcement</a></p>`
      }, message.idempotencyKey);
    },
    async notifyMessageBoardReply(message) {
      await sendResend(options, message.to, {
        subject: `New reply in ${message.poolName}`,
        text: `${message.replierName} replied to your post in ${message.poolName}:\n\n${message.text}\n\nView reply: ${message.boardUrl}`,
        html: `<p><strong>${escapeHtml(message.replierName)}</strong> replied to your post in <strong>${escapeHtml(message.poolName)}</strong>.</p><p>${escapeHtml(message.text)}</p><p><a href="${escapeHtml(message.boardUrl)}">View reply</a></p>`
      }, message.idempotencyKey);
    },
    async notifyShareOrderFulfilled(message) {
      const shares = amount(message.sharesMicros);
      const value = amount(message.valueMicros);
      await sendResend(options, message.to, {
        subject: `Shares added to ${message.poolName}`,
        text: `Your share order in ${message.poolName} is complete.\n\n${shares} shares were added to your balance (value: $${value}).`,
        html: `<p>Your share order in <strong>${escapeHtml(message.poolName)}</strong> is complete.</p><p><strong>${shares} shares</strong> were added to your balance (value: <strong>$${value}</strong>).</p>`
      });
    },
    async notifyCommissionerTransfer(message) {
      const isNew = message.recipient === "new";
      const subject = isNew ? `You are now commissioner of ${message.poolName}` : `Commissioner changed for ${message.poolName}`;
      const text = isNew ? `${message.formerCommissionerName} made you commissioner of ${message.poolName}.` : `You made ${message.newCommissionerName} commissioner of ${message.poolName}.`;
      const html = isNew
        ? `<p><strong>${escapeHtml(message.formerCommissionerName)}</strong> made you commissioner of <strong>${escapeHtml(message.poolName)}</strong>.</p>`
        : `<p>You made <strong>${escapeHtml(message.newCommissionerName)}</strong> commissioner of <strong>${escapeHtml(message.poolName)}</strong>.</p>`;
      await sendResend(options, message.to, { subject, text, html });
    }
  };
}
