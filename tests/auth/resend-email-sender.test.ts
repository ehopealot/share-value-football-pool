import { describe, expect, it, vi } from "vitest";
import { createResendEmailSender, createResendPoolNotifier } from "../../src/auth/email-sender";

const captureError = async (operation: Promise<unknown>): Promise<Error> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to reject.");
};

describe("Resend email sender", () => {
  it("sends a verification link with Resend's authenticated email request shape", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const sender = createResendEmailSender({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

    try {
      await sender.send({ kind: "verification", to: "member@example.test", token: "verification-token", url: "https://officepool.football/api/auth/verify-email?token=verification-token&callbackURL=%2F" });

      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(fetcher).toHaveBeenCalledOnce();
      const [endpoint, request] = fetcher.mock.calls[0]!;
      expect(endpoint).toBe("https://api.resend.com/emails");
      expect(request).toMatchObject({ method: "POST" });
      expect(request?.signal).toBe(signal);
      expect(request?.headers).toEqual({ authorization: "Bearer resend-test-key", "content-type": "application/json", "user-agent": "office-pool-reborn/1.0" });
      expect(JSON.parse(String(request?.body))).toEqual({
        from: "Yourfootballpool <noreply@officepool.football>",
        to: ["member@example.test"],
        subject: "Verify your Yourfootballpool email",
        text: "Verify your email address for Yourfootballpool:\n\nhttps://officepool.football/api/auth/verify-email?token=verification-token&callbackURL=%2F\n\nIf you did not create a Yourfootballpool account, you can ignore this email.",
        html: "<p>Verify your email address for <strong>Yourfootballpool</strong>.</p><p><a href=\"https://officepool.football/api/auth/verify-email?token=verification-token&amp;callbackURL=%2F\">Verify email address</a></p><p>If you did not create a Yourfootballpool account, you can ignore this email.</p>"
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("sends a password-reset link with reset-specific copy and escaped HTML", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const sender = createResendEmailSender({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });

    await sender.send({ kind: "password-reset", to: "member@example.test", token: "reset-token", url: "https://officepool.football/api/auth/reset-password/reset-token?callbackURL=%2F&source=email" });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      from: "Yourfootballpool <noreply@officepool.football>",
      to: ["member@example.test"],
      subject: "Reset your Yourfootballpool password",
      text: "Reset your Yourfootballpool password for Yourfootballpool:\n\nhttps://officepool.football/api/auth/reset-password/reset-token?callbackURL=%2F&source=email\n\nIf you did not request a password reset, you can ignore this email.",
      html: "<p>Reset your Yourfootballpool password for <strong>Yourfootballpool</strong>.</p><p><a href=\"https://officepool.football/api/auth/reset-password/reset-token?callbackURL=%2F&amp;source=email\">Reset password</a></p><p>If you did not request a password reset, you can ignore this email.</p>"
    });
  });

  it("accepts a successful Resend response without parsing its malformed body", async () => {
    const response = new Response("not JSON", { status: 202 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sender = createResendEmailSender({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });

    await expect(sender.send({ kind: "verification", to: "member@example.test", token: "verification-token", url: "https://officepool.football/api/auth/verify-email?token=verification-token" })).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(false);
  });

  it("notifies a commissioner when a member joins their pool", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    await createResendPoolNotifier({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher }).notifyPoolJoin({ to: "commissioner@example.test", poolName: "Sunday Pool", memberName: "Taylor" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ from: "Yourfootballpool <noreply@officepool.football>", to: ["commissioner@example.test"], subject: "New member in Sunday Pool", text: "Taylor joined Sunday Pool.", html: "<p><strong>Taylor</strong> joined <strong>Sunday Pool</strong>.</p>" });
  });

  it("sends an individually addressed commissioner announcement with escaped content and a provider idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolNotifier({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });
    await notifier.notifyCommissionerAnnouncement({ to: "member@example.test", poolName: "Sunday & Pool", authorName: "Alex <A>", text: "Draft <noon> & bring snacks.", boardUrl: "https://officepool.football/p/sunday/board#post-post-1", idempotencyKey: "announcement/post-1/member" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, request] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({ headers: { authorization: "Bearer resend-test-key", "content-type": "application/json", "user-agent": "office-pool-reborn/1.0", "idempotency-key": "announcement/post-1/member" } });
    expect(JSON.parse(String(request?.body))).toEqual({
      from: "Yourfootballpool <noreply@officepool.football>", to: ["member@example.test"], subject: "Commissioner announcement — Sunday & Pool",
      text: "Alex <A> posted a commissioner announcement in Sunday & Pool:\n\nDraft <noon> & bring snacks.\n\nView announcement: https://officepool.football/p/sunday/board#post-post-1",
      html: "<p><strong>Alex &lt;A&gt;</strong> posted a commissioner announcement in <strong>Sunday &amp; Pool</strong>.</p><p>Draft &lt;noon&gt; &amp; bring snacks.</p><p><a href=\"https://officepool.football/p/sunday/board#post-post-1\">View announcement</a></p>"
    });
  });

  it("sends an individually addressed message-board reply notification with escaped content and a provider idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolNotifier({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });
    if (!notifier.notifyMessageBoardReply) throw new Error("Expected reply notifier");
    await notifier.notifyMessageBoardReply({ to: "author@example.test", poolName: "Sunday & Pool", replierName: "Taylor <T>", text: "Reply <text> & more.", boardUrl: "https://officepool.football/p/sunday/board#post-post-1", idempotencyKey: "reply/reply-1/owner" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, request] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({ headers: { authorization: "Bearer resend-test-key", "content-type": "application/json", "user-agent": "office-pool-reborn/1.0", "idempotency-key": "reply/reply-1/owner" } });
    expect(JSON.parse(String(request?.body))).toEqual({
      from: "Yourfootballpool <noreply@officepool.football>", to: ["author@example.test"], subject: "New reply in Sunday & Pool",
      text: "Taylor <T> replied to your post in Sunday & Pool:\n\nReply <text> & more.\n\nView reply: https://officepool.football/p/sunday/board#post-post-1",
      html: "<p><strong>Taylor &lt;T&gt;</strong> replied to your post in <strong>Sunday &amp; Pool</strong>.</p><p>Reply &lt;text&gt; &amp; more.</p><p><a href=\"https://officepool.football/p/sunday/board#post-post-1\">View reply</a></p>"
    });
  });

  it("sends the season closure reminder with escaped details, a navigation-only admin link, and stable provider identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolNotifier({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });
    await notifier.notifySeasonClosureReminder({
      to: "commissioner@example.test", poolName: "Sunday & Pool", seasonLabel: "2030 <season>", gameName: "Super Bowl <LX>", kickoff: "2030-02-10T23:00:00.000Z",
      adminUrl: "https://officepool.football/p/sunday%20pool/admin/season?view=closure&safe=1", idempotencyKey: "season-closure/pool/season"
    });

    const request = fetcher.mock.calls[0]![1];
    expect(request?.headers).toMatchObject({ "idempotency-key": "season-closure/pool/season" });
    expect(JSON.parse(String(request?.body))).toEqual({
      from: "Yourfootballpool <noreply@officepool.football>", to: ["commissioner@example.test"], subject: "End 2030 <season> after the Super Bowl — Sunday & Pool",
      text: "Pool: Sunday & Pool\nSeason: 2030 <season>\nSuper Bowl: Super Bowl <LX>\nKickoff: 2030-02-10T23:00:00.000Z\n\nUse season administration to acknowledge this is the season's Super Bowl. After acknowledgment, the season will close automatically once the game is final and all wagers are resolved.\n\nOpen season administration: https://officepool.football/p/sunday%20pool/admin/season?view=closure&safe=1\n\nThis link opens the authenticated admin page and does not take action by itself.",
      html: "<p><strong>Pool:</strong> Sunday &amp; Pool<br><strong>Season:</strong> 2030 &lt;season&gt;<br><strong>Super Bowl:</strong> Super Bowl &lt;LX&gt;<br><strong>Kickoff:</strong> 2030-02-10T23:00:00.000Z</p><p>Use season administration to acknowledge this is the season&#39;s Super Bowl. After acknowledgment, the season will close automatically once the game is final and all wagers are resolved.</p><p><a href=\"https://officepool.football/p/sunday%20pool/admin/season?view=closure&amp;safe=1\">Open season administration</a></p><p>This link opens the authenticated admin page and does not take action by itself.</p>"
    });
  });

  it("notifies a member when a share order is fulfilled", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolNotifier({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });
    await notifier.notifyShareOrderFulfilled({ to: "member@example.test", poolName: "Sunday Pool", sharesMicros: "2500000", valueMicros: "3750000" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ from: "Yourfootballpool <noreply@officepool.football>", to: ["member@example.test"], subject: "Shares added to Sunday Pool", text: "Your share order in Sunday Pool is complete.\n\n2.50 shares were added to your balance (value: $3.75).", html: "<p>Your share order in <strong>Sunday Pool</strong> is complete.</p><p><strong>2.50 shares</strong> were added to your balance (value: <strong>$3.75</strong>).</p>" });
  });

  it("notifies both commissioners about a completed handoff", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "email-id" }), { status: 200, headers: { "content-type": "application/json" } }));
    const notifier = createResendPoolNotifier({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });
    await notifier.notifyCommissionerTransfer({ to: "new@example.test", poolName: "Sunday Pool", formerCommissionerName: "Alex", newCommissionerName: "Taylor", recipient: "new" });
    await notifier.notifyCommissionerTransfer({ to: "former@example.test", poolName: "Sunday Pool", formerCommissionerName: "Alex", newCommissionerName: "Taylor", recipient: "former" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      from: "Yourfootballpool <noreply@officepool.football>",
      to: ["new@example.test"],
      subject: "You are now commissioner of Sunday Pool",
      text: "Alex made you commissioner of Sunday Pool.",
      html: "<p><strong>Alex</strong> made you commissioner of <strong>Sunday Pool</strong>.</p>"
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({
      from: "Yourfootballpool <noreply@officepool.football>",
      to: ["former@example.test"],
      subject: "Commissioner changed for Sunday Pool",
      text: "You made Taylor commissioner of Sunday Pool.",
      html: "<p>You made <strong>Taylor</strong> commissioner of <strong>Sunday Pool</strong>.</p>"
    });
  });

  it("fails without exposing a Resend response body when delivery is rejected", async () => {
    const providerDetail = "sensitive provider detail";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(providerDetail, { status: 429 }));
    const sender = createResendEmailSender({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });

    const error = await captureError(sender.send({ kind: "password-reset", to: "member@example.test", token: "reset-token", url: "https://officepool.football/api/auth/reset-password/reset-token?callbackURL=%2F" }));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(error.message).toBe("EMAIL_DELIVERY_FAILED");
    expect(error).not.toHaveProperty("cause");
  });

  it("fails without exposing a network error when delivery rejects", async () => {
    const providerDetail = "sensitive network detail";
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(providerDetail));
    const sender = createResendEmailSender({ apiKey: "resend-test-key", from: "Yourfootballpool <noreply@officepool.football>", fetcher });

    const error = await captureError(sender.send({ kind: "verification", to: "member@example.test", token: "verification-token", url: "https://officepool.football/api/auth/verify-email?token=verification-token" }));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(error.message).toBe("EMAIL_DELIVERY_FAILED");
    expect(error).not.toHaveProperty("cause");
  });
});
