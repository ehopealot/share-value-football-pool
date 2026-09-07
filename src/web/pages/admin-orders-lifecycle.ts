import type { ReadPoolView } from "../../contracts/http";
import { MICROS_PER_UNIT, multiplyDivideRoundHalfEven, parseIntegerText } from "../../domain/fixed-point";

type Order = NonNullable<ReadPoolView["commissioner"]>["seasonOrders"][number]["orders"][number];

export type ProjectedOrder = Order & {
  memberDisplayName: string;
  reversible: boolean;
  reversalStatus: "Active" | "Already reversed" | "Reversal record";
};

export type MemberOrderGroup = {
  memberId: string;
  memberDisplayName: string;
  netSharesMicros: string;
  netValueMicros: string;
  /** Blended price (micros per share): net cost over net shares, since reversal rows carry negative amounts that net out refunds. */
  blendedPriceMicros: string;
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
      reversalStatus: order.reversalOf ? "Reversal record" as const : reversed.has(order.orderId) ? "Already reversed" as const : "Active" as const
    }))
  }));
  const notice = !activeId
    ? view.nextDraftSeason ? "A draft season exists. Open it from Season administration before issuing orders."
      : view.latestClosedSeason ? "This season is closed. Review immutable order history; create and open a new season before issuing orders."
        : "No active season. Create and open a season before issuing orders."
    : undefined;
  return { canOrder: Boolean(activeId), notice, seasons };
}

/** One net row per member, in first-order-seen order; refunded (reversal) orders net against the totals. */
export function groupOrdersByMember(orders: ProjectedOrder[]): MemberOrderGroup[] {
  const totals = new Map<string, { memberDisplayName: string; shares: bigint; value: bigint }>();
  for (const order of orders) {
    const total = totals.get(order.memberId) ?? { memberDisplayName: order.memberDisplayName, shares: 0n, value: 0n };
    total.shares += parseIntegerText(order.sharesMicros);
    total.value += parseIntegerText(order.valueMicros);
    totals.set(order.memberId, total);
  }
  return [...totals].map(([memberId, total]) => ({
    memberId,
    memberDisplayName: total.memberDisplayName,
    netSharesMicros: total.shares.toString(),
    netValueMicros: total.value.toString(),
    blendedPriceMicros: (total.shares === 0n ? 0n : multiplyDivideRoundHalfEven(total.value, MICROS_PER_UNIT, total.shares)).toString()
  }));
}
