import type { SupabaseClient } from "@supabase/supabase-js";
import type { Attachment, Conversation, RunChoice } from "./types";
import { titleFrom } from "./format";

// Everything the website is allowed to write, per docs/CONTRACT.md.

export async function sendMessage(
  sb: SupabaseClient,
  conversationId: string,
  text: string,
  images: Attachment[] = [],
  run: RunChoice = { model: "", effort: "" },
) {
  const body: Record<string, unknown> = { text };
  if (images.length > 0) body.images = images;
  // Left out when the laptop's own setting should apply.
  if (run.model) body.model = run.model;
  if (run.effort) body.effort = run.effort;
  const { error } = await sb
    .from("events")
    .insert({ conversation_id: conversationId, kind: "user", state: "pending", body });
  if (error) throw error;
  // A task that is already running stays "running"; the new message waits its turn.
  await sb.from("conversations").update({ status: "queued" }).eq("id", conversationId).neq("status", "running");
}

export async function startConversation(
  sb: SupabaseClient,
  text: string,
  cwd: string | null,
  images: Attachment[] = [],
  run: RunChoice = { model: "", effort: "" },
) {
  const title = text ? titleFrom(text) : images.length === 1 ? "Photo" : "Photos";
  const { data, error } = await sb
    .from("conversations")
    .insert({ title, cwd })
    .select()
    .single();
  if (error) throw error;
  const conversation = data as Conversation;
  try {
    await sendMessage(sb, conversation.id, text, images, run);
  } catch (err) {
    await sb.from("conversations").delete().eq("id", conversation.id);
    throw err;
  }
  return conversation;
}

export async function requestStop(sb: SupabaseClient, conversationId: string) {
  const { error } = await sb.from("conversations").update({ stop_requested: true }).eq("id", conversationId);
  if (error) throw error;
}

/** Stops every task that is running or waiting to run. */
export async function stopAll(sb: SupabaseClient) {
  const { error } = await sb.from("conversations").update({ stop_requested: true }).in("status", ["running", "queued"]);
  if (error) throw error;
}

export async function renameConversation(sb: SupabaseClient, conversationId: string, title: string) {
  const { error } = await sb.from("conversations").update({ title }).eq("id", conversationId);
  if (error) throw error;
}

export async function deleteConversation(sb: SupabaseClient, conversationId: string) {
  const { error } = await sb.from("conversations").delete().eq("id", conversationId);
  if (error) throw error;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  return "Something went wrong. Check your connection and try again.";
}

/**
 * The stay-awake switch for one laptop. It is kept in the account's own preferences, the one
 * place the website may write that is not a chat; the laptop's helper reads it from there.
 */
export async function setKeepAwake(sb: SupabaseClient, deviceId: string, on: boolean) {
  const { data, error: readError } = await sb.auth.getUser();
  if (readError) throw readError;
  const current = data.user?.user_metadata?.keep_awake;
  const all = typeof current === "object" && current !== null ? (current as Record<string, boolean>) : {};
  const { error } = await sb.auth.updateUser({ data: { keep_awake: { ...all, [deviceId]: on } } });
  if (error) throw error;
}
