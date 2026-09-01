export const screenshotRoutes = (slug, seasonId) => [
  { name: "overview", path: `/p/${slug}/overview`, heading: "Finish Review Pool" },
  { name: "odds", path: `/p/${slug}/odds`, heading: "Odds board" },
  { name: "teaser", path: `/p/${slug}/teaser`, heading: "Teaser builder" },
  { name: "my-wagers", path: `/p/${slug}/my-wagers`, heading: "My wagers" },
  { name: "standings", path: `/p/${slug}/standings`, heading: "Standings" },
  { name: "activity", path: `/p/${slug}/activity`, heading: "Activity" },
  { name: "rules", path: `/p/${slug}/rules`, heading: "Pool rules" },
  { name: "orders", path: `/p/${slug}/admin/orders`, heading: "Share orders" },
  { name: "history", path: `/p/${slug}/history/${seasonId}`, heading: "Archived season: Accessibility 2026" }
];
