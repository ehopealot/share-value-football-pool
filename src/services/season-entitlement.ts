export interface SeasonEntitlementService { mayCreatePool(userId: string): Promise<{ allowed: boolean }>; }
export const freeSeasonEntitlement: SeasonEntitlementService = { async mayCreatePool() { return { allowed: true }; } };
