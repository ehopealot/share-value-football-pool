import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { ReadMessageBoardResponse } from "../../contracts/http";
import { api, errorMessage, invalidatePoolView } from "../api";
import { useFrozenAdminCommand } from "../admin-command";
import { Layout } from "../components/Layout";

type Thread = ReadMessageBoardResponse["threads"][number];
type BoardMutation = { text: string; idempotencyKey: string; announcement: boolean };
type ReplyMutation = Omit<BoardMutation, "announcement">;

/** Board reads change the caller's durable HWM, so refresh the nav only after they succeed. */
export async function readMessageBoardAndInvalidate(slug: string) {
  const board = await api.readMessageBoard(slug);
  invalidatePoolView();
  return board;
}

export async function createMessageBoardPostAndInvalidate(slug: string, body: BoardMutation) {
  const result = await api.createMessageBoardPost(slug, body);
  invalidatePoolView();
  return result;
}

export async function replyToMessageBoardPostAndInvalidate(slug: string, postId: string, body: ReplyMutation) {
  const result = await api.replyToMessageBoardPost(slug, postId, body);
  invalidatePoolView();
  return result;
}

/** Keeps late board reads from overwriting a newer refresh after a post or reply. */
class MessageBoardLoadGeneration {
  private generation = 0;
  start() { return ++this.generation; }
  invalidate() { ++this.generation; }
  current(generation: number) { return generation === this.generation; }
}

export const formatBoardTime = (value: string) => new Date(value).toLocaleString();
/** Browser fragment resolution happens before async threads mount, so replay it once the target exists. */
export const scrollMessageBoardFragment = (hash: string, findTarget: (id: string) => Pick<HTMLElement, "scrollIntoView"> | null = (id) => document.getElementById(id)) => {
  if (!hash.startsWith("#")) return;
  try { findTarget(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" }); }
  catch { /* malformed fragments never affect board rendering */ }
};
export const shouldScrollMessageBoardFragment = (handled: string | undefined, slug: string, hash: string) => Boolean(hash) && handled !== `${slug}:${hash}`;

export function MessageBoardThreads({ threads, openReplyPostId, replyText, replyPending, onToggleReply, onReplyTextChange, onReplySubmit }: {
  threads: Thread[];
  openReplyPostId?: string;
  replyText: string;
  replyPending: boolean;
  onToggleReply: (postId: string) => void;
  onReplyTextChange: (text: string) => void;
  onReplySubmit: (event: FormEvent<HTMLFormElement>, postId: string) => void;
}) {
  if (!threads.length) return <p className="state-notice">No messages yet. Start the conversation.</p>;
  return <section className="message-board-threads" aria-label="Message board threads">{threads.map((thread, index) => <article id={`post-${thread.postId}`} key={thread.postId} className={`message-board-thread${index % 2 ? " message-board-thread-alt" : ""}`}>
    <header><p><strong>{thread.authorDisplayName}</strong>{thread.isAnnouncement && <span className="message-board-announcement-icon" role="img" aria-label="Commissioner announcement" title="Commissioner announcement"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-5 8a1 1 0 0 1 2 0 3 3 0 0 0 6 0 1 1 0 1 2 0 5 5 0 0 1-4 4.9V19h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-3.1A5 5 0 0 1 7 11Z"/></svg></span>} <time dateTime={thread.createdAt}>{formatBoardTime(thread.createdAt)}</time></p></header>
    <p className="message-board-text">{thread.text}</p>
    <button type="button" className="message-board-reply-toggle" aria-label={`Reply to ${thread.authorDisplayName}`} aria-expanded={openReplyPostId === thread.postId} aria-controls={`message-board-reply-form-${thread.postId}`} disabled={replyPending} onClick={() => onToggleReply(thread.postId)}>Reply</button>
    {openReplyPostId === thread.postId && <form id={`message-board-reply-form-${thread.postId}`} className="message-board-reply-form" onSubmit={(event) => onReplySubmit(event, thread.postId)}>
      <label htmlFor={`message-board-reply-${thread.postId}`}>Reply to {thread.authorDisplayName}</label>
      <textarea id={`message-board-reply-${thread.postId}`} value={replyText} onChange={(event) => onReplyTextChange(event.target.value)} maxLength={1000} required disabled={replyPending} />
      <button type="submit" disabled={!replyText.trim() || replyPending}>Post reply</button>
    </form>}
    {thread.replies.length > 0 && <section className="message-board-replies" aria-label={`Replies to ${thread.authorDisplayName}`}>{thread.replies.map((reply) => <article key={reply.replyId} className="message-board-reply">
      <header><p><strong>{reply.authorDisplayName}</strong> <time dateTime={reply.createdAt}>{formatBoardTime(reply.createdAt)}</time></p></header>
      <p className="message-board-text">{reply.text}</p>
    </article>)}</section>}
  </article>)}</section>;
}

export function MessageBoardPage() {
  const { slug = "" } = useParams(); const location = useLocation();
  const [board, setBoard] = useState<ReadMessageBoardResponse>();
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState("");
  const [postText, setPostText] = useState(""); const [postAnnouncement, setPostAnnouncement] = useState(false); const [postError, setPostError] = useState("");
  const [openReplyPostId, setOpenReplyPostId] = useState<string>(); const [replyText, setReplyText] = useState(""); const [replyError, setReplyError] = useState("");
  const post = useFrozenAdminCommand<BoardMutation>(); const reply = useFrozenAdminCommand<ReplyMutation>();
  const loads = useState(() => new MessageBoardLoadGeneration())[0]; const errorRef = useRef<HTMLParagraphElement>(null); const handledFragment = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    const generation = loads.start();
    setLoadError("");
    try {
      const next = await readMessageBoardAndInvalidate(slug);
      if (!loads.current(generation)) return;
      setBoard(next); setLoading(false);
    } catch (error) {
      if (!loads.current(generation)) return;
      setLoadError(errorMessage(error)); setLoading(false);
    }
  }, [slug, loads]);
  useEffect(() => { setLoading(true); setBoard(undefined); void load(); return () => loads.invalidate(); }, [load, loads]);
  useEffect(() => { if (loadError || postError || replyError) errorRef.current?.focus(); }, [loadError, postError, replyError]);
  useEffect(() => {
    if (!board || !shouldScrollMessageBoardFragment(handledFragment.current, slug, location.hash)) return;
    scrollMessageBoardFragment(location.hash);
    handledFragment.current = `${slug}:${location.hash}`;
  }, [board, location.hash, slug]);

  const submitPost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!postText.trim()) return setPostError("Write a message before posting.");
    setPostError("");
    try {
      const result = await post.run(`message-board-post:${slug}`, () => ({ text: postText, announcement: postAnnouncement, idempotencyKey: crypto.randomUUID() }), (body) => createMessageBoardPostAndInvalidate(slug, body));
      if (!result) return;
      setPostText(""); setPostAnnouncement(false);
      void load();
    } catch (error) { setPostError(errorMessage(error)); }
  };
  const submitReply = async (event: FormEvent<HTMLFormElement>, postId: string) => {
    event.preventDefault();
    if (!replyText.trim()) return setReplyError("Write a reply before posting.");
    setReplyError("");
    try {
      const result = await reply.run(`message-board-reply:${slug}:${postId}`, () => ({ text: replyText, idempotencyKey: crypto.randomUUID() }), (body) => replyToMessageBoardPostAndInvalidate(slug, postId, body));
      if (!result) return;
      setReplyText(""); setOpenReplyPostId(undefined);
      void load();
    } catch (error) { setReplyError(errorMessage(error)); }
  };

  if (loading) return <Layout signedIn><div className="message-board-page"><h1>Message board</h1><p role="status">Loading messages…</p><p><Link to={`/p/${slug}/overview`}>Pool home</Link></p></div></Layout>;
  if (loadError || !board) return <Layout signedIn><div className="message-board-page"><h1>Message board</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{loadError || "Message board unavailable."} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></div></Layout>;
  return <Layout signedIn><div className="message-board-page"><h1>Message board</h1>
    <form className="message-board-post-form" onSubmit={submitPost}><label htmlFor="message-board-post">New post</label><textarea id="message-board-post" value={postText} onChange={(event) => { post.retire(); setPostError(""); setPostText(event.target.value); }} maxLength={1000} required disabled={post.pending} />{board.canAnnounce && <label className="message-board-announcement-option"><input type="checkbox" checked={postAnnouncement} disabled={post.pending} onChange={(event) => { post.retire(); setPostError(""); setPostAnnouncement(event.target.checked); }} /> Send as a commissioner announcement and email active members (except you).</label>}<button type="submit" disabled={!postText.trim() || post.pending}>{postAnnouncement ? "Post announcement and email league" : "Post"}</button></form>
    {postError && <p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{postError}</p>}
    {replyError && <p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{replyError}</p>}
    <MessageBoardThreads threads={board.threads} openReplyPostId={openReplyPostId} replyText={replyText} replyPending={reply.pending} onToggleReply={(postId) => { setReplyError(""); setOpenReplyPostId((current) => current === postId ? undefined : postId); }} onReplyTextChange={(text) => { reply.retire(); setReplyError(""); setReplyText(text); }} onReplySubmit={submitReply}/>
    <p><Link to={`/p/${slug}/overview`}>Pool home</Link></p>
  </div></Layout>;
}
