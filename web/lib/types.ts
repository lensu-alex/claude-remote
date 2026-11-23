// Row shapes from supabase/schema.sql. Keep in step with that file.

export type Folder = { path: string; label: string };

export type Device = {
  id: string;
  name: string;
  platform: string | null;
  home: string | null;
  folders: Folder[];
  active: boolean;
  running: number;
  last_seen: string | null;
  created_at: string;
};

export type ConversationStatus = "idle" | "queued" | "running" | "error";

export type Conversation = {
  id: string;
  title: string;
  cwd: string | null;
  device_id: string | null;
  claude_session_id: string | null;
  status: ConversationStatus;
  stop_requested: boolean;
  last_text: string | null;
  created_at: string;
  updated_at: string;
};

export type EventKind = "user" | "text" | "tool" | "tool_result" | "result" | "error" | "notice";
export type EventState = "pending" | "running" | "done" | "cancelled";

export type EventRow = {
  id: number;
  conversation_id: string;
  kind: EventKind;
  state: EventState | null;
  body: Record<string, unknown>;
  created_at: string;
};

// A picture or file Claude sent to the chat. `url` is a signed address; `preview` is a smaller picture when there is one.
export type SentFile = { name: string; type: string; size: number; url: string; image: boolean; preview?: string };

// The model and effort chosen for a message. An empty string leaves it to the laptop's own setting.
export type RunChoice = { model: string; effort: string };

// A photo attached to a message. `data` is only present until the laptop has saved the file.
export type Attachment = { name: string; type: string; data?: string; thumb?: string; saved?: boolean };

// Rows the helper keeps in app_settings (docs/CONTRACT.md, "Laptop health and plan usage").
export type Health = {
  battery: number | null;
  plugged: boolean;
  charging: boolean;
  updated_at: string | null;
  /** What the laptop's helper can do; 0 for one that predates the features below (docs/CONTRACT.md). */
  version: number;
  /** True while the helper is keeping the laptop from sleeping. */
  awake: boolean;
  /** The owner's stay-awake switch, as the helper last read it. */
  awakeWanted: boolean;
  /** True when the battery is so low that the laptop is let sleep despite the switch. */
  awakeLow: boolean;
};
export type UsageWindow = { used: number; resets_at: string | null };
export type Usage = { five_hour: UsageWindow | null; seven_day: UsageWindow | null; limited: boolean; updated_at: string | null };
