export interface Clock { now(): Date; }
export const systemClock: Clock = { now: () => new Date() };
export class FixedClock implements Clock { constructor(private readonly value: Date) {} now(): Date { return new Date(this.value); } }
