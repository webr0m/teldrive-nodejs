import { create } from "zustand";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { normalizeApiError } from "@/api/errors";
import { currentUserQueryOptions } from "@/auth/queries";
import { getQueryClient } from "./queryClient";
import { isDemoActive } from "./client-demo";

type StorageSetup = { requiresChannel: boolean; configured: boolean };
type SetupRequest = { userId: number; parentId?: string; reason: "welcome" | "upload" };
export const useStorageSetupNotice = create<{
  request?: SetupRequest;
  show: (request: SetupRequest) => void;
  dismiss: () => void;
}>((set) => ({
  show: (request) => set({ request }),
  dismiss: () => set({ request: undefined }),
}));
export function storageSetupQuery(userId: number, parentId?: string) {
  return queryOptions({
    queryKey: ["storage-setup", userId, parentId ?? ""],
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<StorageSetup> => {
      if (isDemoActive()) return { requiresChannel: false, configured: true };
      const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
      let data: StorageSetup;
      try {
        data = await (await apiFetch(`/v1/me/storage${query}`)).json();
      } catch (error) {
        // Compatibility gateways can still expose the original channel API.
        if (![404, 501].includes(normalizeApiError(error).status) || parentId) throw error;
        const channels = await (await apiFetch("/v1/channels?limit=200")).json();
        if (!Array.isArray(channels.items)) throw error;
        data = {
          requiresChannel: true,
          configured: channels.items.some(
            (channel: { selected?: boolean }) => channel.selected === true,
          ),
        };
      }
      if (typeof data.requiresChannel !== "boolean" || typeof data.configured !== "boolean")
        throw new Error("No se pudo comprobar la configuración de la unidad.");
      return data;
    },
  });
}
export async function ensureStorageReady(parentId?: string) {
  if (isDemoActive()) return true;
  const client = getQueryClient(),
    user = await client.ensureQueryData(currentUserQueryOptions());
  const setup = await client.fetchQuery({
    ...storageSetupQuery(user.userId, parentId),
    staleTime: 0,
  });
  if (!setup.requiresChannel || setup.configured) return true;
  useStorageSetupNotice.getState().show({ userId: user.userId, parentId, reason: "upload" });
  return false;
}
// Preserve the browser's file-picker gesture; the async check still runs after selection.
export function showStorageNoticeIfKnownMissing(parentId?: string) {
  if (isDemoActive()) return false;
  const client = getQueryClient(),
    user = client.getQueryData(currentUserQueryOptions().queryKey);
  if (!user) return false;
  const setup = client.getQueryData(storageSetupQuery(user.userId, parentId).queryKey);
  if (!setup?.requiresChannel || setup.configured) return false;
  useStorageSetupNotice.getState().show({ userId: user.userId, parentId, reason: "upload" });
  return true;
}
