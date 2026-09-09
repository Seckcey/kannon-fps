import type { InputController } from './InputController';

type Role = 'move' | 'look' | 'fire' | 'jump' | 'reload';
type Source = 'touch' | 'pointer';
interface Contact { id: number; source: Source; role: Role; target: HTMLElement; x: number; y: number; originX: number; originY: number }
const roles = new Set(['move', 'look', 'fire', 'jump', 'reload']);

/** Native TouchEvents identify each iPhone finger independently of pointer
 * capture. The document's complete live-contact list reconciles missed element
 * releases. A held stationary finger never expires on a timer. */
export class TouchGestures {
  private nativeTouch = 'ontouchstart' in window;
  private contacts = new Map<Role, Contact>();
  private abort = new AbortController();
  private unsubscribe: () => void;
  constructor(private root: HTMLElement, private input: InputController, private stick: (x: number, y: number) => void) {
    const options = { capture: true, passive: false, signal: this.abort.signal };
    root.addEventListener('touchstart', this.touchStart, options);
    document.addEventListener('touchmove', this.touchMove, options);
    document.addEventListener('touchend', this.touchEnd, options);
    document.addEventListener('touchcancel', this.touchCancel, options);
    document.addEventListener('touchstart', this.reconcileEvent, options);
    root.addEventListener('pointerdown', this.pointerDown, options);
    document.addEventListener('pointermove', this.pointerMove, options);
    document.addEventListener('pointerup', this.pointerUp, options);
    document.addEventListener('pointercancel', this.pointerCancel, options);
    document.addEventListener('lostpointercapture', this.pointerCancel, options);
    this.unsubscribe = input.subscribeReset(() => this.clear());
  }
  private target(eventTarget: EventTarget | null) {
    if (!(eventTarget instanceof Element)) return null;
    const element = eventTarget.closest<HTMLElement>('[data-touch]');
    return element && this.root.contains(element) && roles.has(element.dataset.touch ?? '') ? element : null;
  }
  private start(id: number, source: Source, target: HTMLElement, x: number, y: number) {
    const role = target.dataset.touch as Role;
    if (!this.input.acceptsInput || this.contacts.has(role)) return;
    const bounds = target.getBoundingClientRect();
    const contact = { id, source, target, role, x, y, originX: bounds.x + bounds.width / 2, originY: bounds.y + bounds.height / 2 };
    this.contacts.set(role, contact);
    if (role === 'move') this.move(contact, x, y);
    if (role === 'fire' || role === 'jump' || role === 'reload') {
      if (role === 'fire') this.input.setFireAim(this.input.firingMode === 'advanced');
      this.input.setAction(role, true);
    }
    if (source === 'pointer') { try { target.setPointerCapture(id); } catch { /* Document listeners own release even without capture. */ } }
  }
  private move(contact: Contact, x: number, y: number) {
    if (contact.role === 'move') {
      const dx = x - contact.originX, dy = y - contact.originY;
      const scale = Math.max(1, Math.hypot(dx, dy) / 44);
      this.stick(dx / scale, dy / scale); this.input.setTouchMove(dx / scale / 44, -dy / scale / 44);
    } else if (contact.role === 'look' || contact.role === 'fire') {
      // The firing thumb can aim too. If both aiming contacts exist, the
      // dedicated look thumb owns rotation to avoid doubled input.
      if (contact.role === 'look' || !this.contacts.has('look')) this.input.setTouchLook(x - contact.x, y - contact.y);
    }
    contact.x = x; contact.y = y;
  }
  private end(contact: Contact, cancelled: boolean) {
    this.contacts.delete(contact.role);
    if (contact.role === 'move') { this.input.setTouchMove(0, 0); this.stick(0, 0); }
    if (contact.role === 'fire' || contact.role === 'jump' || contact.role === 'reload') {
      if (cancelled) this.input.cancelAction(contact.role); else this.input.setAction(contact.role, false);
      if (contact.role === 'fire') this.input.setFireAim(false);
    }
    if (contact.source === 'pointer') { try { if (contact.target.hasPointerCapture(contact.id)) contact.target.releasePointerCapture(contact.id); } catch { /* It may already be gone. */ } }
  }
  private reconcile(touches: TouchList) {
    const live = new Set(Array.from(touches, touch => touch.identifier));
    for (const contact of this.contacts.values()) if (contact.source === 'touch' && !live.has(contact.id)) this.end(contact, true);
  }
  private reconcileEvent = (event: TouchEvent) => this.reconcile(event.touches);
  private touchStart = (event: TouchEvent) => {
    this.nativeTouch = true;
    this.reconcile(event.touches);
    for (const touch of Array.from(event.changedTouches)) {
      const target = this.target(touch.target ?? event.target); if (!target) continue;
      event.preventDefault();
      // Hybrid browsers may expose TouchEvents only after the first contact.
      // Transfer that pointer gesture before its compatibility cancellation.
      const previous = this.contacts.get(target.dataset.touch as Role);
      if (previous?.source === 'pointer') this.end(previous, true);
      this.start(touch.identifier, 'touch', target, touch.clientX, touch.clientY);
    }
  };
  private touchMove = (event: TouchEvent) => {
    this.reconcile(event.touches);
    for (const touch of Array.from(event.changedTouches)) {
      const contact = [...this.contacts.values()].find(c => c.source === 'touch' && c.id === touch.identifier);
      if (contact) { event.preventDefault(); this.move(contact, touch.clientX, touch.clientY); }
    }
  };
  private endTouches(event: TouchEvent, cancelled: boolean) {
    for (const touch of Array.from(event.changedTouches)) {
      const contact = [...this.contacts.values()].find(c => c.source === 'touch' && c.id === touch.identifier);
      if (contact) this.end(contact, cancelled);
    }
    this.reconcile(event.touches);
  }
  private touchEnd = (event: TouchEvent) => this.endTouches(event, false);
  private touchCancel = (event: TouchEvent) => this.endTouches(event, true);
  private pointerDown = (event: PointerEvent) => {
    // iOS/Android deliver both event families. A finger must have one owner.
    if (event.pointerType === 'touch' && this.nativeTouch) return;
    const target = this.target(event.target); if (!target || event.button !== 0) return;
    event.preventDefault(); this.start(event.pointerId, 'pointer', target, event.clientX, event.clientY);
  };
  private pointerMove = (event: PointerEvent) => {
    const contact = [...this.contacts.values()].find(c => c.source === 'pointer' && c.id === event.pointerId);
    if (!contact) return;
    if (event.buttons === 0) { this.end(contact, true); return; }
    event.preventDefault(); this.move(contact, event.clientX, event.clientY);
  };
  private endPointer(event: PointerEvent, cancelled: boolean) {
    const contact = [...this.contacts.values()].find(c => c.source === 'pointer' && c.id === event.pointerId);
    if (contact) this.end(contact, cancelled);
  }
  private pointerUp = (event: PointerEvent) => this.endPointer(event, false);
  private pointerCancel = (event: PointerEvent) => this.endPointer(event, true);
  private clear() { for (const contact of [...this.contacts.values()]) this.end(contact, true); }
  dispose() { this.unsubscribe(); this.abort.abort(); this.clear(); }
}
