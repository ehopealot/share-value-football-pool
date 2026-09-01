import { describe, expect, it, vi } from "vitest";
import * as emailSenderModule from "../../src/auth/email-sender";
import type { EmailSender } from "../../src/auth/email-sender";

type ResendSenderFactory = (options: { apiKey: string; from: string; fetcher?: typeof fetch }) => EmailSender;
const createResendEmailSender = (emailSenderModule as unknown as { createResendEmailSender?: ResendSenderFactory }).createResendEmailSender;

describe("Resend email sender", () => {
  it("sends a verification link with Resend's authenticated email request shape", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(createResendEmailSender).toEqual(expect.any(Function));
    const sender = createResendEmailSender!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });

    await sender.send({ kind: "verification", to: "member@example.test", token: "verification-token", url: "https://officepool.football/api/auth/verify-email?token=verification-token&callbackURL=%2F" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, request] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({ method: "POST", headers: { authorization: "Bearer resend-test-key", "content-type": "application/json" } });
    expect(JSON.parse(String(request?.body))).toEqual({
      from: "Office Pool Reborn <noreply@officepool.football>",
      to: ["member@example.test"],
      subject: "Verify your Office Pool Reborn email",
      text: "Verify your email address for Office Pool Reborn:\n\nhttps://officepool.football/api/auth/verify-email?token=verification-token&callbackURL=%2F\n\nIf you did not create an Office Pool Reborn account, you can ignore this email.",
      html: "<p>Verify your email address for <strong>Office Pool Reborn</strong>.</p><p><a href=\"https://officepool.football/api/auth/verify-email?token=verification-token&amp;callbackURL=%2F\">Verify email address</a></p><p>If you did not create an Office Pool Reborn account, you can ignore this email.</p>"
    });
  });

  it("fails without exposing a Resend response body when delivery is rejected", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider detail", { status: 429 }));
    expect(createResendEmailSender).toEqual(expect.any(Function));
    const sender = createResendEmailSender!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });

    await expect(sender.send({ kind: "password-reset", to: "member@example.test", token: "reset-token", url: "https://officepool.football/api/auth/reset-password/reset-token?callbackURL=%2F" })).rejects.toThrow("EMAIL_DELIVERY_FAILED");
  });
});
