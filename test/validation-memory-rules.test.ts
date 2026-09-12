/**
 * Memory-subsystem validation rule tests (#27, #41, #42, #44)
 *
 * Contracts under test:
 * - valid-managed-note-kind (#27): notes declaring palee_schema
 *   must carry exactly one recognized identity (palee_id, session_id,
 *   memory_id) or the index marker; ambiguity and conflicts warn.
 * - valid-session-schema (#41): canonical session notes need the
 *   required fields, completed/draft status coherent with the
 *   filename convention, matching session_id, and ordered ISO
 *   timestamps; malformed YAML is one error, never a skip.
 * - no-session-unknown-topic (#42): session topic_id must reference
 *   an existing topic (T-general included); shape-invalid sessions
 *   are #41's, skipped here.
 * - valid-session-index (#44): the index's session refs must point
 *   at confirmed sessions; corrupt index warns; missing index never
 *   reports; empty index is legal.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validManagedNoteKindRule } from '../src/validation/rules/valid-managed-note-kind';
import { validSessionSchemaRule } from '../src/validation/rules/valid-session-schema';
import { noSessionUnknownTopicRule } from '../src/validation/rules/no-session-unknown-topic';
import { validSessionIndexRule } from '../src/validation/rules/valid-session-index';
import type { ValidationContext } from '../src/validation/types';
import type { LoadedTopic } from '../src/storage/loader';
import type { LoadedSession, SessionIndexRead } from '../src/storage/sessions';
import type { ScannedNote } from '../src/types';

/** Minimal topic builder (kept for the unknown-topic rule). */
function makeTopic(overrides: Partial<LoadedTopic> = {}): LoadedTopic {
  return {
    palee_id: 'T-topic',
    id: 'T-topic',
    title: 'Topic',
    path: 'topic.md',
    filePath: '/vault/topic.md',
    content: '---\n---\n',
    frontmatter: {},
    difficulty: 'beginner',
    depends_on: [],
    topic_mastery: 0,
    status: 'not_started',
    ...overrides,
  };
}

/** Minimal scanned-note builder. */
function makeNote(overrides: Partial<ScannedNote> = {}): ScannedNote {
  return {
    absolutePath: '/vault/note.md',
    relativePath: 'note.md',
    frontmatter: {},
    ...overrides,
  };
}

/** The exact frontmatter writeSessionNote produces for a confirmed session. */
function confirmedFrontmatter(sessionId: string, topicId: string): Record<string, unknown> {
  return {
    palee_schema: 1,
    session_id: sessionId,
    topic_id: topicId,
    started_at: '2026-09-12T10:00:00.000Z',
    ended_at: '2026-09-12T10:30:00.000Z',
    status: 'completed',
    duration_minutes: 30,
  };
}

/** The exact frontmatter writeDraftCheckpoint produces. */
function draftFrontmatter(draftId: string, topicId: string): Record<string, unknown> {
  return {
    palee_schema: 1,
    session_id: draftId,
    topic_id: topicId,
    started_at: '2026-09-12T10:00:00.000Z',
    ended_at: null,
    status: 'draft',
  };
}

/** Session-note builder; defaults to a canonical confirmed session. */
function makeSession(overrides: Partial<LoadedSession> = {}): LoadedSession {
  const sessionId = overrides.sessionId ?? 'S-20260912T100000-abcd';
  return {
    sessionId,
    isDraft: sessionId.startsWith('DRAFT-'),
    path: `.palee/sessions/${sessionId}.md`,
    filePath: `/vault/.palee/sessions/${sessionId}.md`,
    frontmatter: confirmedFrontmatter(sessionId, 'T-topic'),
    ...overrides,
  };
}

/** Context builder with an empty memory subsystem by default. */
function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    vaultPath: '/vault',
    files: [],
    topics: [],
    notes: [],
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: { state: 'missing', frontmatter: null, body: '' },
    readIncomplete: false,
    ...overrides,
  };
}

describe('valid-managed-note-kind rule (#27)', () => {
  test('topic note with palee_id passes', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_schema: 1, palee_id: 'T-topic' } })],
    });
    assert.deepStrictEqual(validManagedNoteKindRule.run(context), []);
  });

  test('session and hot-memory identities pass', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 's.md', frontmatter: { palee_schema: 1, session_id: 'S-1' } }),
        makeNote({ relativePath: 'h.md', frontmatter: { palee_schema: 1, memory_id: 'H-active' } }),
      ],
    });
    assert.deepStrictEqual(validManagedNoteKindRule.run(context), []);
  });

  test('index marker passes', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_schema: 1, type: 'session_index' } })],
    });
    assert.deepStrictEqual(validManagedNoteKindRule.run(context), []);
  });

  test('palee_schema with no identity reports a warning', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'orphan.md', frontmatter: { palee_schema: 1, title: 'X' } })],
    });
    const issues = validManagedNoteKindRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-managed-note-kind');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].file, 'orphan.md');
    assert.strictEqual(issues[0].field, 'palee_schema');
  });

  test('conflicting identities (palee_id + session_id) report a warning', () => {
    const context = makeContext({
      notes: [
        makeNote({
          relativePath: 'conflict.md',
          frontmatter: { palee_schema: 1, palee_id: 'T-x', session_id: 'S-1' },
        }),
      ],
    });
    const issues = validManagedNoteKindRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].message, /conflicting identities/);
  });

  test('identity key plus index marker reports a warning', () => {
    const context = makeContext({
      notes: [
        makeNote({
          relativePath: 'both.md',
          frontmatter: { palee_schema: 1, memory_id: 'H-active', type: 'session_index' },
        }),
      ],
    });
    const issues = validManagedNoteKindRule.run(context);
    assert.strictEqual(issues.length, 1);
  });

  test('user notes without palee_schema are never reported', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 'plain.md', frontmatter: { title: 'My note' } }),
        makeNote({ relativePath: 'noparse.md', frontmatter: null, parseError: 'bad' }),
      ],
    });
    assert.deepStrictEqual(validManagedNoteKindRule.run(context), []);
  });

  test('findings sort by file path', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 'z.md', frontmatter: { palee_schema: 1 } }),
        makeNote({ relativePath: 'a.md', frontmatter: { palee_schema: 1 } }),
      ],
    });
    const issues = validManagedNoteKindRule.run(context);
    assert.deepStrictEqual(issues.map((i) => i.file), ['a.md', 'z.md']);
  });

  test('rule metadata: id, warning severity, manual fixability', () => {
    assert.strictEqual(validManagedNoteKindRule.id, 'valid-managed-note-kind');
    assert.strictEqual(validManagedNoteKindRule.severity, 'warning');
    assert.strictEqual(validManagedNoteKindRule.fixable, 'manual');
  });
});

describe('valid-session-schema rule (#41)', () => {
  test('canonical completed session passes', () => {
    const context = makeContext({ sessions: [makeSession()] });
    assert.deepStrictEqual(validSessionSchemaRule.run(context), []);
  });

  test('canonical draft session passes', () => {
    const draft = makeSession({
      sessionId: 'DRAFT-S-1a2b3c4d',
      isDraft: true,
      frontmatter: draftFrontmatter('DRAFT-S-1a2b3c4d', 'T-topic'),
    });
    const context = makeContext({ sessions: [draft] });
    assert.deepStrictEqual(validSessionSchemaRule.run(context), []);
  });

  test('empty memory subsystem (fresh vault) passes', () => {
    assert.deepStrictEqual(validSessionSchemaRule.run(makeContext()), []);
  });

  test('malformed YAML reports one error, never skips the note', () => {
    const broken = makeSession({ frontmatter: null, parseError: 'bad yaml' });
    const context = makeContext({ sessions: [broken] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-session-schema');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].file, broken.path);
    assert.match(issues[0].message, /bad yaml/);
  });

  test('missing required fields report one error per field', () => {
    const stripped = makeSession({
      frontmatter: { palee_schema: 1, status: 'completed' },
    });
    const context = makeContext({ sessions: [stripped] });
    const issues = validSessionSchemaRule.run(context);
    // session_id, topic_id, started_at, ended_at all missing
    assert.strictEqual(issues.length, 4);
    assert.deepStrictEqual(
      issues.map((i) => i.field),
      ['session_id', 'topic_id', 'started_at', 'ended_at']
    );
  });

  test('session_id not matching the filename stem reports an error', () => {
    const mismatch = makeSession({
      frontmatter: { ...confirmedFrontmatter('S-OTHER', 'T-topic') },
    });
    const context = makeContext({ sessions: [mismatch] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'session_id');
    assert.match(issues[0].message, /does not match the filename stem/);
  });

  test('invalid status reports an error', () => {
    const bad = makeSession({
      frontmatter: { ...confirmedFrontmatter('S-20260912T100000-abcd', 'T-topic'), status: 'finished' },
    });
    const context = makeContext({ sessions: [bad] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'status');
  });

  test('completed status in a DRAFT- file conflicts with the filename convention', () => {
    const conflict = makeSession({
      sessionId: 'DRAFT-S-1a2b3c4d',
      isDraft: true,
      frontmatter: { ...confirmedFrontmatter('DRAFT-S-1a2b3c4d', 'T-topic') },
    });
    const context = makeContext({ sessions: [conflict] });
    const issues = validSessionSchemaRule.run(context);
    // status 'completed' in a DRAFT file: allowed-value check passes,
    // convention check fires; ended_at is a valid timestamp so no
    // third finding.
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].message, /conflicts with the DRAFT-/);
  });

  test('draft status in an S- file conflicts with the filename convention', () => {
    const conflict = makeSession({
      sessionId: 'S-20260912T100000-abcd',
      isDraft: false,
      frontmatter: draftFrontmatter('S-20260912T100000-abcd', 'T-topic'),
    });
    const context = makeContext({ sessions: [conflict] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].message, /conflicts with the S-/);
  });

  test('draft with non-null ended_at reports an error', () => {
    const bad = makeSession({
      sessionId: 'DRAFT-S-1a2b3c4d',
      isDraft: true,
      frontmatter: {
        ...draftFrontmatter('DRAFT-S-1a2b3c4d', 'T-topic'),
        ended_at: '2026-09-12T10:30:00.000Z',
      },
    });
    const context = makeContext({ sessions: [bad] });
    const issues = validSessionSchemaRule.run(context);
    // ended_at present and parseable but the draft contract expects
    // null — reported via the draft-convention mismatch only when
    // status is draft in a DRAFT file... here ended_at is a timestamp
    // in a draft: reported as ended_at must be null? The rule reports
    // a draft with a non-null ended_at as an ended_at shape error.
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'ended_at');
  });

  test('completed session with null ended_at reports an error', () => {
    const bad = makeSession({
      frontmatter: { ...confirmedFrontmatter('S-20260912T100000-abcd', 'T-topic'), ended_at: null },
    });
    const context = makeContext({ sessions: [bad] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'ended_at');
  });

  test('ended_at before started_at reports the inversion', () => {
    const bad = makeSession({
      frontmatter: {
        ...confirmedFrontmatter('S-20260912T100000-abcd', 'T-topic'),
        started_at: '2026-09-12T11:00:00.000Z',
        ended_at: '2026-09-12T10:00:00.000Z',
      },
    });
    const context = makeContext({ sessions: [bad] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].message, /precedes started_at/);
  });

  test('unparseable timestamp reports an error', () => {
    const bad = makeSession({
      frontmatter: {
        ...confirmedFrontmatter('S-20260912T100000-abcd', 'T-topic'),
        started_at: 'yesterday',
      },
    });
    const context = makeContext({ sessions: [bad] });
    const issues = validSessionSchemaRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'started_at');
  });

  test('rule metadata: id, error severity, manual fixability', () => {
    assert.strictEqual(validSessionSchemaRule.id, 'valid-session-schema');
    assert.strictEqual(validSessionSchemaRule.severity, 'error');
    assert.strictEqual(validSessionSchemaRule.fixable, 'manual');
  });
});

describe('no-session-unknown-topic rule (#42)', () => {
  test('session referencing an existing topic passes', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-topic', id: 'T-topic' })],
      sessions: [makeSession()],
    });
    assert.deepStrictEqual(noSessionUnknownTopicRule.run(context), []);
  });

  test('empty memory subsystem passes', () => {
    assert.deepStrictEqual(noSessionUnknownTopicRule.run(makeContext()), []);
  });

  test('session with unknown topic reports a warning with the session and topic IDs', () => {
    const context = makeContext({
      topics: [],
      sessions: [makeSession({
        sessionId: 'S-1',
        frontmatter: confirmedFrontmatter('S-1', 'T-missing'),
      })],
    });
    const issues = noSessionUnknownTopicRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'no-session-unknown-topic');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].sessionId, 'S-1');
    assert.strictEqual(issues[0].topicId, 'T-missing');
    assert.strictEqual(issues[0].details?.topicId, 'T-missing');
  });

  test('phantom T-general session reports like any other unknown topic', () => {
    const context = makeContext({
      topics: [],
      sessions: [makeSession({ frontmatter: confirmedFrontmatter('S-1', 'T-general') })],
    });
    const issues = noSessionUnknownTopicRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-general');
  });

  test('T-general passes when a real topic with that ID exists', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-general', id: 'T-general' })],
      sessions: [makeSession({ frontmatter: confirmedFrontmatter('S-1', 'T-general') })],
    });
    assert.deepStrictEqual(noSessionUnknownTopicRule.run(context), []);
  });

  test('shape-invalid sessions are skipped (no double-reporting with #41)', () => {
    const context = makeContext({
      topics: [],
      sessions: [
        makeSession({ frontmatter: null, parseError: 'bad yaml' }),
        makeSession({ frontmatter: { palee_schema: 1, session_id: 'S-1', started_at: 'x', ended_at: null, status: 'draft' } }), // no topic_id
        makeSession({ frontmatter: { ...confirmedFrontmatter('S-2', 'T-x'), topic_id: 42 } }), // non-string topic_id
      ],
    });
    assert.deepStrictEqual(noSessionUnknownTopicRule.run(context), []);
  });

  test('draft sessions follow the same policy', () => {
    const draft = makeSession({
      sessionId: 'DRAFT-S-1a2b3c4d',
      isDraft: true,
      frontmatter: draftFrontmatter('DRAFT-S-1a2b3c4d', 'T-ghost'),
    });
    const context = makeContext({ topics: [], sessions: [draft] });
    const issues = noSessionUnknownTopicRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-ghost');
  });

  test('rule metadata: id, warning severity, manual fixability', () => {
    assert.strictEqual(noSessionUnknownTopicRule.id, 'no-session-unknown-topic');
    assert.strictEqual(noSessionUnknownTopicRule.severity, 'warning');
    assert.strictEqual(noSessionUnknownTopicRule.fixable, 'manual');
  });
});

describe('valid-session-index rule (#44)', () => {
  test('missing index never reports (fresh vault / rebuildable projection)', () => {
    const context = makeContext();
    assert.deepStrictEqual(validSessionIndexRule.run(context), []);
  });

  test('valid index referencing existing confirmed sessions passes', () => {
    const context = makeContext({
      sessions: [makeSession({ sessionId: 'S-1' }), makeSession({ sessionId: 'S-2' })],
      sessionIndex: { state: 'ok', refs: ['S-1', 'S-2'] } as SessionIndexRead,
    });
    assert.deepStrictEqual(validSessionIndexRule.run(context), []);
  });

  test('index reference to a missing confirmed session reports a warning', () => {
    const context = makeContext({
      sessions: [makeSession({ sessionId: 'S-1' })],
      sessionIndex: { state: 'ok', refs: ['S-1', 'S-gone'] } as SessionIndexRead,
    });
    const issues = validSessionIndexRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-session-index');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].file, '.palee/index.md');
    assert.strictEqual(issues[0].details?.missingSession, 'S-gone');
  });

  test('index reference to a draft session is unknown (drafts are never indexed)', () => {
    const draft = makeSession({
      sessionId: 'DRAFT-S-1a2b3c4d',
      isDraft: true,
      frontmatter: draftFrontmatter('DRAFT-S-1a2b3c4d', 'T-topic'),
    });
    const context = makeContext({
      sessions: [draft],
      sessionIndex: { state: 'ok', refs: ['DRAFT-S-1a2b3c4d'] } as SessionIndexRead,
    });
    const issues = validSessionIndexRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.missingSession, 'DRAFT-S-1a2b3c4d');
  });

  test('empty index is legal even when sessions exist (staleness deferred)', () => {
    const context = makeContext({
      sessions: [makeSession({ sessionId: 'S-1' })],
      sessionIndex: { state: 'ok', refs: [] } as SessionIndexRead,
    });
    assert.deepStrictEqual(validSessionIndexRule.run(context), []);
  });

  test('corrupt index reports one warning with the parser error', () => {
    const context = makeContext({
      sessionIndex: { state: 'corrupt', refs: null, parseError: 'unclosed fence' },
    });
    const issues = validSessionIndexRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].severity, 'warning');
    assert.match(issues[0].message, /unclosed fence/);
  });

  test('multiple unknown refs each report', () => {
    const context = makeContext({
      sessionIndex: { state: 'ok', refs: ['S-x', 'S-y'] } as SessionIndexRead,
    });
    const issues = validSessionIndexRule.run(context);
    assert.strictEqual(issues.length, 2);
    assert.deepStrictEqual(
      issues.map((i) => i.details?.missingSession),
      ['S-x', 'S-y']
    );
  });

  test('rule metadata: id, warning severity, safe fixability (rebuildable)', () => {
    assert.strictEqual(validSessionIndexRule.id, 'valid-session-index');
    assert.strictEqual(validSessionIndexRule.severity, 'warning');
    assert.strictEqual(validSessionIndexRule.fixable, 'safe');
  });
});
