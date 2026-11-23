"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { cachedTasks, cachedTasksScroll, cacheTasks, cacheTasksScroll } from "@/lib/cache";
import { elapsed, relativeTime } from "@/lib/format";
import type { Conversation } from "@/lib/types";
import { useDevices, useOnWake } from "@/components/Providers";
import { LaptopCard } from "@/components/LaptopCard";
import { PushNudge } from "@/components/PushNudge";
import { Screen, TabBar, TopBar } from "@/components/Chrome";
import { CheckCircle, ChevronRight, Clock, ExclamationFill } from "@/components/Icons";

function byNewest(a: Conversation, b: Conversation) {
  return b.updated_at.localeCompare(a.updated_at);
}

/**
 * Back from a chat or from New Task, the list is where it was left.
 * Rendered before the top bar, so the bar already knows the page is scrolled when it first draws.
 */
function RestoreScroll() {
  useLayoutEffect(() => {
    const y = cachedTasksScroll();
    cacheTasksScroll(0);
    if (y > 0) window.scrollTo(0, y);
  }, []);
  return null;
}

const isActive = (c: Conversation) => c.status !== "idle";
const isBusy = (c: Conversation) => c.status === "running" || c.status === "queued";

export default function HomePage() {
  const { now } = useDevices();
  // Starts from what the list showed last time, so coming back from a chat doesn't flash a loading state.
  const [items, setItems] = useState<Conversation[] | null>(cachedTasks);
  // Only a list that had to be fetched fades in; one drawn from memory is simply there.
  const [arriving] = useState(() => cachedTasks() === null);
  const [failed, setFailed] = useState(false);
  // When each busy task's current message was sent, for "running for 4m".
  const [startedAt, setStartedAt] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error } = await getSupabase()
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error || !data) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setItems(data as Conversation[]);
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    const channel = sb
      .channel("conversations")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const gone = (payload.old as { id?: string }).id;
          setItems((list) => list?.filter((c) => c.id !== gone) ?? list);
          return;
        }
        const row = payload.new as Conversation;
        setItems((list) => {
          if (!list) return list;
          const rest = list.filter((c) => c.id !== row.id);
          return [row, ...rest].sort(byNewest);
        });
      })
      .subscribe((status) => {
        // Runs again on every reconnect, so changes missed while offline are picked up.
        if (status === "SUBSCRIBED") void load();
      });
    // Load straight away too: the list must not depend on the live connection coming up.
    void load();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [load]);

  useOnWake(load);

  useEffect(() => {
    cacheTasks(items);
  }, [items]);

  const busyIds = useMemo(() => (items ?? []).filter(isBusy).map((c) => c.id).sort().join(","), [items]);

  useEffect(() => {
    if (!busyIds) return;
    let cancelled = false;
    void getSupabase()
      .from("events")
      .select("conversation_id, state, created_at")
      .eq("kind", "user")
      .in("state", ["pending", "running"])
      .in("conversation_id", busyIds.split(","))
      .order("id", { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        const map: Record<string, string> = {};
        const rows = data as { conversation_id: string; state: string; created_at: string }[];
        // The message being worked on wins; otherwise the oldest one still waiting.
        for (const row of rows) if (row.state === "running") map[row.conversation_id] = row.created_at;
        for (const row of rows) if (!map[row.conversation_id]) map[row.conversation_id] = row.created_at;
        setStartedAt(map);
      });
    return () => {
      cancelled = true;
    };
  }, [busyIds]);

  const active = useMemo(() => (items ?? []).filter(isActive), [items]);
  const earlier = useMemo(() => (items ?? []).filter((c) => !isActive(c)), [items]);
  const runningCount = active.filter((c) => c.status === "running").length;
  const waitingCount = active.filter((c) => c.status === "queued").length;

  function glyph(c: Conversation) {
    if (c.status === "running") return <i className="spinner" aria-hidden="true" />;
    if (c.status === "queued") return <Clock size={22} className="glyph-orange" />;
    if (c.status === "error") return <ExclamationFill size={22} className="glyph-red" />;
    return <CheckCircle size={22} className="glyph-quiet" />;
  }

  function row(c: Conversation) {
    const since = isBusy(c) ? startedAt[c.id] : undefined;
    const state =
      c.status === "running" ? "Running" : c.status === "queued" ? "Waiting to start" : c.status === "error" ? "Needs attention" : "Finished";
    return (
      <li key={c.id}>
        <Link
          href={`/c/${c.id}`}
          className="cell cell-link task"
          transitionTypes={["push"]}
          onClick={() => cacheTasksScroll(window.scrollY)}
        >
          <span className="task-glyph" role="img" aria-label={state}>
            {glyph(c)}
          </span>
          <div className="cell-body">
            <div className="task-text">
              <span className="task-title">{c.title}</span>
              {c.status === "running" ? (
                <span className="task-sub task-step">{c.last_text || "Starting…"}</span>
              ) : c.status === "queued" ? (
                <span className="task-sub">Waiting to start</span>
              ) : c.last_text ? (
                <span className="task-sub">{c.last_text}</span>
              ) : null}
            </div>
            <time className="cell-detail">{since ? elapsed(since, now) : relativeTime(c.updated_at, now)}</time>
            <ChevronRight size={14} className="cell-chevron" />
          </div>
        </Link>
      </li>
    );
  }

  return (
    <Screen>
      <RestoreScroll />
      <TopBar title="Tasks" large />

      <main className="content content-tabbed">
        <h1 className="large-title">Tasks</h1>

        <LaptopCard running={runningCount} waiting={waitingCount} />
        <PushNudge />

        {items === null ? (
          failed ? (
            <div className="empty">
              <p className="empty-title">Couldn&apos;t load your tasks</p>
              <button type="button" className="pill-button" onClick={() => void load()}>
                Try Again
              </button>
            </div>
          ) : (
            <ul className="group list-loading" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} />
              ))}
            </ul>
          )
        ) : items.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No tasks yet</p>
            <p>Start one and Claude runs it on your laptop. You can close this app while it works.</p>
          </div>
        ) : (
          <div className={arriving ? "is-arriving" : undefined}>
            {active.length > 0 ? (
              <section>
                <h2 className="group-header">Active</h2>
                <ul className="group">{active.map(row)}</ul>
              </section>
            ) : null}
            {earlier.length > 0 ? (
              <section>
                {active.length > 0 ? <h2 className="group-header">Earlier</h2> : null}
                <ul className="group">{earlier.map(row)}</ul>
              </section>
            ) : null}
          </div>
        )}
      </main>

      <TabBar current="tasks" />
    </Screen>
  );
}
