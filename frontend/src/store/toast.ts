import { create } from "zustand";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  title?: string;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (message: string, type: ToastType, title?: string) => void;
  removeToast: (id: string) => void;
}

/**
 * How long a toast stays on screen. A warning explains a consequence the user
 * may need to act on, so it lingers longer than a confirmation. Everything else
 * keeps the existing 5s lifetime.
 */
const TOAST_DURATION_MS: Record<ToastType, number> = {
  success: 5000,
  info: 5000,
  error: 5000,
  warning: 8000,
};

let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (message, type, title) => {
    const id = String(nextId++);
    set((state) => ({
      toasts: [...state.toasts, { id, message, type, title }],
    }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, TOAST_DURATION_MS[type]);
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
