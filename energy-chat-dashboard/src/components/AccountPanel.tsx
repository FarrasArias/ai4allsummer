import { useId, useState, type FormEvent } from "react";
import { changePassword, logout, removeWebKey, saveWebKey } from "../api";
import { MIN_PASSWORD, checkNewPassword, clearUserStorage, errorText, useSession } from "../session";

/* Settings → Account: who you are, your password, and signing out.
   At the host Mac the owner never signs in; a password is only needed to
   sign in as the owner from another device. */
export default function AccountPanel() {
    const { me, refresh } = useSession();
    const user = me.user!;
    const ownerAtMac = me.local && user.is_owner;
    const id = useId();

    const [current, setCurrent] = useState("");
    const [password, setPassword] = useState("");
    const [again, setAgain] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setResult(null);
        try {
            checkNewPassword(password, again);
            await changePassword(password, ownerAtMac ? undefined : current);
            setResult({
                ok: true,
                text: ownerAtMac && !me.has_password
                    ? `Password set. You can now sign in as ${user.username} from other devices.`
                    : "Password changed. Any other devices signed in to this account were signed out.",
            });
            setCurrent(""); setPassword(""); setAgain("");
            refresh();
        } catch (err) {
            setResult({ ok: false, text: errorText(err) });
        } finally {
            setBusy(false);
        }
    }

    async function signOut() {
        try { await logout(); } catch { /* signed out either way */ }
        clearUserStorage();
        window.location.href = "/";
    }

    const heading = ownerAtMac && !me.has_password ? "Set a password" : "Change password";

    return (
        <section className="panel">
            <div className="panel-body account-panel">
                <h3>Account</h3>
                {ownerAtMac ? (
                    <p>
                        You're at the host Mac, using the <strong>{user.username}</strong> account (owner).
                        No sign-in is needed here.
                    </p>
                ) : (
                    <p>
                        Signed in as <strong>{user.username}</strong>
                        {user.role === "admin" ? " · admin" : ""}.
                    </p>
                )}

                <form className="account-form" onSubmit={submit}>
                    <h4>{heading}</h4>
                    {ownerAtMac && !me.has_password && (
                        <p className="account-hint">Only needed to sign in as {user.username} from another device.</p>
                    )}
                    {/* lets password managers attach the password to the right account */}
                    <input type="text" value={user.username} autoComplete="username" readOnly hidden />
                    {!ownerAtMac && (
                        <div className="account-field">
                            <label htmlFor={`${id}-current`}>Current password</label>
                            <input id={`${id}-current`} type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
                                   autoComplete="current-password" required />
                        </div>
                    )}
                    <div className="account-field">
                        <label htmlFor={`${id}-new`}>New password <small>(at least {MIN_PASSWORD} characters)</small></label>
                        <input id={`${id}-new`} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                               autoComplete="new-password" required />
                    </div>
                    <div className="account-field">
                        <label htmlFor={`${id}-again`}>New password again</label>
                        <input id={`${id}-again`} type="password" value={again} onChange={(e) => setAgain(e.target.value)}
                               autoComplete="new-password" required />
                    </div>
                    {result && (
                        <p className={result.ok ? "account-ok" : "auth-error"} role={result.ok ? "status" : "alert"}>
                            {result.text}
                        </p>
                    )}
                    <div>
                        <button type="submit" disabled={busy}>{busy ? "Saving…" : heading}</button>
                    </div>
                </form>

                <WebKeyForm />

                {!me.local && (
                    <div>
                        <button type="button" onClick={signOut}>Sign out</button>
                    </div>
                )}
            </div>
        </section>
    );
}

/* Their own Ollama key for the Web tab. Saved encrypted on the host; the app
   only ever shows its last 4 characters. The owner's key is also the shared
   one for people who haven't added theirs. */
function WebKeyForm() {
    const { me, refresh } = useSession();
    const id = useId();
    const isOwner = me.user!.is_owner;
    const saved = me.web_key?.saved ?? false;
    const limit = me.web_daily_limit ?? 0;
    const [editing, setEditing] = useState(false);
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

    async function run(action: () => Promise<unknown>, done: string) {
        setBusy(true);
        setResult(null);
        try {
            await action();
            setKey("");
            setEditing(false);
            setResult({ ok: true, text: done });
            refresh();
        } catch (err) {
            setResult({ ok: false, text: errorText(err) });
        } finally {
            setBusy(false);
        }
    }

    const save = (e: FormEvent) => { e.preventDefault(); run(() => saveWebKey(key), "Key saved."); };

    return (
        <form className="account-form" onSubmit={save}>
            <h4>Web search key</h4>
            <p className="account-hint">
                {isOwner
                    ? <>Used for your web searches, and shared with people who haven't added their own (up to {limit} web prompts a day each). Without one here, the key in backend/.env is used.</>
                    : <>With your own key, the Web tab searches with it and has no daily limit. Without one you share the host's, up to {limit} web prompts a day.</>}
                {" "}Create a free key on ollama.com, under your account's API keys.
            </p>
            {!isOwner && !me.web_shared_available && !saved && (
                <p className="account-hint">The host hasn't set up a shared key, so you need your own to use Web.</p>
            )}

            {saved && !editing ? (
                <div className="account-key-row">
                    <span>Saved key ending in <strong>{me.web_key?.hint?.replace("…", "")}</strong></span>
                    <button type="button" onClick={() => { setEditing(true); setResult(null); }}>Replace</button>
                    <button type="button" disabled={busy} onClick={() => run(removeWebKey, "Key removed.")}>Remove</button>
                </div>
            ) : (
                <>
                    <div className="account-field">
                        <label htmlFor={`${id}-key`}>Ollama API key</label>
                        <input
                            id={`${id}-key`}
                            type="password"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            required
                        />
                    </div>
                    <div className="account-key-row">
                        <button type="submit" disabled={busy || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
                        {saved && <button type="button" onClick={() => { setEditing(false); setKey(""); }}>Cancel</button>}
                    </div>
                </>
            )}
            {result && (
                <p className={result.ok ? "account-ok" : "auth-error"} role={result.ok ? "status" : "alert"}>{result.text}</p>
            )}
        </form>
    );
}
