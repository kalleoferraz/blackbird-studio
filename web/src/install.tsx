import { useEffect, useState } from 'react';

// Chrome fires beforeinstallprompt when the app can be installed (desktop and Android). We keep the event and
// show an Install button; once installed (or already running as the installed app) the button disappears.
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

export function InstallButton() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  if (!deferred) return null;
  const install = async () => { const e = deferred; if (!e) return; await e.prompt(); await e.userChoice; deferred = null; notify(); };
  return <button onClick={install}>Install app</button>;
}
