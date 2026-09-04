import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectedLegDisplay } from "../src/web/components/SelectedLegDisplay";

const render = (props: Parameters<typeof SelectedLegDisplay>[0]) => renderToStaticMarkup(createElement(SelectedLegDisplay, props));

describe("SelectedLegDisplay", () => {
  it("emphasizes the selected side within the matchup", () => {
    expect(render({ league: "nfl", awayTeam: "Away", homeTeam: "Home", market: "spread", selection: "away", selectedDetail: "+3" })).toBe('<strong>Away (+3)</strong><span> at Home</span>');
    expect(render({ league: "nfl", awayTeam: "Away", homeTeam: "Home", market: "spread", selection: "home", selectedDetail: "-3" })).toBe('<span>Away at </span><strong>Home (-3)</strong>');
  });

  it("emphasizes total selections after the matchup", () => {
    expect(render({ league: "nfl", awayTeam: "Away", homeTeam: "Home", market: "total", selection: "over", selectedDetail: "45.5" })).toBe('<span>Away at Home </span><strong>O45.5</strong>');
  });
});
