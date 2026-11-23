"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { deleteConversation, errorMessage, renameConversation, requestStop, sendMessage } from "@/lib/actions";
import { cacheChat, cachedChat, forgetChat } from "@/lib/cache";
import { folderLabel } from "@/lib/format";
import type { Conversation, EventRow, RunChoice } from "@/lib/types";
import { useDevices, useOnWake } from "@/components/Providers";
import { pendingAnswers } from "@/lib/answers";
import { runLabel } from "@/lib/models";
import { loadDraft, loadRun, saveDraft, saveRun } from "@/lib/store";
import { reloadIfOutdated } from "@/lib/version";
import { AttachButton, AttachmentPreviews, useAttachments } from "@/components/Attachments";
import { Screen, TopBar } from "@/components/Chrome";
import { ArrowDown, ArrowUp, ChevronLeft, More, Pencil, Sliders, Stop, Trash } from "@/components/Icons";
import { RunSheet } from "@/components/RunOptions";
import { Menu, Presence, Sheet } from "@/components/Sheet";
import { blockFirstId, buildBlocks, TimelineBlock, type Block } from "@/components/Timeline";

const PAGE = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalise(rows: unknown[]): EventRow[] {
  return (rows as EventRow[]).map((row) => ({ ...row, id: Number(row.id), body: row.body ?? {} }));
}

function merge(current: EventRow[], incoming: EventRow[]): EventRow[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The run of steps Claude is in right now: the last block, ignoring follow-ups the user has queued after it. */
function liveBlockKey(blocks: Block[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind === "steps") return block.key;
    if (block.event.kind !== "user") return null;
  }
  return null;
}

/** True when Claude's last turn ended by asking something and nothing has been sent since. */
function endedWithQuestion(events: EventRow[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind === "user") return false;
    if (e.kind === "result") return e.body.question === true;
  }
  return false;
}

/**
 * Keeps the chat exactly as tall as the visible area, so the composer sits on top of the
 * iPhone keyboard instead of underneath it.
 */
function useVisibleHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    // The visible height with no keyboard, measured whenever nothing is being typed into.
    let fullHeight = viewport.height;
    const typing = () => {
      const el = document.activeElement;
      return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox");
    };
    const apply = () => {
      if (!typing()) fullHeight = viewport.height;
      // The keyboard is up when a text field has focus and the visible area shrank. This does not use
      // window.innerHeight: in an app opened from the Home Screen it can shrink with the keyboard too,
      // and then the keyboard went unnoticed and the chat was left sitting above the screen.
      const keyboard = typing() && fullHeight - viewport.height > 120;
      root.style.setProperty("--app-height", `${viewport.height}px`);
      // Only the keyboard moves the visible area. Without it, iOS reports the page's rubber-band
      // bounce here, and following that slides the chat against the finger.
      root.style.setProperty("--app-offset", `${keyboard ? Math.max(0, viewport.offsetTop) : 0}px`);
      // With the keyboard up there is no home indicator to clear, so the composer can sit lower.
      root.classList.toggle("keyboard-open", keyboard);
    };
    // Focus changes before the keyboard finishes moving, so look again once it has settled.
    const onFocus = () => {
      apply();
      setTimeout(apply, 350);
    };
    // The chat fills the screen, so the page behind it must not scroll or bounce.
    root.classList.add("chat-open");
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-offset");
      root.classList.remove("keyboard-open", "chat-open");
    };
  }, []);
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { devices, active, activeOn, health } = useDevices();

  // A chat opened before is drawn from memory straight away and brought up to date underneath.
  const [cached] = useState(() => cachedChat(id));
  const [conversation, setConversation] = useState<Conversation | null>(cached?.conversation ?? null);
  const [missing, setMissing] = useState(!UUID.test(id));
  const [events, setEvents] = useState<EventRow[]>(cached?.events ?? []);
  const [loaded, setLoaded] = useState(cached !== null);
  const [hasEarlier, setHasEarlier] = useState(cached?.hasEarlier ?? false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"menu" | "rename" | "delete" | "run" | null>(null);
  // The model and effort for messages sent from this chat, remembered on this phone.
  const [run, setRun] = useState<RunChoice>({ model: "", effort: "" });
  useEffect(() => setRun(loadRun(id)), [id]);
  function chooseRun(next: RunChoice) {
    setRun(next);
    saveRun(id, next);
  }
  const [newTitle, setNewTitle] = useState("");
  const [atBottom, setAtBottom] = useState(true);

  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true); // follow new output unless the user scrolled up
  const keepFromBottom = useRef<number | null>(null); // restores position after loading earlier events
  const holding = useRef(events); // the events on screen, for code that runs outside a render
  const firstLoad = useRef(cached === null);
  // The newest event on screen when the chat opened. Anything after it eases in; nothing before it does.
  const seenUpTo = useRef<number | null>(cached ? (cached.events[cached.events.length - 1]?.id ?? 0) : null);
  const photos = useAttachments();

  useVisibleHeight();

  // An unsent message survives leaving the chat or reloading the page.
  useEffect(() => {
    const saved = loadDraft(id);
    if (!saved) return;
    setDraft(saved);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    });
  }, [id]);

  const refresh = useCallback(async () => {
    if (!UUID.test(id)) return;
    const sb = getSupabase();
    const [c, e] = await Promise.all([
      sb.from("conversations").select("*").eq("id", id).maybeSingle(),
      sb.from("events").select("*").eq("conversation_id", id).order("id", { ascending: false }).limit(PAGE),
    ]);
    if (!c.error) {
      if (c.data) setConversation(c.data as Conversation);
      else setMissing(true);
    }
    if (!e.error && e.data) {
      const rows = normalise(e.data).reverse();
      const full = rows.length === PAGE;
      const held = holding.current;
      // So much has happened since this chat was last drawn that the newest page doesn't reach
      // back to what is held. Start again from the newest page rather than leave a hole.
      const gap = full && held.length > 0 && rows[0].id > held[held.length - 1].id;
      setEvents(gap ? rows : (current) => merge(current, rows));
      if (gap) setHasEarlier(true);
      if (firstLoad.current) {
        firstLoad.current = false;
        seenUpTo.current = rows.length > 0 ? rows[rows.length - 1].id : 0;
        setHasEarlier(full);
      }
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    holding.current = events;
    if (missing) forgetChat(id);
    else if (loaded) cacheChat(id, { conversation, events, hasEarlier });
  }, [id, missing, loaded, conversation, events, hasEarlier]);

  useEffect(() => {
    if (!UUID.test(id)) return;
    const sb = getSupabase();
    const onEvent = (payload: { new: unknown }) => setEvents((current) => merge(current, normalise([payload.new])));
    const channel = sb
      .channel(`chat-${id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `conversation_id=eq.${id}` }, onEvent)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "events", filter: `conversation_id=eq.${id}` }, onEvent)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${id}` }, (payload) =>
        setConversation(payload.new as Conversation),
      )
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "conversations" }, (payload) => {
        if ((payload.old as { id?: string }).id === id) setMissing(true);
      })
      .subscribe((status) => {
        // Runs on first connect and on every reconnect, so nothing sent in between is lost.
        if (status === "SUBSCRIBED") void refresh();
      });
    void refresh();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [id, refresh]);

  useOnWake(refresh);

  // While a task is active, also poll slowly in case the live connection silently stalls.
  const busy = conversation?.status === "running" || conversation?.status === "queued";
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const blocks = useMemo(() => buildBlocks(events), [events]);
  const liveKey = useMemo(() => liveBlockKey(blocks), [blocks]);
  const asked = useMemo(() => endedWithQuestion(events), [events]);
  const answers = useMemo(() => pendingAnswers(events), [events]);

  // A reply that has just ended may use something only a newer version of the app can show
  // (the app is often updated from inside a chat), so that is a moment to check for one.
  const lastKind = events[events.length - 1]?.kind;
  const lastId = events[events.length - 1]?.id;
  useEffect(() => {
    if (settled.current && (lastKind === "result" || lastKind === "error")) void reloadIfOutdated();
  }, [lastKind, lastId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [blocks, conversation?.status, loaded, photos.items.length, photos.reading]);

  // The composer floats over the chat, so the chat needs to know how tall it is to end above it.
  useEffect(() => {
    const el = dock.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      root.current?.style.setProperty("--dock-height", `${el.offsetHeight}px`);
      // On the next frame, so the scroll does not count as a change inside the observer's own pass.
      requestAnimationFrame(() => {
        const list = scroller.current;
        if (list && stick.current) list.scrollTop = list.scrollHeight;
      });
    });
    observer.observe(el);
    // The keyboard makes the chat shorter; like Messages, keep the latest message in view.
    // Its outer size only: the padding below follows --dock-height, set in this same observer.
    if (scroller.current) observer.observe(scroller.current, { box: "border-box" });
    return () => observer.disconnect();
  }, [missing]);

  // Dragging the chat puts the keyboard away, as it does in Messages.
  const touchY = useRef(0);
  function onTouchMove(y: number) {
    if (Math.abs(y - touchY.current) > 24 && document.activeElement === input.current) input.current?.blur();
  }

  const hasDraft = draft.trim().length > 0 || photos.items.length > 0;
  // While Claude works the button stops it; once something is typed it sends that as a follow-up.
  const showStop = busy && !hasDraft;
  // Send and Stop trade places with a small animation, but not when the chat first opens.
  const settled = useRef(false);
  const [swap, setSwap] = useState({ stop: showStop, done: false });
  if (swap.stop !== showStop) setSwap({ stop: showStop, done: settled.current });
  useEffect(() => {
    if (loaded) settled.current = true;
  }, [loaded]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAtBottom(near);
  }

  function jumpToLatest() {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  async function loadEarlier() {
    const first = events[0];
    const el = scroller.current;
    if (!first || !el || loadingEarlier) return;
    setLoadingEarlier(true);
    const { data, error } = await getSupabase()
      .from("events")
      .select("*")
      .eq("conversation_id", id)
      .lt("id", first.id)
      .order("id", { ascending: false })
      .limit(PAGE);
    if (!error && data) {
      keepFromBottom.current = el.scrollHeight - el.scrollTop;
      stick.current = false;
      setHasEarlier(data.length === PAGE);
      setEvents((current) => merge(current, normalise(data)));
    }
    setLoadingEarlier(false);
  }

  const owner = devices.find((d) => d.id === conversation?.device_id) ?? null;
  // Offered only when the laptop that runs this chat has a helper new enough to act on it.
  const runner = owner ?? active;
  const canChooseRun = Boolean(runner && (health[runner.id]?.version ?? 0) >= 2);
  // A chat can only continue on the laptop that ran it.
  const elsewhere = Boolean(conversation?.device_id && active && conversation.device_id !== active.id);
  const stopping = Boolean(conversation?.stop_requested);

  /** One tap on an offered answer sends it as the reply; anything being typed stays in the box. */
  async function answer(text: string) {
    if (sending || elsewhere) return;
    setSending(true);
    setNotice(null);
    stick.current = true;
    try {
      await sendMessage(getSupabase(), id, text, [], run);
      void refresh();
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if ((!text && photos.items.length === 0) || sending || photos.reading || elsewhere) return;
    setSending(true);
    setNotice(null);
    stick.current = true;
    try {
      await sendMessage(getSupabase(), id, text, photos.items, run);
      setDraft("");
      saveDraft(id, "");
      photos.clear();
      if (input.current) input.current.style.height = "auto";
      void refresh();
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // With a real keyboard Enter sends; on a phone Enter makes a new line and the button sends.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    event.preventDefault();
    void send();
  }

  function onDraft(value: string) {
    setDraft(value);
    saveDraft(id, value);
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }

  async function stop() {
    setNotice(null);
    try {
      await requestStop(getSupabase(), id);
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    try {
      await renameConversation(getSupabase(), id, title);
      setConversation((c) => (c ? { ...c, title } : c));
      setSheet(null);
    } catch (err) {
      setNotice(errorMessage(err));
      setSheet(null);
    }
  }

  async function remove() {
    try {
      await deleteConversation(getSupabase(), id);
      forgetChat(id);
      router.replace("/", { transitionTypes: ["pop"], scroll: false });
    } catch (err) {
      setNotice(errorMessage(err));
      setSheet(null);
    }
  }

  // `scroll={false}` leaves the scrolling to the task list, which goes back to where it was left.
  const back = (
    <Link href="/" className="round-button glass" aria-label="Back" transitionTypes={["pop"]} scroll={false}>
      <ChevronLeft size={24} />
    </Link>
  );

  if (missing) {
    return (
      <Screen>
        <TopBar title="Not found" left={back} />
        <main className="content content-bar">
          <div className="empty">
            <p className="empty-title">This chat no longer exists</p>
            <p>It may have been deleted.</p>
            <Link href="/" className="pill-button" transitionTypes={["pop"]} scroll={false}>
              Back to Tasks
            </Link>
          </div>
        </main>
      </Screen>
    );
  }

  const status = conversation?.status;
  const subtitle = conversation ? [owner?.name, folderLabel(conversation.cwd, owner?.folders)].filter(Boolean).join(", ") : "";

  const statusLine = stopping
    ? "Stopping…"
    : status === "running"
      ? "Claude is working"
      : status === "queued"
        ? activeOn
          ? "Starting…"
          : active
            ? `Waiting for ${active.name} to answer`
            : "Waiting for a laptop to be turned on"
        : asked && !elsewhere
          ? "Claude is waiting for your reply"
          : null;

  return (
    <Screen className="chat" ref={root}>
      <TopBar
        title={conversation?.title ?? " "}
        subtitle={subtitle}
        left={back}
        right={
          <button type="button" className="round-button glass" aria-label="More" disabled={!conversation} onClick={() => setSheet("menu")}>
            <More size={24} />
          </button>
        }
      />

      <div
        className="timeline"
        ref={scroller}
        onScroll={onScroll}
        // A picture Claude sent gets its height only once it loads; stay at the end when it does.
        onLoadCapture={() => {
          const el = scroller.current;
          if (el && stick.current) el.scrollTop = el.scrollHeight;
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0].clientY)}
        onTouchMove={(e) => onTouchMove(e.touches[0].clientY)}
      >
        <div className={loaded && !cached ? "timeline-inner is-arriving" : "timeline-inner"}>
          {hasEarlier ? (
            <button type="button" className="pill-button earlier" onClick={() => void loadEarlier()} disabled={loadingEarlier}>
              {loadingEarlier ? "Loading…" : "Show Earlier Messages"}
            </button>
          ) : null}

          {blocks.map((block) => (
            <TimelineBlock
              key={block.key}
              block={block}
              live={status === "running" && block.key === liveKey}
              queued={status === "running"}
              fresh={seenUpTo.current !== null && blockFirstId(block) > seenUpTo.current}
            />
          ))}
        </div>
      </div>

      <footer className="dock" ref={dock}>
        {!atBottom ? (
          <button type="button" className="round-button glass jump" onClick={jumpToLatest} aria-label="Jump to latest">
            <ArrowDown size={20} />
          </button>
        ) : null}

        {notice || photos.error ? (
          <div className="dock-row">
            <p className="dock-pill dock-pill-error glass" role="alert">
              {notice ?? photos.error}
            </p>
          </div>
        ) : loaded && statusLine ? (
          <div className="dock-row">
            <p className="dock-pill glass" role="status">
              {status === "running" && !stopping ? (
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
              {statusLine}
            </p>
          </div>
        ) : null}

        {answers.length > 0 && !busy && !elsewhere && loaded ? (
          <div className="answers" role="group" aria-label="Quick answers">
            {answers.map((text) => (
              <button key={text} type="button" className="answer glass" onClick={() => void answer(text)} disabled={sending}>
                {text}
              </button>
            ))}
          </div>
        ) : null}

        {elsewhere ? (
          <p className="composer composer-locked glass">
            This chat lives on {owner?.name ?? "another laptop"}. Run <code>remote on</code> there to continue it.
          </p>
        ) : (
          <div className="composer glass">
            <AttachButton onFiles={(files) => void photos.add(files)} disabled={photos.full || photos.reading || sending} />
            <div className="composer-main">
              <AttachmentPreviews items={photos.items} reading={photos.reading} onRemove={photos.remove} />
              <textarea
                ref={input}
                rows={1}
                placeholder={status === "running" ? "Add a follow-up" : "Message"}
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={onKeyDown}
                enterKeyHint="enter"
                aria-label="Message"
              />
            </div>
            {showStop ? (
              <button
                type="button"
                className={swap.done ? "action-button is-swapped" : "action-button"}
                onClick={() => void stop()}
                disabled={stopping}
                aria-label="Stop"
              >
                <Stop size={20} />
              </button>
            ) : (
              <button
                type="button"
                className={swap.done ? "action-button is-swapped" : "action-button"}
                onClick={() => void send()}
                disabled={!hasDraft || sending || photos.reading || !conversation}
                aria-label="Send"
              >
                <ArrowUp size={20} />
              </button>
            )}
          </div>
        )}
      </footer>

      <Presence>
        {sheet === "menu" ? (
          <Menu onClose={() => setSheet(null)}>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setNewTitle(conversation?.title ?? "");
                setSheet("rename");
              }}
            >
              Rename
              <Pencil size={20} />
            </button>
            {canChooseRun ? (
              <button type="button" role="menuitem" className="menu-item" onClick={() => setSheet("run")}>
                <span className="menu-stack">
                  Model and Effort
                  <small>{runLabel(run)}</small>
                </span>
                <Sliders size={20} />
              </button>
            ) : null}
            <button type="button" role="menuitem" className="menu-item menu-item-destructive" onClick={() => setSheet("delete")}>
              Delete Chat
              <Trash size={20} />
            </button>
          </Menu>
        ) : null}
      </Presence>

      <Presence>
        {sheet === "rename" ? (
          <Sheet title="Rename" onClose={() => setSheet(null)}>
            <form className="sheet-form" onSubmit={rename}>
              <div className="group">
                <input
                  type="text"
                  className="cell-input"
                  autoFocus
                  maxLength={120}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  aria-label="Title"
                />
              </div>
              <div className="sheet-buttons">
                <button type="submit" className="button button-tint" disabled={!newTitle.trim()}>
                  Save
                </button>
              </div>
            </form>
          </Sheet>
        ) : null}
      </Presence>

      <Presence>
        {sheet === "delete" ? (
          <Sheet title="Delete this chat?" onClose={() => setSheet(null)}>
            <p className="sheet-text">
              The chat and its history are removed from this app. Files Claude changed on the laptop stay as they are.
            </p>
            <div className="sheet-buttons">
              <button type="button" className="button button-destructive" onClick={() => void remove()}>
                Delete Chat
              </button>
              <button type="button" className="button" onClick={() => setSheet(null)}>
                Cancel
              </button>
            </div>
          </Sheet>
        ) : null}
      </Presence>

      <Presence>{sheet === "run" ? <RunSheet value={run} onChange={chooseRun} onClose={() => setSheet(null)} /> : null}</Presence>
    </Screen>
  );
}
