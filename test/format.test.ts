import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueCountOrder, inOrder } from '../web/src/format.ts';

const cs = [{ id: 'n', cueCount: 3 }, { id: 'm', cueCount: 9 }, { id: 't', cueCount: 3 }, { id: 'z', cueCount: 0 }];

test('characters are ordered by number of cues, ties in creation order', () => {
  assert.deepEqual(cueCountOrder(cs), ['m', 'n', 't', 'z']);
  assert.deepEqual(cueCountOrder([{ id: 'a' }, { id: 'b' }]), ['a', 'b']); // no counts: creation order
});

test('the remembered order holds while counts and members change', () => {
  const ids = cueCountOrder(cs);
  const later = [{ id: 'n', cueCount: 50 }, { id: 'm', cueCount: 1 }, { id: 't', cueCount: 3 }, { id: 'z', cueCount: 0 }, { id: 'new' }];
  assert.deepEqual(inOrder(later, ids).map((c) => c.id), ['m', 'n', 't', 'z', 'new']); // new one last, no re-sort
  assert.deepEqual(inOrder(later.filter((c) => c.id !== 'n'), ids).map((c) => c.id), ['m', 't', 'z', 'new']); // removed one dropped
});
