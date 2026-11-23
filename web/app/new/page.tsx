"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { errorMessage, startConversation } from "@/lib/actions";
import { runLabel } from "@/lib/models";
import { loadDraft, loadRun, recentFolders, rememberFolder, saveDraft, saveRun } from "@/lib/store";
import type { RunChoice } from "@/lib/types";
import { AttachButton, AttachmentPreviews, useAttachments } from "@/components/Attachments";
import { useDevices } from "@/components/Providers";
import { Screen, TopBar } from "@/components/Chrome";
import { Check, ChevronRight } from "@/components/Icons";
import { RunSheet } from "@/components/RunOptions";
import { Presence, Sheet } from "@/components/Sheet";

const DRAFT = "new";

export default function NewTaskPage() {
  const router = useRouter();
  const { active, activeOn, health } = useDevices();
  // null until the user picks; then the last used folder is the starting choice.
  const [picked, setPicked] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // Starts from what the last new task used.
  const [run, setRun] = useState<RunChoice>({ model: "", effort: "" });
  const [choosingRun, setChoosingRun] = useState(false);
  // Offered only when the laptop's helper is new enough to act on it.
  const canChooseRun = Boolean(active && (health[active.id]?.version ?? 0) >= 2);
  const photos = useAttachments();

  useEffect(() => {
    setRecent(recentFolders());
    setText(loadDraft(DRAFT));
    setRun(loadRun(DRAFT));
  }, []);

  const folders = active?.folders ?? [];
  const known = (path: string) => path === "" || folders.some((f) => f.path === path);
  // A folder remembered from another laptop may not exist on this one; those are skipped.
  const recentHere = recent.filter(known).slice(0, 3);
  const wanted = picked ?? recentHere[0] ?? "";
  const chosen = known(wanted) ? wanted : "";
  const label = (path: string) => (path === "" ? "Home folder" : (folders.find((f) => f.path === path)?.label ?? path));
  const message = text.trim();
  const ready = (message.length > 0 || photos.items.length > 0) && !photos.reading;

  function onText(value: string) {
    setText(value);
    saveDraft(DRAFT, value);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const choice = canChooseRun ? run : { model: "", effort: "" };
      const conversation = await startConversation(getSupabase(), message, chosen || null, photos.items, choice);
      // The chat keeps the choice for its follow-ups, and the next new task starts from it.
      saveRun(conversation.id, choice);
      saveRun(DRAFT, choice);
      rememberFolder(chosen);
      saveDraft(DRAFT, "");
      router.replace(`/c/${conversation.id}`, { transitionTypes: ["push"] });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function choose(path: string) {
    setPicked(path);
    setPicking(false);
  }

  return (
    <Screen>
      <TopBar
        title="New Task"
        left={
          <Link href="/" className="bar-button glass" transitionTypes={["dismiss"]} scroll={false}>
            Cancel
          </Link>
        }
        right={
          <button type="submit" form="new-task" className="bar-button glass glass-tint" disabled={!ready || busy}>
            {busy ? "Starting…" : "Start"}
          </button>
        }
      />

      <main className="content content-bar">
        <form id="new-task" onSubmit={submit}>
          <div className="group">
            <button type="button" className="cell cell-link" onClick={() => setPicking(true)} disabled={folders.length === 0}>
              <div className="cell-body">
                <span className="cell-title">Folder</span>
                <span className="cell-detail">{label(chosen)}</span>
                <ChevronRight size={14} className="cell-chevron" />
              </div>
            </button>
            {canChooseRun ? (
              <button type="button" className="cell cell-link" onClick={() => setChoosingRun(true)}>
                <div className="cell-body">
                  <span className="cell-title">Model and Effort</span>
                  <span className="cell-detail">{runLabel(run)}</span>
                  <ChevronRight size={14} className="cell-chevron" />
                </div>
              </button>
            ) : null}
          </div>
          {recentHere.length > 1 ? (
            <div className="chips" role="group" aria-label="Recent folders">
              {recentHere.map((path) => (
                <button
                  key={path || "home"}
                  type="button"
                  className={path === chosen ? "chip is-on" : "chip"}
                  aria-pressed={path === chosen}
                  onClick={() => setPicked(path)}
                >
                  {label(path)}
                </button>
              ))}
            </div>
          ) : null}

          <div className="group task-group">
            <textarea
              id="new-text"
              className="cell-input task-input"
              rows={6}
              autoFocus
              placeholder="What should Claude do?"
              aria-label="What should Claude do?"
              value={text}
              onChange={(e) => onText(e.target.value)}
              enterKeyHint="enter"
            />
            <AttachmentPreviews items={photos.items} reading={photos.reading} onRemove={photos.remove} />
            <AttachButton
              className="cell cell-link attach-row"
              label={photos.items.length > 0 ? "Add Another Photo" : "Add Photo"}
              onFiles={(files) => void photos.add(files)}
              disabled={photos.full || photos.reading || busy}
            />
          </div>

          {photos.error ? (
            <p className="group-footer form-error" role="alert">
              {photos.error}
            </p>
          ) : null}

          {!active ? (
            <p className="group-footer">
              No laptop is on. The task waits until you run <code>remote on</code> on one, and starts in that
              laptop&apos;s home folder.
            </p>
          ) : !activeOn ? (
            <p className="group-footer">{active.name} isn&apos;t answering right now. The task starts when it is back.</p>
          ) : (
            <p className="group-footer">Runs on {active.name}.</p>
          )}

          {error ? (
            <p className="group-footer form-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </main>

      <Presence>
        {picking ? (
          <Sheet title="Folder" onClose={() => setPicking(false)}>
            <ul className="group picker">
              {[{ path: "", label: "Home folder" }, ...folders].map((f) => (
                <li key={f.path || "home"}>
                  <button type="button" className="cell cell-link" onClick={() => choose(f.path)} aria-pressed={f.path === chosen}>
                    <div className="cell-body">
                      <span className="cell-title">{f.label}</span>
                      {f.path === chosen ? <Check size={18} className="cell-check" /> : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>
        ) : null}
      </Presence>
      <Presence>
        {choosingRun ? <RunSheet value={run} onChange={setRun} onClose={() => setChoosingRun(false)} /> : null}
      </Presence>
    </Screen>
  );
}
