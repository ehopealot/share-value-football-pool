export type EmailKind = "verification" | "password-reset";
export interface EmailMessage { kind: EmailKind; to: string; token: string; }
export interface EmailSender { send(message: EmailMessage): Promise<void>; }
