import type { EmailMessage, EmailSender } from "./email-sender";

/** Local/test mail is deliberately retained in memory and never delivered externally. */
export class DevelopmentMailbox implements EmailSender {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> { this.messages.push({ ...message }); }
}
