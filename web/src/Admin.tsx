import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Me } from './types.ts';
import { Confirm, Dialog, errorText } from './ui.tsx';

interface AdminUser { id: string; email: string; displayName: string; isAdmin: boolean; disabled: boolean; mustChangePassword: boolean; memberships: { projectId: string; title: string; role: string }[] }
interface AdminTeam { id: string; name: string; members: { id: string; email: string; displayName: string }[] }

export function Admin({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [message, setMessage] = useState<string>('');
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [newUser, setNewUser] = useState({ email: '', displayName: '' });
  const [newTeam, setNewTeam] = useState('');
  const [confirmTeam, setConfirmTeam] = useState<AdminTeam | null>(null);
  const [rename, setRename] = useState<AdminTeam | null>(null);

  const load = useCallback(async () => {
    const u = await api<{ users: AdminUser[] }>('GET', '/api/admin/users');
    const t = await api<{ teams: AdminTeam[] }>('GET', '/api/admin/teams');
    setUsers(u.users); setTeams(t.teams);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = (fn: () => Promise<unknown>) => async () => {
    setMessage('');
    try { await fn(); await load(); } catch (e: any) {
      if (e.code === 'last_author') setMessage(`Cannot disable: sole author of ${e.body.projects.map((p: any) => `"${p.title}"`).join(', ')}.`);
      else setMessage(errorText(e));
    }
  };

  return (
    <div className="page">
      <header className="topbar"><strong>Redaction Studio · Administration</strong><span className="grow" />
        <span className="muted">{me.user.email}</span><button onClick={onLogout}>Sign out</button></header>
      {message && <p className="error">{message}</p>}
      <section className="card">
        <h2>Accounts</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Projects</th><th /></tr></thead>
          <tbody>{users.filter((u) => !u.isAdmin).map((u) => (
            <tr key={u.id} className={u.disabled ? 'dim' : ''}>
              <td>{u.displayName}{u.disabled && ' (disabled)'}{u.mustChangePassword && ' (temporary password)'}</td>
              <td>{u.email}</td>
              <td>{u.memberships.map((m) => `${m.title} (${m.role === 'reader' ? 'viewer' : 'author'})`).join(', ') || '—'}</td>
              <td className="row end">
                <button onClick={act(async () => { const r = await api<{ temporaryPassword: string }>('POST', `/api/admin/users/${u.id}/reset-password`); setSecret({ email: u.email, password: r.temporaryPassword }); })}>Reset password</button>
                <button onClick={act(() => api('POST', `/api/admin/users/${u.id}/disabled`, { disabled: !u.disabled }))}>{u.disabled ? 'Enable' : 'Disable'}</button>
              </td>
            </tr>))}</tbody>
        </table>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => {
          const r = await api<{ temporaryPassword: string; email: string }>('POST', '/api/admin/users', newUser);
          setSecret({ email: r.email, password: r.temporaryPassword }); setNewUser({ email: '', displayName: '' });
        })(); }}>
          <input placeholder="Name" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
          <input placeholder="Email" type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
          <button className="primary" disabled={!newUser.email || !newUser.displayName}>Create account</button>
        </form>
      </section>

      <section className="card">
        <h2>Teams</h2>
        <p className="muted">Authors can only add people who share a team with them.</p>
        {teams.map((t) => (
          <div key={t.id} className="team">
            <div className="row"><strong>{t.name}</strong><span className="grow" />
              <button onClick={() => setRename(t)}>Rename</button>
              <button className="danger" onClick={() => setConfirmTeam(t)}>Delete</button></div>
            <div className="chips">
              {t.members.map((m) => (
                <span key={m.id} className="chip">{m.displayName}
                  <button title="Remove" onClick={act(() => api('DELETE', `/api/admin/teams/${t.id}/members/${m.id}`))}>×</button></span>))}
              <select value="" onChange={(e) => { if (e.target.value) void act(() => api('PUT', `/api/admin/teams/${t.id}/members/${e.target.value}`))(); }}>
                <option value="">Add member…</option>
                {users.filter((u) => !u.isAdmin && !u.disabled && !t.members.some((m) => m.id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
          </div>))}
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', '/api/admin/teams', { name: newTeam }); setNewTeam(''); })(); }}>
          <input placeholder="New team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
          <button className="primary" disabled={!newTeam.trim()}>Create team</button>
        </form>
      </section>

      {secret && (
        <Dialog title="Temporary password" onClose={() => setSecret(null)}>
          <p>For <strong>{secret.email}</strong>. It is shown only now; the person must choose their own at first sign-in.</p>
          <p><code className="secret">{secret.password}</code></p>
          <div className="row end"><button className="primary" onClick={() => setSecret(null)}>Done</button></div>
        </Dialog>)}
      {confirmTeam && <Confirm title="Delete team" danger confirmLabel="Delete" message={`Delete "${confirmTeam.name}"? Existing project members keep their access.`}
        onConfirm={act(() => api('DELETE', `/api/admin/teams/${confirmTeam.id}`))} onClose={() => setConfirmTeam(null)} />}
      {rename && <RenameTeam team={rename} onClose={() => setRename(null)} onSave={(n) => act(() => api('PATCH', `/api/admin/teams/${rename.id}`, { name: n }))()} />}
    </div>
  );
}

function RenameTeam({ team, onSave, onClose }: { team: AdminTeam; onSave: (n: string) => void; onClose: () => void }) {
  const [name, setName] = useState(team.name);
  return (
    <Dialog title="Rename team" onClose={onClose}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <div className="row end"><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!name.trim()} onClick={() => { onSave(name.trim()); onClose(); }}>Save</button></div>
    </Dialog>
  );
}
