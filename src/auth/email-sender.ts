export type EmailKind = "verification" | "password-reset";
export interface EmailMessage { kind: EmailKind; to: string; token: string; url: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }

export interface ResendEmailSenderOptions { apiKey: string; from: string; fetcher?: typeof fetch; }

const resendEndpoint = "https://api.resend.com/emails";
const escapedHtmlCharacters: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapedHtmlCharacters[character]!);
}

function emailContent(message: EmailMessage): { subject: string; text: string; html: string } {
  const verification = message.kind === "verification";
  const subject = verification ? "Verify your Office Pool Reborn email" : "Reset your Office Pool Reborn password";
  const instruction = verification ? "Verify your email address" : "Reset your Office Pool Reborn password";
  const linkLabel = verification ? "Verify email address" : "Reset password";
  const fallback = verification ? "If you did not create an Office Pool Reborn account, you can ignore this email." : "If you did not request a password reset, you can ignore this email.";
  return {
    subject,
    text: `${instruction} for Office Pool Reborn:\n\n${message.url}\n\n${fallback}`,
    html: `<p>${instruction} for <strong>Office Pool Reborn</strong>.</p><p><a href="${escapeHtmlAttribute(message.url)}">${linkLabel}</a></p><p>${fallback}</p>`
  };
}

/** Sends transactional auth mail directly through Resend without logging recipient or token data. */
export function createResendEmailSender(options: ResendEmailSenderOptions): EmailSender {
  const fetcher = options.fetcher ?? fetch;
  return {
    async send(message) {
      const content = emailContent(message);
      let response: Response;
      try {
        response = await fetcher(resendEndpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: options.from, to: [message.to], ...content }),
          signal: AbortSignal.timeout(10_000)
        });
      } catch {
        throw new Error("EMAIL_DELIVERY_FAILED");
      }
      if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
    }
  };
}
