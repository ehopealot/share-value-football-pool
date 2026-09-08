import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemberActivitySection } from "../src/web/pages/ActivityPage";
import { StandingsTable } from "../src/web/pages/StandingsPage";
import { BoardAuthorName } from "../src/web/pages/MessageBoardPage";

const page = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MemberProfilePage.tsx"), "utf8");
const router = readFileSync(resolve(import.meta.dirname, "../src/web/router.tsx"), "utf8");
const activity = readFileSync(resolve(import.meta.dirname, "../src/web/pages/ActivityPage.tsx"), "utf8");
const standings = readFileSync(resolve(import.meta.dirname, "../src/web/pages/StandingsPage.tsx"), "utf8");
const board = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MessageBoardPage.tsx"), "utf8");

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

describe("member profile page", () => {
  it("registers the member profile route", () => {
    expect(router).toContain('path="/p/:slug/member/:memberId" element={<MemberProfilePage/>}');
  });

  it("shows season stats where every bet counts as one pick", () => {
    expect(page).toContain('<h2 className="table-ribbon">Season stats</h2>');
    expect(page).toContain('<tr><th scope="row">Season record</th><td>{formatPickRecord(pickRecord(seasonWagers))}</td></tr>');
    expect(page).toContain('<tr><th scope="row">Straight</th><td>{recordOf(["straight"])}</td></tr>');
    expect(page).toContain('<tr><th scope="row">Teasers</th><td>{recordOf(["teaser"])}</td></tr>');
    expect(page).toContain('<tr><th scope="row">Parlays</th><td>{recordOf(["parlay"])}</td></tr>');
    expect(page).not.toContain('<th scope="row">Teaser</th>');
    expect(page).not.toContain('<th scope="row">Parlay</th>');
    expect(page).toContain("Each bet counts as one pick. Refunded bets don't affect win-loss records.");
    expect(page).not.toContain('<th scope="row">Refunded</th>');
    expect(page).toContain('<tr><th scope="row">Season P&amp;L</th><td>{formatWeeklyPerformance(seasonPerformanceMicros(seasonWagers))}</td></tr>');
  });

  it("defaults the week selector to the current week and announces empty and hidden weeks", () => {
    expect(page).toContain("profileWeekOptions(");
    expect(page).toContain("weeks.includes(selectedWeek) ? selectedWeek : currentWeek");
    expect(page).toContain("weekNumberLabel(start)");
    expect(page).toContain("unstarted.length > 0 ? <p className=\"state-notice\">Selections not visible yet.</p>");
    expect(page).toContain("No bets this week.");
    expect(page).not.toContain("No bets yet this season.");
  });

  it("splits the selected week into In process and Settled sections built from Activity tables", () => {
    expect(page).toContain("splitProfileWeekWagers(");
    expect(page).toContain('title="In process"');
    expect(page).toContain('title="Settled"');
  });

  it("links member names to profiles from standings, activity, and the message board", () => {
    expect(standings).toContain("memberProfilePath={(userId) => `/p/${slug}/member/${userId}`}");
    expect(activity).toContain('title={<Link className="activity-member-link" to={`/p/${slug}/member/${member.memberId}`}>{member.memberDisplayName}</Link>}');
    expect(board).toContain("memberProfileHref?.(thread.authorDisplayName)");
    expect(board).toContain("memberProfileHref?.(reply.authorDisplayName)");
    expect(board).toContain("if (ids.length === 1) hrefs.set(displayName, `/p/${slug}/member/${ids[0]}`)");
  });

  it("refreshes board author links with each load and renders them only against a matching snapshot", () => {
    expect(board).toContain("void readMemberProfileDirectory(slug, () => api.poolView(slug))");
    expect(board).toContain("memberDirectory.slug === slug && memberDirectory.commandVersion === board.commandVersion");
    expect(board).toContain("setMemberDirectory(undefined)");
  });

  it("resets profile state and rejects superseded loads when the route identity changes", () => {
    expect(page).toContain('setActivity(undefined); setView(undefined); setError(""); setSelectedWeek("");');
    expect(page).toContain("}, [slug, memberId]);");
    expect(page).toContain(".catch((reason) => { if (active) setError(errorMessage(reason)); });");
  });

  it("mounts fresh state per route identity so one pool can never render under another", () => {
    expect(page).toContain('return <MemberProfileBody key={`${slug}:${memberId}`} slug={slug} memberId={memberId}/>;');
    expect(board).toContain('return <MessageBoardPageBody key={slug} slug={slug}/>;');
    expect(activity).toContain('return <ActivityPageBody key={slug} slug={slug}/>;');
    expect(standings).toContain('return <StandingsPageBody key={slug} slug={slug}/>;');
  });

  it("renders profile-linked standings names while keeping plain names without a path", () => {
    const linked = render(createElement(MemoryRouter, {}, createElement(StandingsTable, { standings: [{ userId: "member-1", rank: 1, displayName: "Bruin", availableMicros: "0", lockedMicros: "0", totalMicros: "0", notionalValueMicros: "0", priceMicros: "1000000", gainMicros: "0", riskedMicros: "0" }], memberProfilePath: (userId) => `/p/demo-pool/member/${userId}` })));
    expect(linked).toContain('href="/p/demo-pool/member/member-1"');
    expect(linked).toContain(">Bruin</a>");
    const plain = render(createElement(StandingsTable, { standings: [{ userId: "member-1", rank: 1, displayName: "Bruin", availableMicros: "0", lockedMicros: "0", totalMicros: "0", notionalValueMicros: "0", priceMicros: "1000000", gainMicros: "0", riskedMicros: "0" }] }));
    expect(plain).toContain("<th scope=\"row\">Bruin</th>");
  });

  it("uses section titles in place of member names on profile wager ribbons", () => {
    const html = render(createElement(MemoryRouter, {}, createElement(MemberActivitySection, { member: { memberId: "member-1", memberDisplayName: "Bruin", performanceMicros: "0", wagers: [] }, title: "In process" })));
    expect(html).toContain('<h3 class="activity-member-ribbon">In process<small>+0.00 shares</small></h3>');
    expect(html).not.toContain("Bruin");
  });

  it("links board authors only when a profile href resolves", () => {
    const linked = render(createElement(MemoryRouter, {}, createElement(BoardAuthorName, { displayName: "Sunday Shark", profileHref: "/p/demo-pool/member/member-9" })));
    expect(linked).toContain('href="/p/demo-pool/member/member-9"');
    expect(linked).toContain(">Sunday Shark</a></strong>");
    const plain = render(createElement(BoardAuthorName, { displayName: "Sunday Shark" }));
    expect(plain).toContain("<strong>Sunday Shark</strong>");
  });
});
