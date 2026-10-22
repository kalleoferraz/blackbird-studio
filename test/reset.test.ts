import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertWipeableRoot, emptyLibrary, markerPath } from '../src/db/reset.js';

describe('one-time reset helpers', () => {
  it('refuses a folder that is not named library, or is too shallow', () => {
    assert.throws(() => assertWipeableRoot('/private'));
    assert.throws(() => assertWipeableRoot('/library'));
    assert.throws(() => assertWipeableRoot('/'));
    assert.throws(() => assertWipeableRoot('/home/me/projects'));
    assert.doesNotThrow(() => assertWipeableRoot('/private/library'));
  });

  it('empties the library but keeps the folder, and the marker sits outside it', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'reset-'));
    try {
      const root = path.join(base, 'library');
      mkdirSync(path.join(root, 'p1', 'audio'), { recursive: true });
      writeFileSync(path.join(root, 'p1', 'audio', 'a.wav'), 'x');
      writeFileSync(path.join(root, 'cover.jpg'), 'x');
      assert.equal(emptyLibrary(root), 2);
      assert.ok(existsSync(root));
      assert.equal(emptyLibrary(root), 0);
      assert.equal(path.dirname(markerPath(root, '2026-10-22')), base);
      assert.equal(path.basename(markerPath(root, 'a/b c')), '.reset-a_b_c');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does nothing for a missing library folder', () => {
    assert.equal(emptyLibrary(path.join(tmpdir(), 'no-such-dir-xyz', 'library')), 0);
  });
});
