import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
    SIGNED_OUT_EVENT,
    acceptInvite,
    acceptReset,
    getInvite,
    getMe,
    getReset,
    login,
    type Me,
} from "../api";
import { MIN_PASSWORD, SessionContext, adoptUser, checkNewPassword, errorText as message } from "../session";
import App from "../App";

/* Decides what to show before the app: the login screen, an invite or
   password-reset page (from a link someone was sent), or the app itself.
   At the host Mac the server answers as the owner, so this goes straight
   to the app. SERVER_STAGE1.md §7. */

type Route = { kind: "app" } | { kind: "invite" | "reset"; token: string };

function routeFromPath(): Route {
    const m = window.location.pathname.match(/^\/(invite|reset)\/([^/]+)\/?$/);
    return m ? { kind: m[1] as "invite" | "reset", token: decodeURIComponent(m[2]) } : { kind: "app" };
}


export default function AuthGate() {
    const [route, setRoute] = useState<Route>(routeFromPath);
    const [me, setMe] = useState<Me | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    const load = useCallback(() => {
        setLoadError(null);
        getMe()
            .then((m) => {
                if (m.user) adoptUser(m.user.username);
                setMe(m);
            })
            .catch((err) => setLoadError(message(err)));
    }, []);

    useEffect(load, [load]);

    useEffect(() => {
        const onSignedOut = () => setMe((m) => (m && !m.local ? { ...m, user: null } : m));
        window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
        return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
    }, []);

    const signedIn = useCallback(() => {
        window.history.replaceState(null, "", "/");
        setRoute({ kind: "app" });
        setMe(null);
        load();
    }, [load]);

    if (route.kind === "invite") return <InvitePage token={route.token} onDone={signedIn} />;
    if (route.kind === "reset") return <ResetPage token={route.token} onDone={signedIn} />;

    if (!me) {
        if (!loadError) return null; // brief: /api/me answers quickly
        return (
            <AuthShell title="Uness">
                <p className="auth-error" role="alert">{loadError}</p>
                <button type="button" className="auth-submit" onClick={load}>Try again</button>
            </AuthShell>
        );
    }

    if (!me.user) return <LoginPage onDone={signedIn} />;

    return (
        <SessionContext.Provider value={{ me, refresh: load }}>
            <App />
        </SessionContext.Provider>
    );
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
    return (
        <main className="auth-screen">
            <div className="auth-card">
                <div className="auth-brand">
                    <div className="sidebar-logo" aria-hidden="true">U</div>
                    <span>Uness</span>
                </div>
                <h1 className="auth-title">{title}</h1>
                {subtitle && <p className="auth-subtitle">{subtitle}</p>}
                {children}
            </div>
        </main>
    );
}

function Field(props: {
    label: string;
    type?: string;
    value: string;
    onChange: (v: string) => void;
    autoComplete: string;
    autoFocus?: boolean;
    hint?: string;
}) {
    const id = useId();
    return (
        <div className="auth-field">
            <label htmlFor={id}>{props.label}</label>
            <input
                id={id}
                aria-describedby={props.hint ? `${id}-hint` : undefined}
                type={props.type ?? "text"}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
                autoComplete={props.autoComplete}
                autoFocus={props.autoFocus}
                autoCapitalize="off"
                spellCheck={false}
                required
            />
            {props.hint && <small id={`${id}-hint`}>{props.hint}</small>}
        </div>
    );
}

function useSubmit(action: () => Promise<void>) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (err) {
            setError(message(err));
            setBusy(false);
        }
    };
    return { busy, error, submit };
}

function LoginPage({ onDone }: { onDone: () => void }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const { busy, error, submit } = useSubmit(async () => {
        await login(username.trim(), password);
        onDone();
    });
    return (
        <AuthShell title="Sign in" subtitle="Uness is invite-only. Use the username and password you chose when you accepted your invite.">
            <form className="auth-form" onSubmit={submit}>
                <Field label="Username" value={username} onChange={setUsername} autoComplete="username" autoFocus />
                <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
                {error && <p className="auth-error" role="alert">{error}</p>}
                <button type="submit" className="auth-submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
            </form>
            <p className="auth-footnote">Forgot your password? Ask the person who invited you for a reset link.</p>
        </AuthShell>
    );
}

function useTokenInfo<T>(fetcher: () => Promise<T>) {
    const [info, setInfo] = useState<T | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        fetcher().then(setInfo).catch((err) => setProblem(message(err)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { info, problem };
}

function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
    const { info, problem } = useTokenInfo(() => getInvite(token));
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [again, setAgain] = useState("");
    const { busy, error, submit } = useSubmit(async () => {
        checkNewPassword(password, again);
        await acceptInvite(token, username.trim(), password);
        onDone();
    });

    if (problem) return <LinkProblem text={problem} />;
    if (!info) return null;
    return (
        <AuthShell
            title="You're invited"
            subtitle={<>Choose a username and password for Uness{info.role === "admin" ? " (as an admin)" : ""}. Your chats and documents stay private to you; the person running this Mac can still see the files on it, and use any API key you add.</>}
        >
            <form className="auth-form" onSubmit={submit}>
                <Field label="Username" value={username} onChange={setUsername} autoComplete="username" autoFocus
                       hint="3–32 characters: lowercase letters, numbers, - and _" />
                <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password"
                       hint={`At least ${MIN_PASSWORD} characters`} />
                <Field label="Password again" type="password" value={again} onChange={setAgain} autoComplete="new-password" />
                {error && <p className="auth-error" role="alert">{error}</p>}
                <button type="submit" className="auth-submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
            </form>
        </AuthShell>
    );
}

function ResetPage({ token, onDone }: { token: string; onDone: () => void }) {
    const { info, problem } = useTokenInfo(() => getReset(token));
    const [password, setPassword] = useState("");
    const [again, setAgain] = useState("");
    const { busy, error, submit } = useSubmit(async () => {
        checkNewPassword(password, again);
        await acceptReset(token, password);
        onDone();
    });

    if (problem) return <LinkProblem text={problem} />;
    if (!info) return null;
    return (
        <AuthShell title="Choose a new password" subtitle={<>For <strong>{info.username}</strong>. You'll be signed out everywhere else.</>}>
            <form className="auth-form" onSubmit={submit}>
                {/* lets password managers attach the new password to the right account */}
                <input type="text" value={info.username} autoComplete="username" readOnly hidden />
                <Field label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus
                       hint={`At least ${MIN_PASSWORD} characters`} />
                <Field label="New password again" type="password" value={again} onChange={setAgain} autoComplete="new-password" />
                {error && <p className="auth-error" role="alert">{error}</p>}
                <button type="submit" className="auth-submit" disabled={busy}>{busy ? "Saving…" : "Save and sign in"}</button>
            </form>
        </AuthShell>
    );
}

function LinkProblem({ text }: { text: string }) {
    return (
        <AuthShell title="This link doesn't work">
            <p className="auth-error" role="alert">{text}</p>
            <p className="auth-footnote">Ask the person who sent it for a new one. Already have an account? <a href="/">Sign in</a>.</p>
        </AuthShell>
    );
}
