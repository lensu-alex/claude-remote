"use client";

import { useLayoutEffect, useState, ViewTransition, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { cacheTasksScroll } from "@/lib/cache";
import { Gear, ListIcon, Plus } from "./Icons";

// How one screen replaces another. A link or `router` call names the move with `transitionTypes`,
// and the values here are the classes animated under "Moving between screens" in globals.css.
// Anything unnamed, such as the system's own back swipe, changes screens without animating.
const ENTER = { push: "push-in", pop: "pop-in", present: "present-in", dismiss: "dismiss-in", tab: "tab-in", default: "none" };
const EXIT = { push: "push-out", pop: "pop-out", present: "present-out", dismiss: "dismiss-out", tab: "tab-out", default: "none" };

/** The root of a whole screen. Arriving at it and leaving it move the way they do on iOS. */
export function Screen({
  className = "screen",
  ref,
  children,
}: {
  className?: string;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <ViewTransition enter={ENTER} exit={EXIT} default="none">
      <div className={className} ref={ref}>
        {children}
      </div>
    </ViewTransition>
  );
}

/** True once the page has scrolled far enough for the large title to have left the screen. */
function useScrolled(threshold: number) {
  const [scrolled, setScrolled] = useState(false);
  // A layout effect, so a screen that opens already scrolled is drawn that way from its first frame.
  useLayoutEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

/**
 * The floating top area: content fades out beneath it, and any buttons in it are glass.
 * With `large`, the small title only appears after the page's large title has scrolled away.
 */
export function TopBar({
  title,
  subtitle,
  left,
  right,
  large = false,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  large?: boolean;
}) {
  const scrolled = useScrolled(46);
  const shown = !large || scrolled;
  return (
    <header className={large ? (scrolled ? "topbar topbar-large is-scrolled" : "topbar topbar-large") : "topbar"}>
      <div className="topbar-row">
        <div className="topbar-side">{left}</div>
        <div className={shown ? "topbar-title" : "topbar-title is-hidden"} aria-hidden={large ? true : undefined}>
          {large ? <span className="topbar-name">{title}</span> : <h1 className="topbar-name">{title}</h1>}
          {subtitle ? <p className="topbar-sub">{subtitle}</p> : null}
        </div>
        <div className="topbar-side topbar-end">{right}</div>
      </div>
    </header>
  );
}

/** The floating bar on the two main screens: a glass capsule of tabs, and the new-task button beside it. */
export function TabBar({ current }: { current: "tasks" | "settings" }) {
  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabs glass">
        <Link
          href="/"
          className={current === "tasks" ? "tab is-current" : "tab"}
          aria-current={current === "tasks" ? "page" : undefined}
          transitionTypes={["tab"]}
          onClick={() => cacheTasksScroll(0)}
        >
          <ListIcon size={24} />
          <span>Tasks</span>
        </Link>
        <Link
          href="/settings"
          className={current === "settings" ? "tab is-current" : "tab"}
          aria-current={current === "settings" ? "page" : undefined}
          transitionTypes={["tab"]}
        >
          <Gear size={24} />
          <span>Settings</span>
        </Link>
      </div>
      <Link
        href="/new"
        className="fab glass glass-tint"
        aria-label="New task"
        transitionTypes={["present"]}
        onClick={current === "tasks" ? () => cacheTasksScroll(window.scrollY) : undefined}
      >
        <Plus size={26} />
      </Link>
    </nav>
  );
}
