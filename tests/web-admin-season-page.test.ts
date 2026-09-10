import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SuperBowlClosureAcknowledgment } from "../src/web/pages/AdminSeasonPage";

describe("commissioner Super Bowl closure acknowledgment", () => {
  it("names the closure action and explains the identified game and automatic closure conditions", () => {
    const markup = renderToStaticMarkup(createElement(SuperBowlClosureAcknowledgment, {
      candidate: { eventId: "sb-1", providerEventName: "Super Bowl LX & finale", confirmedAt: null },
      pending: false,
      onConfirm: () => undefined
    }));

    expect(markup).toContain("Super Bowl LX &amp; finale");
    expect(markup).toContain(">End season after Super Bowl</button>");
    expect(markup).toContain("acknowledges this is the season&#x27;s Super Bowl");
    expect(markup).toContain("close automatically once the game is final and all wagers are resolved");
  });

  it("uses clear acknowledged wording after confirmation", () => {
    const markup = renderToStaticMarkup(createElement(SuperBowlClosureAcknowledgment, {
      candidate: { eventId: "sb-1", providerEventName: "Super Bowl LX", confirmedAt: "2030-01-01T00:00:00.000Z" },
      pending: false,
      onConfirm: () => undefined
    }));

    expect(markup).toContain("Acknowledged: this is the season&#x27;s Super Bowl");
    expect(markup).toContain("close automatically once the game is final and all wagers are resolved");
    expect(markup).not.toContain("<button");
  });
});
