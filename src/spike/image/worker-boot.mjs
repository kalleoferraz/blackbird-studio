// Dev only: lets the worker thread import TypeScript when the app runs under tsx (npm run dev / tsx watch).
// A worker does not get tsx's `.js` -> `.ts` import mapping on its own (found in the spike), so this
// plain-JavaScript entry registers tsx first and then loads worker.ts. After `npm run build` the pool
// starts worker.js directly and this file is not used.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
