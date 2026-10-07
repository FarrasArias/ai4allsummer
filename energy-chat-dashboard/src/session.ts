import { createContext, useContext } from "react";
import { ApiError, type Me } from "./api";

/* Who is using the app, and what they may use (from GET /api/me). Provided
   by AuthGate once someone is signed in, or at the host Mac. */
export type Session = { me: Me; refresh: () => void };

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
    const s = useContext(SessionContext);
    if (!s) throw new Error("useSession outside AuthGate");
    return s;
}

/* ── Browser storage on shared computers ──
   Chats in progress are kept in localStorage. When a different person signs
   in on the same browser, or someone signs out, those must not be left for
   the next person. Preferences (theme, models, study settings) stay. */

const LAST_USER_KEY = "ai4all.lastUser";

const USER_KEYS = [
    "ai4all.chat.messages",
    "ai4all.vibe.entries",
    "ai4all.web.messages",
    "ai4all.image.turns",
    "ai4all.image.dataUrl",
    "ai4all.image.name",
    "ai4all.imagegen.history",
    "ai4all.pinnedChats",
];

export function clearUserStorage() {
    try {
        USER_KEYS.forEach((k) => localStorage.removeItem(k));
        localStorage.removeItem(LAST_USER_KEY);
    } catch { /* storage unavailable */ }
}

/* Call before the app mounts (it reads these keys on first render). The
   first sign-in in a browser keeps what's there — it can only be this
   user's, from before accounts existed. */
export function adoptUser(username: string) {
    try {
        const last = localStorage.getItem(LAST_USER_KEY);
        if (last !== null && last !== username) clearUserStorage();
        localStorage.setItem(LAST_USER_KEY, username);
    } catch { /* storage unavailable */ }
}

/* ── Form helpers shared by the sign-in screens and the Account panel ── */

export const MIN_PASSWORD = 10;

// A problem with what was typed, caught before asking the server
export class FormProblem extends Error {}

export function errorText(err: unknown): string {
    return err instanceof ApiError || err instanceof FormProblem
        ? err.message
        : "Can't reach the server. Try again in a moment.";
}

export function checkNewPassword(password: string, again: string) {
    if (password.length < MIN_PASSWORD) throw new FormProblem(`Passwords need at least ${MIN_PASSWORD} characters.`);
    if (password !== again) throw new FormProblem("The two passwords don't match.");
}
