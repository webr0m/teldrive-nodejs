import { create } from "zustand";
import { clientOnly } from "./client-runtime";

export const useClientOnboarding = create<{
  tourOpen: boolean;
  setTourOpen: (open: boolean) => void;
}>((set) => ({
  tourOpen: false,
  setTourOpen: (tourOpen) => set({ tourOpen }),
}));
const seen = new Set<number>();
const key = (userId: number) => `teldrive-tour-v1:${userId}`;
export function needsClientTour(userId: number) {
  if (!clientOnly || seen.has(userId)) return false;
  try {
    return !localStorage.getItem(key(userId));
  } catch {
    return true;
  }
}
export function rememberClientTour(userId: number) {
  seen.add(userId);
  try {
    localStorage.setItem(key(userId), "seen");
  } catch {
    /* The in-memory acknowledgement still works. */
  }
}
