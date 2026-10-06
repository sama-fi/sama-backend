import { randomBytes } from "node:crypto";
import type { AssistantAction, AssistantBlock, AssistantResponse, ChatDetail, ChatMessage, ChatSummary } from "@sama/api-types";
import type { Address } from "viem";
import { assist } from "./assistant.ts";
import { db } from "./db/client.ts";
import { InputError, NotFoundError } from "./errors.ts";
import { ensureUser, key } from "./users.ts";

const LIST_LIMIT = 50;
/** Older turns add cost without helping; the model sees this many of the latest ones. */
const CONTEXT_TURNS = 12;
const MAX_MESSAGES_PER_CHAT = 200;

type MessageRow = { role: string; content: string; blocks: unknown; actions: unknown; is_error: boolean; created_at: Date | string };

const iso = (d: Date | string) => new Date(d).toISOString();
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

function toMessage(r: MessageRow): ChatMessage {
  return {
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    ...(Array.isArray(r.blocks) && r.blocks.length ? { blocks: r.blocks as AssistantBlock[] } : {}),
    ...(Array.isArray(r.actions) && r.actions.length ? { actions: r.actions as AssistantAction[] } : {}),
    ...(r.is_error ? { error: true } : {}),
    createdAt: iso(r.created_at),
  };
}

export async function listChats(address: Address): Promise<ChatSummary[]> {
  const rows = await (await db()).query<{ id: string; title: string; updated_at: Date | string }>(
    "select id, title, updated_at from assistant_chats where address = $1 order by updated_at desc limit $2",
    [key(address), LIST_LIMIT],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: iso(r.updated_at) }));
}

export async function getChat(address: Address, id: string): Promise<ChatDetail> {
  const d = await db();
  const [chat] = await d.query<{ id: string; title: string }>("select id, title from assistant_chats where id = $1 and address = $2", [id, key(address)]);
  if (!chat) throw new NotFoundError("That conversation does not exist.");
  const rows = await d.query<MessageRow>("select role, content, blocks, actions, is_error, created_at from assistant_messages where chat_id = $1 order by id", [id]);
  return { id: chat.id, title: chat.title, messages: rows.map(toMessage) };
}

export async function deleteChat(address: Address, id: string): Promise<void> {
  // Messages go with it (on delete cascade). Scoped to the owner, so another wallet's id deletes nothing.
  await (await db()).query("delete from assistant_chats where id = $1 and address = $2", [id, key(address)]);
}

export async function deleteAllChats(address: Address): Promise<void> {
  await (await db()).query("delete from assistant_chats where address = $1", [key(address)]);
}

const titleOf = (message: string) => {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};

/**
 * One chat turn, saved. The agent answers first; only then are the user's message and the reply stored, so a failed
 * answer leaves no half-written conversation. A missing `chatId` starts a new conversation titled from the message.
 */
export async function chatAssist(address: Address, chatId: string | undefined, message: string): Promise<AssistantResponse> {
  const text = message.trim();
  if (!text) throw new InputError("Type a question or a request first.");
  const d = await db();
  let title = titleOf(text);
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (chatId) {
    const chat = await getChat(address, chatId);
    if (chat.messages.length >= MAX_MESSAGES_PER_CHAT) throw new InputError("This conversation is full. Start a new chat.");
    title = chat.title;
    history = chat.messages.filter((m) => !m.error).slice(-CONTEXT_TURNS).map((m) => ({ role: m.role, content: m.content }));
  }
  const reply = await assist(address, [...history, { role: "user", content: text }]);

  await ensureUser(address);
  const id = chatId ?? randomBytes(12).toString("base64url");
  await d.tx(async (t) => {
    if (!chatId) await t.query("insert into assistant_chats (id, address, title) values ($1, $2, $3)", [id, key(address), title]);
    await t.query("insert into assistant_messages (chat_id, role, content) values ($1, 'user', $2)", [id, text]);
    await t.query("insert into assistant_messages (chat_id, role, content, blocks, actions) values ($1, 'assistant', $2, $3::jsonb, $4::jsonb)", [id, reply.text, json(reply.blocks), json(reply.actions)]);
    await t.query("update assistant_chats set updated_at = now() where id = $1", [id]);
  });
  return { chatId: id, title, reply };
}
