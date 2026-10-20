import { useState } from 'react';
import { api } from './api.ts';
import type { Me } from './types.ts';
import { errorText } from './ui.tsx';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { onLogin(await api<Me>('POST', '/api/login', { email, password })); }
    catch (err: any) { setError(err.status === 429 ? 'Too many attempts. Try again later.' : err.status === 401 ? 'Email or password is wrong.' : errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Redaction Studio</h1>
      <label>Email<input type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !email || !password}>Sign in</button>
    </form>
  );
}

export function ChangePassword({ forced, onDone, onCancel }: { forced?: boolean; onDone: (me: Me) => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) { setError('The new passwords do not match.'); return; }
    try { onDone(await api<Me>('POST', '/api/me/password', { currentPassword: current, newPassword: next })); }
    catch (err: any) { setError(err.code === 'wrong_password' ? 'The current password is wrong.' : errorText(err)); }
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>{forced ? 'Choose a new password' : 'Change password'}</h1>
      {forced && <p className="muted">Your password was set by the administrator. Choose your own to continue.</p>}
      <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <label>New password again<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={!current || !next}>Save</button>
      </div>
    </form>
  );
}
