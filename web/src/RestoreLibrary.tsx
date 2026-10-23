import { useEffect, useRef, useState } from 'react';
import { api, uploadFile } from './api.ts';
import { formatBytes } from './format.ts';
import { Dialog, errorText } from './ui.tsx';
import { readZipEntry, readZipIndex } from './zip.ts';

/** The project file inside an exported zip (its root). It is not a library file. */
export const PROJECT_FILE = 'project.json';

type Known = { path: string; role: 'master' | 'derived'; assetId: string; masterPath: string; onDisk: number | null; listedSize: number };
type RestoreTally = { restored: number; replaced: number; kept: number; skipped: string[]; failed: { name: string; why: string }[]; tasks: number };
type Choice = 'keep' | 'replace';

/**
 * Reads the zip in the browser and sends its files to the project one at a time (the zip itself is never uploaded).
 * First it asks the server which entries the project lists and which of those are already on disk; for those the
 * person decides per file (or for all) whether to keep the version on the server or replace it with the zip's.
 */
export function RestoreLibrary({ projectId, zip, title = 'Update assets only', onClose }: { projectId: string; zip: File; title?: string; onClose: () => void }) {
  const [stage, setStage] = useState<'scan' | 'choose' | 'run' | 'done'>('scan');
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState('');
  const [fatal, setFatal] = useState('');
  const [existing, setExisting] = useState<{ name: string; zipSize: number; diskSize: number }[]>([]);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [tally, setTally] = useState<RestoreTally>({ restored: 0, replaced: 0, kept: 0, skipped: [], failed: [], tasks: 0 });
  const stop = useRef(false);
  const decide = useRef<((c: Record<string, Choice> | null) => void) | null>(null);
  const key = (n: string) => n.toLowerCase();
  useEffect(() => {
    stop.current = false;
    const t: RestoreTally = { restored: 0, replaced: 0, kept: 0, skipped: [], failed: [], tasks: 0 };
    const publish = () => setTally({ ...t, skipped: [...t.skipped], failed: [...t.failed] });
    void (async () => {
      try {
        const entries = (await readZipIndex(zip)).filter((e) => !e.directory && e.name.toLowerCase() !== PROJECT_FILE);
        setTotal(entries.length);
        // What does the project know, and what is already on disk?
        const known = new Map<string, Known>();
        for (let i = 0; i < entries.length; i += 2000) {
          const r = await api<{ files: Known[] }>('POST', `/api/projects/${projectId}/library/restore-check`, { paths: entries.slice(i, i + 2000).map((e) => e.name) });
          for (const f of r.files) known.set(key(f.path), f);
        }
        const clashes = entries.filter((e) => { const k = known.get(key(e.name)); return k?.role === 'master' && k.onDisk !== null; });
        let chosen: Record<string, Choice> = {};
        if (clashes.length) {
          const list = clashes.map((e) => ({ name: e.name, zipSize: e.size, diskSize: known.get(key(e.name))!.onDisk! }));
          setExisting(list);
          setChoice(Object.fromEntries(list.map((x) => [x.name, 'keep' as Choice])));
          setStage('choose');
          const answer = await new Promise<Record<string, Choice> | null>((resolve) => { decide.current = resolve; });
          if (!answer) { setStage('done'); return; }
          chosen = answer;
        }
        setStage('run');
        const replacedMasters = new Set(clashes.filter((e) => chosen[e.name] === 'replace').map((e) => key(known.get(key(e.name))!.masterPath)));
        let n = 0;
        for (const e of entries) {
          if (stop.current) break;
          setCurrent(e.name);
          const k = known.get(key(e.name));
          if (!k) t.skipped.push(e.name); // not in this project's file list: nothing to send
          else if (k.onDisk !== null && !(k.role === 'master' && chosen[e.name] === 'replace')) {
            if (k.role === 'master') t.kept++; // already there, and kept (an MP3 or reduced copy follows its file)
          } else if (e.size > 100 * 1024 * 1024) t.failed.push({ name: e.name, why: 'larger than 100 MB, which the server cannot take' });
          else if (e.size === 0) t.skipped.push(e.name);
          else if (k.role === 'derived' && replacedMasters.has(key(k.masterPath))) { /* made again from the replaced file */ }
          else {
            try {
              const replace = k.role === 'master' && k.onDisk !== null;
              const r = await uploadFile<{ outcome: 'restored' | 'already' | 'replaced'; tasks: number }>('POST',
                `/api/projects/${projectId}/library/restore?path=${encodeURIComponent(e.name)}${replace ? '&replace=1' : ''}`, await readZipEntry(zip, e));
              if (r.outcome === 'restored') t.restored++; else if (r.outcome === 'replaced') t.replaced++; else t.kept++;
              t.tasks += r.tasks ?? 0;
            } catch (err: any) {
              if (err.code === 'not_in_project') t.skipped.push(e.name);
              else t.failed.push({ name: e.name, why: errorText(err) });
            }
          }
          setDone(++n);
          publish();
        }
      } catch (err) { setFatal(errorText(err)); }
      setStage('done');
    })();
    return () => { stop.current = true; decide.current?.(null); };
  }, [zip, projectId]);

  const setAll = (c: Choice) => setChoice(Object.fromEntries(existing.map((x) => [x.name, c])));
  const replacing = existing.filter((x) => choice[x.name] === 'replace').length;
  const finished = stage === 'done';
  return (
    <Dialog title={title} wide={stage === 'choose'} onClose={finished ? onClose : () => undefined}>
      <p className="muted small">{zip.name}</p>
      {fatal && <p className="error">{fatal}</p>}
      {stage === 'scan' && !fatal && <p>Reading the zip…</p>}
      {stage === 'choose' && <>
        <p>{existing.length === 1 ? 'This file is' : `These ${existing.length} files are`} already in the library. Keep the version that is here, or replace it with the one from the zip? A replaced audio file gets a new waveform, and the cues that play it get the task “Check if new audio is fitting”.</p>
        <div className="row"><button onClick={() => setAll('keep')}>Keep all</button><button onClick={() => setAll('replace')}>Replace all</button></div>
        <div className="restore-list">
          {existing.map((x) => <div key={x.name} className="restore-row">
            <span className="grow"><span className="lib-name">{x.name}</span>
              <span className="muted small"> · here {formatBytes(x.diskSize)} · zip {formatBytes(x.zipSize)}{x.diskSize === x.zipSize ? ' · same size' : ''}</span></span>
            <select value={choice[x.name]} onChange={(e) => setChoice({ ...choice, [x.name]: e.target.value as Choice })}>
              <option value="keep">Keep current</option><option value="replace">Replace</option>
            </select>
          </div>)}
        </div>
      </>}
      {stage === 'run' && <>
        <p>{done} of {total} files{current ? <><br /><span className="muted small">{current}</span></> : null}</p>
        {total > 0 && <progress value={done} max={total} style={{ width: '100%' }} />}
      </>}
      {finished && !fatal && <p>{stop.current ? 'Stopped. ' : ''}{tally.restored} restored{tally.replaced ? `, ${tally.replaced} replaced` : ''}, {tally.kept} kept as they were{tally.skipped.length ? `, ${tally.skipped.length} skipped (not in this project's file list)` : ''}{tally.failed.length ? `, ${tally.failed.length} failed` : ''}.{tally.tasks ? ` ${tally.tasks === 1 ? 'One task was' : `${tally.tasks} tasks were`} added: “Check if new audio is fitting”.` : ''}</p>}
      {finished && tally.failed.length > 0 && <ul className="small">{tally.failed.slice(0, 20).map((f) => <li key={f.name}>{f.name}: {f.why}</li>)}</ul>}
      <div className="row end">
        {stage === 'choose' && <><button onClick={() => decide.current?.(null)}>Cancel</button>
          <button className="primary" onClick={() => decide.current?.(choice)}>{replacing ? `Continue, replacing ${replacing}` : 'Continue, keeping all'}</button></>}
        {(stage === 'scan' || stage === 'run') && <button onClick={() => { stop.current = true; }}>Stop</button>}
        {finished && <button className="primary" onClick={onClose}>Close</button>}
      </div>
    </Dialog>
  );
}
