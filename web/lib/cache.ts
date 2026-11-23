// What each screen last showed, kept in memory while the app is open. Coming back to a screen
// draws this straight away and refreshes it underneath, instead of showing a loading state again.

import type { Conversation, EventRow } from "./types";

export type CachedChat = { conversation: Conversation | null; events: EventRow[]; hasEarlier: boolean };

const MAX_CHATS = 8;

let tasks: Conversation[] | null = null;
let tasksScroll = 0;
const chats = new Map<string, CachedChat>();

export const cachedTasks = () => tasks;
export function cacheTasks(list: Conversation[] | null): void {
  tasks = list;
}

/** How far down the task list was scrolled when it was left for a chat. */
export const cachedTasksScroll = () => tasksScroll;
export function cacheTasksScroll(y: number): void {
  tasksScroll = y;
}

export const cachedChat = (id: string) => chats.get(id) ?? null;
export function cacheChat(id: string, chat: CachedChat): void {
  chats.delete(id); // re-inserting keeps the most recently opened chats
  chats.set(id, chat);
  while (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value as string);
}

export function forgetChat(id: string): void {
  chats.delete(id);
}

/** On sign-out, so nothing of one session is shown in the next. */
export function clearCache(): void {
  tasks = null;
  tasksScroll = 0;
  chats.clear();
}
