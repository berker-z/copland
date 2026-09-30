/* ============================================================================
   Query definitions: every server read the app makes, with its key.
   Components use these hooks rather than calling api() for reads, so a key
   is spelled once and lib/live.ts can refetch by it.
   ========================================================================== */

import { useQuery } from "@tanstack/react-query";
import type { Settings, VaultEntry } from "@/domain/settings";
import type { BoardDetail, BoardSummary, Invite, Me, User } from "@/domain/types";
import { api } from "./api";
import { isLive } from "./liveState";

export const KEYS = {
  me: ["me"],
  settings: ["settings"],
  vault: ["vault"],
  boards: ["boards"],
  board: (id: string) => ["board", id],
  boardAll: ["board"],
  admin: ["admin"],
  adminUsers: ["admin", "users"],
  adminInvites: ["admin", "invites"],
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

export const useBoard = (id: string | null) =>
  useQuery({
    queryKey: KEYS.board(id ?? ""),
    queryFn: () => api<BoardDetail>(`/boards/${id}`),
    enabled: id !== null,
    refetchInterval: fallbackPoll(60_000),
  });

export const useAdminUsers = () =>
  useQuery({
    queryKey: KEYS.adminUsers,
    queryFn: () => api<(User & { disabledAt: string | null })[]>("/admin/users"),
  });

export const useAdminInvites = () =>
  useQuery({ queryKey: KEYS.adminInvites, queryFn: () => api<Invite[]>("/admin/invites") });
