import type { ReadPoolView } from "../../contracts/http";

type Order = NonNullable<ReadPoolView["commissioner"]>["seasonOrders"][number]["orders"][number];

export type ProjectedOrder = Order & {
  memberDisplayName: string;
  reversible: boolean;
  reversalStatus?: "Already reversed" | "Reversal record";
};

export type AdminOrdersProjection = {
  canOrder: boolean;
  notice?: string;
  seasons: Array<{ seasonId: string; readOnly: boolean; orders: ProjectedOrder[] }>;
};

/** Page-specific ReadPoolView projection; active history alone may offer reversals. */
export function projectAdminOrders(view: ReadPoolView): AdminOrdersProjection {
  const activeId = view.activeSeason?.id;
  const reversed = new Set((view.commissioner?.seasonOrders ?? []).flatMap(set => set.orders.flatMap(order => order.reversalOf ? [order.reversalOf] : [])));
  const names = new Map(view.members.map(member => [member.memberId, member.displayName]));
  const seasons = (view.commissioner?.seasonOrders ?? []).map(set => ({
    seasonId: set.seasonId,
    readOnly: set.seasonId !== activeId,
    orders: set.orders.map(order => ({
      ...order,
      memberDisplayName: names.get(order.memberId) ?? order.memberId,
      reversible: set.seasonId === activeId && !order.reversalOf && !reversed.has(order.orderId),
      reversalStatus: order.reversalOf ? "Reversal record" as const : reversed.has(order.orderId) ? "Already reversed" as const : undefined
    }))
  }));
  const notice = !activeId
    ? view.nextDraftSeason ? "A draft season exists. Open it from Season administration before issuing orders."
      : view.latestClosedSeason ? "This season is closed. Review immutable order history; create and open a new season before issuing orders."
        : "No active season. Create and open a season before issuing orders."
    : undefined;
  return { canOrder: Boolean(activeId), notice, seasons };
}
