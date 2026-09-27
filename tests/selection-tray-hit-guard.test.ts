import { describe, expect, it } from "vitest";
import { SelectionTrayHitGuard } from "../src/web/selection-tray-hit-guard";

const bounds = { left: 0, right: 390, top: 500, bottom: 700 };
const pointer = (clientY: number, pointerId = 1) => ({ clientX: 100, clientY, pointerId });
const click = (clientY: number, pointerId = 1) => ({ ...pointer(clientY, pointerId), detail: 1 });

describe("selection tray hit guard", () => {
  it("allows a board tap and its label-forwarded click when focus moves the tray", () => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(450), bounds);
    expect(guard.blocksClick(click(450), bounds)).toBe(false);
    // Focusing the label's checkbox can move the sticky tray between the two clicks.
    expect(guard.blocksClick(click(450), { ...bounds, top: 400 })).toBe(false);
  });

  it("still blocks a slip-origin tap misdirected to the board after the tray moves away", () => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(550), bounds);
    expect(guard.blocksClick(click(550), { ...bounds, top: 600 })).toBe(true);
  });

  it("replaces the decision on each gesture rather than swallowing the next board tap", () => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(550), bounds);
    expect(guard.blocksClick(click(550), bounds)).toBe(true);
    guard.pointerDown(pointer(450), bounds);
    expect(guard.blocksClick(click(450), bounds)).toBe(false);
  });

  it("allows keyboard and assistive activation even with stale blocked pointer state", () => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(550), bounds);
    expect(guard.blocksClick({ clientX: 0, clientY: 0, detail: 0 }, { ...bounds, top: -20 })).toBe(false);
  });

  it("retains the geometric fallback for clicks without a matching pointer gesture", () => {
    const guard = new SelectionTrayHitGuard();
    expect(guard.blocksClick(click(550), bounds)).toBe(true);
    expect(guard.blocksClick(click(450), bounds)).toBe(false);
    guard.pointerDown(pointer(450, 2), bounds);
    expect(guard.blocksClick(click(550, 3), bounds)).toBe(true);
  });

  it.each([undefined, -1])("supports label-forwarded clicks without a pointing-device id (%s)", (pointerId) => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(450), bounds);
    expect(guard.blocksClick({ clientX: 100, clientY: 450, detail: 1, pointerId }, { ...bounds, top: 400 })).toBe(false);
  });

  it("clears cancelled gestures so scrolls cannot leave a stale decision", () => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(450), bounds);
    guard.pointerCancel(1);
    expect(guard.blocksClick(click(550), bounds)).toBe(true);
  });

  it("does not clear another pointer's decision on cancellation", () => {
    const guard = new SelectionTrayHitGuard();
    guard.pointerDown(pointer(450, 2), bounds);
    guard.pointerCancel(1);
    expect(guard.blocksClick(click(450, 2), { ...bounds, top: 400 })).toBe(false);
  });

  it("allows interactions when the tray is absent", () => {
    const guard = new SelectionTrayHitGuard();
    expect(guard.blocksClick(click(550), undefined)).toBe(false);
    guard.pointerDown(pointer(550), undefined);
    expect(guard.blocksClick(click(550), bounds)).toBe(false);
  });
});
