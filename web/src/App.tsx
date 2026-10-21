import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.ts';
import type { Me } from './types.ts';
import { Login, ChangePassword } from './Login.tsx';
import { Admin } from './Admin.tsx';
import { Projects } from './Projects.tsx';
import { ProjectView } from './ProjectView.tsx';
import { ScriptView } from './ScriptView.tsx';

export interface Route { name: 'home' | 'project' | 'script' | 'admin'; projectId?: string; segmentId?: string }

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'admin') return { name: 'admin' };
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 's') return { name: 'script', projectId: parts[1], segmentId: parts[3] };
    return { name: 'project', projectId: parts[1] };
  }
  return { name: 'home' };
}
export const go = (path: string) => { location.hash = path; };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(() => parse(location.hash));

  const load = useCallback(async () => {
    try { setMe(await api<Me>('GET', '/api/me')); } catch { setMe(null); }
  }, []);
  useEffect(() => { setUnauthorizedHandler(() => setMe(null)); void load(); }, [load]);
  useEffect(() => {
    const h = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onLogin={setMe} />;
  if (me.user.mustChangePassword) return <ChangePassword forced onDone={setMe} />;
  const logout = async () => { await api('POST', '/api/logout', {}); setMe(null); go('/'); };

  if (me.user.isAdmin) return <Admin me={me} onLogout={logout} />;
  if (route.name === 'script' && route.projectId) return <ScriptView me={me} projectId={route.projectId} segmentId={route.segmentId} />;
  if (route.name === 'project' && route.projectId) return <ProjectView me={me} projectId={route.projectId} onLogout={logout} />;
  return <Projects me={me} onLogout={logout} onMe={setMe} />;
}
