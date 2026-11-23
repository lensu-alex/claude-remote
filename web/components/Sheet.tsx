"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/** How long a closed sheet or menu stays mounted to animate out. Matches the exit transitions in globals.css. */
const EXIT_MS = 300;

const ClosingContext = createContext(false);

/**
 * Keeps a sheet or menu on screen for a moment after it is closed, so it leaves the way it came in.
 * Wrap the usual `{open ? <Sheet /> : null}` in it.
 */
export function Presence({ children }: { children: ReactNode }) {
  const open = children !== null && children !== undefined && children !== false;
  const [state, setState] = useState({ open, closing: false });
  const kept = useRef<ReactNode>(null);
  if (open) kept.current = children;
  // Decided while rendering, so the child is never unmounted for a frame between open and closing.
  if (state.open !== open) setState({ open, closing: !open });

  useEffect(() => {
    if (!state.closing) return;
    const timer = setTimeout(() => {
      kept.current = null;
      setState((s) => (s.closing ? { open: false, closing: false } : s));
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [state.closing]);

  const closing = !open && (state.closing || state.open);
  if (!open && !closing) return null;
  return <ClosingContext.Provider value={closing}>{open ? children : kept.current}</ClosingContext.Provider>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Past its resting place a sheet follows the finger less and less, instead of stopping dead. */
function rubberBand(distance: number, dimension: number) {
  const constant = 0.55;
  return (distance * dimension * constant) / (dimension + constant * distance);
}

type Drag = { id: number; startY: number; engaged: boolean; samples: { y: number; t: number }[] };

/**
 * Glass bottom sheet, the way iOS presents short choices. Tapping outside closes it, and so does
 * dragging or flicking it down.
 */
export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  const closing = useContext(ClosingContext);
  const sheet = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  // A sheet taller than the screen has to scroll, so only a sheet that fits takes drags itself.
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const fit = () => {
      el.style.touchAction = el.scrollHeight > el.clientHeight + 1 ? "" : "none";
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const el = sheet.current;
    if (!el || closing || drag.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (el.scrollHeight > el.clientHeight + 1) return;
    // Text fields and lists that scroll keep their own gestures.
    if ((event.target as HTMLElement).closest("input, textarea, .picker")) return;
    drag.current = { id: event.pointerId, startY: event.clientY, engaged: false, samples: [{ y: event.clientY, t: event.timeStamp }] };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const el = sheet.current;
    if (!state || !el || event.pointerId !== state.id) return;
    const dy = event.clientY - state.startY;
    if (!state.engaged) {
      if (Math.abs(dy) < 6) return;
      state.engaged = true;
      dragged.current = true;
      try {
        el.setPointerCapture(state.id);
      } catch {
        // The pointer can already be gone; the drag still works while it stays over the sheet.
      }
      el.style.transition = "none";
      if (dim.current) dim.current.style.transition = "none";
    }
    state.samples.push({ y: event.clientY, t: event.timeStamp });
    if (state.samples.length > 5) state.samples.shift();
    const height = el.offsetHeight;
    const offset = dy >= 0 ? dy : -rubberBand(-dy, height) * 0.25;
    el.style.transform = `translateY(${offset}px)`;
    if (dim.current) dim.current.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / height));
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const el = sheet.current;
    if (!state || !el || event.pointerId !== state.id) return;
    drag.current = null;
    if (!state.engaged) return;
    // A tap that follows a drag must not press whatever ended up under the finger.
    setTimeout(() => (dragged.current = false), 0);

    const dy = event.clientY - state.startY;
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px per ms, down is positive
    const height = el.offsetHeight;
    // Where the sheet would come to rest if it kept its speed: a short flick counts as much as a long drag.
    const projected = dy + velocity * 180;
    const dismiss = event.type !== "pointercancel" && dy > 0 && (projected > height * 0.5 || velocity > 0.5);

    if (dismiss) {
      el.style.transition = "transform 0.28s cubic-bezier(0.23, 1, 0.32, 1)";
      el.style.transform = "translateY(calc(100% + 24px))";
      if (dim.current) {
        dim.current.style.transition = "opacity 0.28s ease";
        dim.current.style.opacity = "0";
      }
      onClose();
      return;
    }
    // Back to rest, quickly. Clearing the inline styles hands the motion back to the stylesheet.
    el.style.transition = "transform 0.32s cubic-bezier(0.23, 1, 0.32, 1)";
    el.style.transform = "";
    if (dim.current) {
      dim.current.style.transition = "opacity 0.32s ease";
      dim.current.style.opacity = "";
    }
    const settle = () => {
      el.style.transition = "";
      if (dim.current) dim.current.style.transition = "";
      el.removeEventListener("transitionend", settle);
    };
    el.addEventListener("transitionend", settle);
  }

  function onClickCapture(event: ReactMouseEvent) {
    if (!dragged.current) return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className={closing ? "sheet-backdrop is-closing" : "sheet-backdrop"} onClick={onClose}>
      <div className="sheet-dim" ref={dim} aria-hidden="true" />
      <div
        ref={sheet}
        className="sheet glass"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onClickCapture={onClickCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        {title ? <h2 className="sheet-title">{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}

/** Glass menu that opens from the button at the top right, as iOS menus do. */
export function Menu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  const closing = useContext(ClosingContext);
  return (
    <div className={closing ? "menu-backdrop is-closing" : "menu-backdrop"} onClick={onClose}>
      <div className="menu glass" role="menu" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
