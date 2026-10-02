/* ============================================================================
   Query definitions: every server read the app makes, with its key.
   Components use these hooks rather than calling api() for reads, so a key
   is spelled once and lib/live.ts can refetch by it.
   ========================================================================== */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { MarketExtras, Note } from "@/domain/panes";
import type { Settings, VaultEntry } from "@/domain/settings";
import type { Agent, ApiToken, BoardDetail, BoardSummary, Inbox, Invite, Me, MyWork, Person, User, Wired } from "@/domain/types";
import { api } from "./api";
import { isLive } from "./liveState";

export const KEYS = {
  me: ["me"],
  settings: ["settings"],
  vault: ["vault"],
  boards: ["boards"],
  board: (id: string) => ["board", id],
  boardAll: ["board"],
  /* Under "board" on purpose: whatever changes a board can change whose work is whose. */
  myWork: ["board", "~mine"],
  /* The same, for the /wired pane: task moves, claims and run endings all arrive as "board". */
  wired: ["board", "~wired"],
  admin: ["admin"],
  adminUsers: ["admin", "users"],
  adminInvites: ["admin", "invites"],
  notes: ["notes"],
  tokens: ["tokens"],
  agents: ["agents"],
  inbox: ["inbox"],
  people: (q: string) => ["people", q],
  /* Keyed on what the Worker will read (the ids in settings, the saved key),
     so changing either refetches without a live topic of its own. */
  marketExtras: (ids: unknown[]) => ["markets", "coingecko", ...ids],
} as const;

/** While the socket is down, poll instead; while it is up, it tells us. */
const fallbackPoll = (ms: number) => () => (isLive() ? false : ms);

export const useMe = () =>
  useQuery({ queryKey: KEYS.me, queryFn: () => api<Me>("/me"), retry: false, staleTime: Infinity });

export const useSettings = (enabled = true) =>
  useQuery({ queryKey: KEYS.settings, queryFn: () => api<Settings>("/settings"), enabled, staleTime: Infinity });

export const useVault = () => useQuery({ queryKey: KEYS.vault, queryFn: () => api<VaultEntry[]>("/vault") });

export const useBoards = () =>
  useQuery({
    queryKey: KEYS.boards,
    queryFn: () => api<BoardSummary[]>("/boards"),
    refetchInterval: fallbackPoll(60_000),
  });

/** What is yours and what you handed to your agents: ids only; the tasks come from their boards. */
export const useMyWork = () =>
  useQuery({ queryKey: KEYS.myWork, queryFn: () => api<MyWork>("/tasks/mine"), refetchInterval: fallbackPoll(60_000) });

/**
 * Your agents' work by pole, for the /wired pane. Polled every minute even
 * while live, since a claim lapsing sends nothing.
 */
export const useWired = () =>
  useQuery({ queryKey: KEYS.wired, queryFn: () => api<Wired>("/wired"), refetchInterval: 60_000 });

/** One board's query, for useBoard and for the panes that read several boards at once. */
export const boardQuery = (id: string) => ({
  queryKey: KEYS.board(id),
  queryFn: () => api<BoardDetail>(`/boards/${id}`),
  refetchInterval: fallbackPoll(60_000),
});

export const useBoard = (id: string | null) => useQuery({ ...boardQuery(id ?? ""), enabled: id !== null });

export const useAdminUsers = () =>
  useQuery({
    queryKey: KEYS.adminUsers,
    queryFn: () => api<(User & { disabledAt: string | null })[]>("/admin/users"),
  });

export const useAdminInvites = () =>
  useQuery({ queryKey: KEYS.adminInvites, queryFn: () => api<Invite[]>("/admin/invites") });

/** The inbox, a page at a time (newest first); fetchNextPage follows `next`. */
export const useInbox = () =>
  useInfiniteQuery({
    queryKey: KEYS.inbox,
    queryFn: ({ pageParam }) => api<Inbox>(pageParam ? `/inbox?cursor=${encodeURIComponent(pageParam)}` : "/inbox"),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    /* The pages as one list; the count is the whole inbox's, on every page. */
    select: (data) => ({ unread: data.pages[0]?.unread ?? 0, items: data.pages.flatMap((p) => p.items) }),
    refetchInterval: fallbackPoll(60_000),
  });

export const useTokens = () => useQuery({ queryKey: KEYS.tokens, queryFn: () => api<ApiToken[]>("/tokens") });

export const useAgents = (enabled = true) =>
  useQuery({ queryKey: KEYS.agents, queryFn: () => api<Agent[]>("/agents"), enabled });

/** The share picker's search: people on the instance by handle, never their emails. */
export const usePeople = (q: string, enabled = true) =>
  useQuery({
    queryKey: KEYS.people(q),
    queryFn: () => api<Person[]>(`/people?q=${encodeURIComponent(q)}`),
    enabled,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });

export const useNotes = () =>
  useQuery({ queryKey: KEYS.notes, queryFn: () => api<Note[]>("/notes"), refetchInterval: fallbackPoll(60_000) });

/* CoinGecko's demo plan is rate limited and the Worker caches for
   fifteen minutes, so asking more often would only get the same answer. */
const MARKET_EXTRAS_MS = 15 * 60_000;

export const useMarketExtras = (ids: unknown[], enabled: boolean) =>
  useQuery({
    queryKey: KEYS.marketExtras(ids),
    queryFn: () => api<MarketExtras>("/markets/coingecko"),
    enabled,
    staleTime: MARKET_EXTRAS_MS,
    refetchInterval: MARKET_EXTRAS_MS,
  });
