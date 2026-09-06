export const screenshotViewports = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }];

export const screenshotRoutes = (slug, seasonId, poolName, seasonLabel) => [
  { name: "overview", path: `/p/${slug}/overview`, heading: poolName },
  { name: "odds", path: `/p/${slug}/odds`, heading: "Odds board" },
  { name: "teaser", path: `/p/${slug}/teaser`, heading: "Teaser builder" },
  { name: "my-wagers", path: `/p/${slug}/my-wagers`, heading: "My Bets" },
  { name: "standings", path: `/p/${slug}/standings`, heading: "Standings" },
  { name: "activity", path: `/p/${slug}/activity`, heading: "Activity" },
  { name: "rules", path: `/p/${slug}/rules`, heading: "Pool rules" },
  { name: "orders", path: `/p/${slug}/admin/orders`, heading: "Share orders" },
  { name: "history", path: `/p/${slug}/history/${seasonId}`, heading: `Archived season: ${seasonLabel}` }
];
