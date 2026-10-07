import { useEffect, useId, useState, type FormEvent } from "react";
import {
    createInvite,
    createResetLink,
    deleteUser,
    listInvites,
    listUsers,
    revokeInvite,
    updateUser,
    type AdminUser,
    type Invite,
} from "../api";
import { errorText, useSession } from "../session";

/* Settings → Users (admins): invite people, and manage who can sign in.
   Links are shown here to copy and send yourself — there's no email.
   SERVER_STAGE1.md §2. */

type Link = { url: string; label: string };

function when(ts: number | null): string {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function UsersPanel({ onOpenEnergy }: { onOpenEnergy?: () => void }) {
    const { me } = useSession();
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [invites, setInvites] = useState<Invite[]>([]);
    const [note, setNote] = useState("");
    const [role, setRole] = useState<"user" | "admin">("user");
    const [link, setLink] = useState<Link | null>(null);
    const [error, setError] = useState<string | null>(null);
    const id = useId();

    async function reload() {
        try {
            const [u, i] = await Promise.all([listUsers(), listInvites()]);
            setUsers(u.users);
            setInvites(i.invites);
        } catch (err) {
            setError(errorText(err));
        }
    }

    useEffect(() => { reload(); }, []);

    async function act(fn: () => Promise<unknown>) {
        setError(null);
        try {
            await fn();
            await reload();
        } catch (err) {
            setError(errorText(err));
        }
    }

    async function invite(e: FormEvent) {
        e.preventDefault();
        await act(async () => {
            const res = await createInvite(role, note.trim());
            const who = note.trim() ? ` for ${note.trim()}` : "";
            setLink({ url: res.url, label: `Invite link${who} — works once, for ${res.expires_days} days.` });
            setNote("");
            setRole("user");
        });
    }

    const resetLink = (u: AdminUser) => act(async () => {
        const res = await createResetLink(u.id);
        setLink({ url: res.url, label: `Password reset link for ${u.username} — works once, for ${res.expires_hours} hours.` });
    });

    const remove = (u: AdminUser) => {
        const ok = window.confirm(
            `Delete ${u.username}?\n\nThey won't be able to sign in. Their chats and files are moved ` +
            `to backend/userdata/_deleted/ on this Mac, not erased.`,
        );
        if (ok) act(() => deleteUser(u.id));
    };

    return (
        <section className="panel">
            <div className="panel-body users-panel">
                <h3>Users</h3>
                {onOpenEnergy && (
                    <button type="button" className="energy-link" onClick={onOpenEnergy}>
                        Energy report: everyone's energy use →
                    </button>
                )}

                <form className="users-invite" onSubmit={invite}>
                    <div className="account-field">
                        <label htmlFor={`${id}-note`}>Who is it for? <small>(optional, only you see this)</small></label>
                        <input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="e.g. Ana" />
                    </div>
                    <div className="account-field">
                        <label htmlFor={`${id}-role`}>Role</label>
                        <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
                            <option value="user">User</option>
                            <option value="admin">Admin — can invite and manage users, and models</option>
                        </select>
                    </div>
                    <div><button type="submit">Create invite link</button></div>
                </form>

                {link && <LinkBox link={link} onClose={() => setLink(null)} />}
                {error && <p className="auth-error" role="alert">{error}</p>}

                {invites.length > 0 && (
                    <>
                        <h4>Pending invites</h4>
                        <ul className="users-list">
                            {invites.map((i) => (
                                <li key={i.id}>
                                    <span>{i.note || "(no note)"}{i.role === "admin" ? " · admin" : ""}</span>
                                    <span className="users-dim">expires {when(i.expires_at)}</span>
                                    <button type="button" onClick={() => act(() => revokeInvite(i.id))}>Revoke</button>
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                <h4>People</h4>
                <div className="users-table-wrap">
                    <table className="users-table">
                        <thead>
                            <tr><th>Username</th><th>Role</th><th>Status</th><th>Last seen</th><th><span className="sr-only">Actions</span></th></tr>
                        </thead>
                        <tbody>
                            {users.map((u) => {
                                const locked = u.is_owner || u.id === me.user!.id;
                                return (
                                    <tr key={u.id} className={u.status === "disabled" ? "users-disabled" : ""}>
                                        <td>{u.username}{u.id === me.user!.id ? " (you)" : ""}</td>
                                        <td>{u.is_owner ? "owner" : u.role}</td>
                                        <td>{u.status}</td>
                                        <td>{when(u.last_seen_at)}</td>
                                        <td className="users-actions">
                                            {!locked && (
                                                <>
                                                    <button type="button" onClick={() => act(() => updateUser(u.id, { role: u.role === "admin" ? "user" : "admin" }))}>
                                                        {u.role === "admin" ? "Remove admin" : "Make admin"}
                                                    </button>
                                                    <button type="button" onClick={() => act(() => updateUser(u.id, { status: u.status === "active" ? "disabled" : "active" }))}>
                                                        {u.status === "active" ? "Disable" : "Enable"}
                                                    </button>
                                                    <button type="button" onClick={() => resetLink(u)}>Reset link</button>
                                                    <button type="button" className="users-danger" onClick={() => remove(u)}>Delete</button>
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    );
}

function LinkBox({ link, onClose }: { link: Link; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    // Until the public address is set up, links point at this Mac itself
    const localOnly = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(link.url);

    async function copy() {
        try {
            await navigator.clipboard.writeText(link.url);
            setCopied(true);
        } catch {
            setCopied(false); // the field is selectable as a fallback
        }
    }

    return (
        <div className="users-link" role="status">
            <p>{link.label} Send it yourself — anyone with it can use it.</p>
            <div className="users-link-row">
                <input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Link" />
                <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
                <button type="button" onClick={onClose} aria-label="Hide link">Done</button>
            </div>
            {localOnly && (
                <p className="users-dim">
                    This link points at this Mac, so it only works here until the public address is set
                    up (UNESS_PUBLIC_HOST in backend/.env).
                </p>
            )}
        </div>
    );
}
