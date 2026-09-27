export type ClientRectBounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
type PointerPoint = { clientX: number; clientY: number; pointerId: number };
type ClickPoint = { clientX: number; clientY: number; detail: number; pointerId?: number };

export const pointInsideSelectionTray = (clientX: number, clientY: number, bounds: ClientRectBounds): boolean => clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;

export class SelectionTrayHitGuard {
  private pointer?: { id: number; insideTray: boolean };

  pointerDown(event: PointerPoint, bounds: ClientRectBounds | undefined): void {
    this.pointer = { id: event.pointerId, insideTray: !!bounds && pointInsideSelectionTray(event.clientX, event.clientY, bounds) };
  }

  pointerCancel(pointerId: number): void {
    if (this.pointer?.id === pointerId) this.pointer = undefined;
  }

  blocksClick(event: ClickPoint, bounds: ClientRectBounds | undefined): boolean {
    // Keyboard/assistive activation has no meaningful hit-test coordinates.
    if (event.detail === 0) return false;
    if (this.pointer && (event.pointerId === undefined || event.pointerId === -1 || event.pointerId === this.pointer.id)) {
      // Keep the decision for both the label click and its forwarded checkbox click.
      // Focus/scroll/viewport changes between them must not reinterpret the same tap.
      return this.pointer.insideTray;
    }
    return !!bounds && pointInsideSelectionTray(event.clientX, event.clientY, bounds);
  }
}
