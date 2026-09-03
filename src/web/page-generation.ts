export type PageGenerationTicket = { id: number; slug: string };

/** Fences an async continuation to the route instance that started it. */
export class PageGeneration {
  private next = 0;
  private active?: PageGenerationTicket;
  start(slug: string): PageGenerationTicket { const ticket = { id: ++this.next, slug }; this.active = ticket; return ticket; }
  capture(slug: string): PageGenerationTicket | undefined { return this.active?.slug === slug ? this.active : undefined; }
  current(ticket: PageGenerationTicket): boolean { return this.active?.id === ticket.id && this.active.slug === ticket.slug; }
  invalidate(ticket: PageGenerationTicket): void { if (this.current(ticket)) this.active = undefined; }
}
