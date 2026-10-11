/**
 * Shared managed-note predicate (#324)
 *
 * Contracts under test — the ONE definition all three managed-note gates
 * consume, keyed on the identity key being present:
 * - `isManagedNote`: an identity key (`palee_id`/`session_id`/`memory_id`) OR
 *   `type: "session_index"` is present; presence alone (value type ignored).
 * - `isTopicNote`: exactly one identity key and it is `palee_id`, and not the
 *   index — so a `palee_schema`-only note is NOT a topic note (the #324 false
 *   positive) and a conflicting note is not a clean topic either.
 * - `presentIdentityKeys` / `PALEE_IDENTITY_KEYS`: the single managed-key set,
 *   no per-rule re-declaration.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  PALEE_IDENTITY_KEYS,
  TOPIC_IDENTITY_KEY,
  SESSION_INDEX_TYPE,
  presentIdentityKeys,
  hasSessionIndexMarker,
  isManagedNote,
  isTopicNote,
} from '../src/validation/managed-note';

describe('shared managed-note predicate (#324)', () => {
  test('the managed-key set is exactly the three identity keys', () => {
    assert.deepStrictEqual([...PALEE_IDENTITY_KEYS], ['palee_id', 'session_id', 'memory_id']);
    assert.strictEqual(TOPIC_IDENTITY_KEY, 'palee_id');
    assert.strictEqual(SESSION_INDEX_TYPE, 'session_index');
  });

  test('isTopicNote requires the palee_id identity and no other kind', () => {
    assert.strictEqual(isTopicNote({ palee_id: 'T-a' }), true);
    assert.strictEqual(isTopicNote({ palee_schema: 1, palee_id: 'T-a' }), true);
    // Malformed values keep the key present, so still a topic note to judge.
    assert.strictEqual(isTopicNote({ palee_id: 123 }), true);
    assert.strictEqual(isTopicNote({ palee_id: null }), true);
    // #324: the schema marker alone is NOT a topic note.
    assert.strictEqual(isTopicNote({ palee_schema: 1 }), false);
    assert.strictEqual(isTopicNote({ palee_schema: 1, title: 'No ID' }), false);
    // Other kinds and index are never topics.
    assert.strictEqual(isTopicNote({ session_id: 'S-1' }), false);
    assert.strictEqual(isTopicNote({ memory_id: 'H-active' }), false);
    assert.strictEqual(isTopicNote({ palee_schema: 1, type: 'session_index' }), false);
    // Conflicting kinds are not a clean topic either (the kind rule owns them).
    assert.strictEqual(isTopicNote({ palee_id: 'T-a', session_id: 'S-1' }), false);
    assert.strictEqual(isTopicNote({ palee_id: 'T-a', type: 'session_index' }), false);
  });

  test('isManagedNote is identity-present OR session-index', () => {
    assert.strictEqual(isManagedNote({ palee_id: 'T-a' }), true);
    assert.strictEqual(isManagedNote({ session_id: 'S-1' }), true);
    assert.strictEqual(isManagedNote({ memory_id: 'H-active' }), true);
    assert.strictEqual(isManagedNote({ type: 'session_index' }), true);
    // Value type ignored: malformed identity is still managed data.
    assert.strictEqual(isManagedNote({ palee_id: null }), true);
    assert.strictEqual(isManagedNote({ session_id: ['S-1'] }), true);
    // #324: a bare schema marker is NOT managed for the schema/id gates.
    assert.strictEqual(isManagedNote({ palee_schema: 1 }), false);
    assert.strictEqual(isManagedNote({ title: 'user note' }), false);
  });

  test('presentIdentityKeys reports presence, not value', () => {
    assert.deepStrictEqual(presentIdentityKeys({ palee_schema: 1 }), []);
    assert.deepStrictEqual(presentIdentityKeys({ palee_id: 'T-a', session_id: 'S-1' }), [
      'palee_id',
      'session_id',
    ]);
    assert.deepStrictEqual(presentIdentityKeys({ memory_id: null }), ['memory_id']);
  });

  test('hasSessionIndexMarker keys only on the type value', () => {
    assert.strictEqual(hasSessionIndexMarker({ type: 'session_index' }), true);
    assert.strictEqual(hasSessionIndexMarker({ type: 'other' }), false);
    assert.strictEqual(hasSessionIndexMarker({}), false);
  });
});
