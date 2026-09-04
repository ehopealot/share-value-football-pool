import { describe, expect, it, vi } from "vitest";
import * as emailSenderModule from "../../src/auth/email-sender";
import type { EmailSender } from "../../src/auth/email-sender";

type ResendSenderFactory = (options: { apiKey: string; from: string; fetcher?: typeof fetch }) => EmailSender;
const createResendEmailSender = (emailSenderModule as unknown as { createResendEmailSender?: ResendSenderFactory }).createResendEmailSender;
type PoolJoinNotifierFactory = (options: { apiKey: string; from: string; fetcher?: typeof fetch }) => { notifyPoolJoin(message: { to: string; poolName: string; memberName: string }): Promise<void>; notifyCommissionerTransfer(message: { to: string; poolName: string; formerCommissionerName: string; newCommissionerName: string; recipient: "new" | "former" }): Promise<void>; notifyShareOrderFulfilled(message: { to: string; poolName: string; sharesMicros: string; valueMicros: string }): Promise<void>; notifyCommissionerAnnouncement(message: { to: string; poolName: string; authorName: string; text: string; boardUrl: string; idempotencyKey: string }): Promise<void>; notifyMessageBoardReply(message: { to: string; poolName: string; replierName: string; text: string; boardUrl: string; idempotencyKey: string }): Promise<void> };
const createResendPoolJoinNotifier = (emailSenderModule as unknown as { createResendPoolJoinNotifier?: PoolJoinNotifierFactory }).createResendPoolJoinNotifier;

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

  it("notifies a commissioner when a member joins their pool", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(createResendPoolJoinNotifier).toEqual(expect.any(Function));
    await createResendPoolJoinNotifier!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher }).notifyPoolJoin({ to: "commissioner@example.test", poolName: "Sunday Pool", memberName: "Taylor" });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ from: "Office Pool Reborn <noreply@officepool.football>", to: ["commissioner@example.test"], subject: "New member in Sunday Pool", text: "Taylor joined Sunday Pool.", html: "<p><strong>Taylor</strong> joined <strong>Sunday Pool</strong>.</p>" });
  });

  it("sends an individually addressed commissioner announcement with escaped content and a provider idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolJoinNotifier!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });
    await notifier.notifyCommissionerAnnouncement({ to: "member@example.test", poolName: "Sunday & Pool", authorName: "Alex <A>", text: "Draft <noon> & bring snacks.", boardUrl: "https://officepool.football/p/sunday/board#post-post-1", idempotencyKey: "announcement/post-1/member" });

    const [endpoint, request] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({ headers: { authorization: "Bearer resend-test-key", "content-type": "application/json", "user-agent": "office-pool-reborn/1.0", "idempotency-key": "announcement/post-1/member" } });
    expect(JSON.parse(String(request?.body))).toEqual({
      from: "Office Pool Reborn <noreply@officepool.football>", to: ["member@example.test"], subject: "Commissioner announcement — Sunday & Pool",
      text: "Alex <A> posted a commissioner announcement in Sunday & Pool:\n\nDraft <noon> & bring snacks.\n\nView announcement: https://officepool.football/p/sunday/board#post-post-1",
      html: "<p><strong>Alex &lt;A&gt;</strong> posted a commissioner announcement in <strong>Sunday &amp; Pool</strong>.</p><p>Draft &lt;noon&gt; &amp; bring snacks.</p><p><a href=\"https://officepool.football/p/sunday/board#post-post-1\">View announcement</a></p>"
    });
  });

  it("sends an individually addressed message-board reply notification with escaped content and a provider idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolJoinNotifier!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });
    await notifier.notifyMessageBoardReply({ to: "author@example.test", poolName: "Sunday & Pool", replierName: "Taylor <T>", text: "Reply <text> & more.", boardUrl: "https://officepool.football/p/sunday/board#post-post-1", idempotencyKey: "reply/reply-1/owner" });

    const [endpoint, request] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({ headers: { authorization: "Bearer resend-test-key", "content-type": "application/json", "user-agent": "office-pool-reborn/1.0", "idempotency-key": "reply/reply-1/owner" } });
    expect(JSON.parse(String(request?.body))).toEqual({
      from: "Office Pool Reborn <noreply@officepool.football>", to: ["author@example.test"], subject: "New reply in Sunday & Pool",
      text: "Taylor <T> replied to your post in Sunday & Pool:\n\nReply <text> & more.\n\nView reply: https://officepool.football/p/sunday/board#post-post-1",
      html: "<p><strong>Taylor &lt;T&gt;</strong> replied to your post in <strong>Sunday &amp; Pool</strong>.</p><p>Reply &lt;text&gt; &amp; more.</p><p><a href=\"https://officepool.football/p/sunday/board#post-post-1\">View reply</a></p>"
    });
  });

  it("notifies a member when a share order is fulfilled", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolJoinNotifier!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });
    await notifier.notifyShareOrderFulfilled({ to: "member@example.test", poolName: "Sunday Pool", sharesMicros: "2500000", valueMicros: "3750000" });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ from: "Office Pool Reborn <noreply@officepool.football>", to: ["member@example.test"], subject: "Shares added to Sunday Pool", text: "Your share order in Sunday Pool is complete.\n\n2.50 shares were added to your balance (value: $3.75).", html: "<p>Your share order in <strong>Sunday Pool</strong> is complete.</p><p><strong>2.50 shares</strong> were added to your balance (value: <strong>$3.75</strong>).</p>" });
  });

  it("notifies both commissioners about a completed handoff", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolJoinNotifier!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });
    await notifier.notifyCommissionerTransfer({ to: "new@example.test", poolName: "Sunday Pool", formerCommissionerName: "Alex", newCommissionerName: "Taylor", recipient: "new" });
    await notifier.notifyCommissionerTransfer({ to: "former@example.test", poolName: "Sunday Pool", formerCommissionerName: "Alex", newCommissionerName: "Taylor", recipient: "former" });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ to: ["new@example.test"], subject: "You are now commissioner of Sunday Pool" });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ to: ["former@example.test"], subject: "Commissioner changed for Sunday Pool" });
  });

  it("fails without exposing a Resend response body when delivery is rejected", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider detail", { status: 429 }));
    expect(createResendEmailSender).toEqual(expect.any(Function));
    const sender = createResendEmailSender!({ apiKey: "resend-test-key", from: "Office Pool Reborn <noreply@officepool.football>", fetcher });

    await expect(sender.send({ kind: "password-reset", to: "member@example.test", token: "reset-token", url: "https://officepool.football/api/auth/reset-password/reset-token?callbackURL=%2F" })).rejects.toThrow("EMAIL_DELIVERY_FAILED");
  });
});
