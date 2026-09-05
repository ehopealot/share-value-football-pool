import { MarketSemanticError, validateCanonicalMarket } from "./market-semantics";
import type { CanonicalOffer, MarketName, ProviderBook, ProviderEvent } from "./types";
import { CANONICAL_BOOK_POLICY_VERSION, canonicalBooks } from "./types";

const complete = (event: ProviderEvent, market: MarketName, canonicalBook: string, book: ProviderBook) => {
  const found = book.markets.find((item) => item.key === market);
  if (!found) return undefined;
  try {
    const validated = validateCanonicalMarket({ market, canonicalBook, policyVersion: CANONICAL_BOOK_POLICY_VERSION, homeTeam: event.homeTeam, awayTeam: event.awayTeam, outcomes: found.outcomes });
    return { key: market, outcomes: validated.outcomes } as const;
  } catch (error) {
    if (error instanceof MarketSemanticError && error.kind === "incomplete") return undefined;
    throw error;
  }
};

const configuredIdentity = (book: ProviderBook) => canonicalBooks.filter((name) => book.title === name || book.key === name.toLowerCase());

/** Reject duplicate/ambiguous configured containers before order-independent canonical selection. */
function configuredBooks(event: ProviderEvent): Map<typeof canonicalBooks[number], ProviderBook> {
  const selected = new Map<typeof canonicalBooks[number], ProviderBook>();
  for (const book of event.bookmakers) {
    const identities = configuredIdentity(book);
    if (identities.length > 1) throw new MarketSemanticError("invalid", "Ambiguous configured bookmaker identity");
    const identity = identities[0];
    if (!identity) continue;
    if (selected.has(identity)) throw new MarketSemanticError("invalid", `Duplicate configured bookmaker: ${identity}`);
    const marketKeys = new Set<MarketName>();
    for (const market of book.markets) {
      if (marketKeys.has(market.key)) throw new MarketSemanticError("invalid", `Duplicate market key in ${identity}: ${market.key}`);
      marketKeys.add(market.key);
    }
    selected.set(identity, book);
  }
  return selected;
}

/** Select the first complete configured book per market; never selection-shop. */
export function canonicalize(event: ProviderEvent, retrievedAt: string): CanonicalOffer[] {
  const books = configuredBooks(event);
  return (["spread", "total", "moneyline"] as MarketName[]).flatMap((market) => {
    for (const name of canonicalBooks) {
      const book = books.get(name);
      const payload = book && complete(event, market, name, book);
      if (payload) return [{ eventId: event.id, market, canonicalBook: name, retrievedAt, offerVersion: `${event.id}:${market}:${retrievedAt}`, policyVersion: CANONICAL_BOOK_POLICY_VERSION, payload }];
    }
    return [];
  });
}
