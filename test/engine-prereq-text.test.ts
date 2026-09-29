import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  extractDeclaredPrerequisites,
  resolveDeclaredPrerequisites,
} from '../src/engine/prereq-text';

/**
 * A note that writes its own prerequisites is making an author statement, the
 * same class as hand-typed `depends_on`. Everything downstream — that these
 * edges gate, that an inferred edge yields to them — rests on this extraction,
 * so each rule here is a rule about which sentences are allowed to lock a
 * learner out of a note.
 */
describe('declared-prerequisite extraction (PAL-205 WS6)', () => {
  test('reads a markdown link out of a Prerequisites section', () => {
    // The ML-For-Beginners shape: the section is prose plus one link to the
    // lesson before it, and the link's destination basename is the name.
    const refs = extractDeclaredPrerequisites([
      '# K-Means clustering',
      '',
      'In this lesson we cluster without labels.',
      '',
      '## Prerequisites',
      '',
      '[previous lesson quiz](../1-Clustering/README.md)',
      '',
      '## License',
      '',
      'MIT',
      '',
    ].join('\n'));
    assert.deepStrictEqual(refs, [{ name: 'README', form: 'link' }]);
  });

  test('reads wikilinks and bare names from a bulleted section', () => {
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [[MODULES/01-foundations/01-a|Linear regression]]',
      '2. [[02-b]]',
      '- a plain bullet that is not a link',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.name), ['MODULES/01-foundations/01-a', '02-b']);
  });

  test('a Prerequisites block inside a fenced example declares nothing', () => {
    // This is how a course teaches its own template. Reading it would hand the
    // example's fictional prerequisite a real, gating edge.
    const refs = extractDeclaredPrerequisites([
      '## Course template',
      '',
      '```markdown',
      '## Prerequisites',
      '- [[made-up-note]]',
      '```',
    ].join('\n'));
    assert.deepStrictEqual(refs, []);
  });

  test('the section ends at the next heading of any level', () => {
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [[real-one]]',
      '### Details',
      '- [[not-a-prerequisite]]',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.name), ['real-one']);
  });

  test('a heading that only starts with the trigger phrase is not a prerequisites section', () => {
    // `## Prerequisites for the lab` introduces lab setup, not a dependency list.
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites for the lab',
      '- [[lab-hardware]]',
    ].join('\n'));
    assert.deepStrictEqual(refs, []);
  });

  test('reads a requires phrase from prose', () => {
    const refs = extractDeclaredPrerequisites(
      'You will need the earlier material.\nThis lesson requires knowledge of Gradient Descent.\n'
    );
    assert.deepStrictEqual(refs, [{ name: 'Gradient Descent', form: 'prose' }]);
  });

  test('rejects a requires object that begins a clause rather than a name', () => {
    const refs = extractDeclaredPrerequisites([
      'It requires a working knowledge of the material before you start.',
      'This requires patience and practice.',
    ].join('\n'));
    assert.deepStrictEqual(refs, []);
  });

  test('task-list checkboxes and escaped links do not count', () => {
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [ ] [[unfinished-todo]]',
      '\\[[escaped-example]]',
      '- [[genuine]]',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.name), ['genuine']);
  });

  test('repeated names collapse to one reference', () => {
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [[Setup]]',
      '- [[setup]]',
      'It requires Setup.',
    ].join('\n'));
    assert.strictEqual(refs.length, 1);
  });
});

describe('declared-prerequisite resolution (PAL-205 WS6)', () => {
  const index = new Map<string, string[]>([
    ['setup', ['/vault/01-setup.md']],
    ['quiz', ['/vault/a/quiz.md', '/vault/b/quiz.md']],
  ]);
  const lookup = (name: string): string[] => index.get(name.toLowerCase().trim()) ?? [];

  test('a unique hit becomes an edge', () => {
    const { resolved, skipped } = resolveDeclaredPrerequisites(
      [{ name: 'setup', form: 'link' }],
      lookup
    );
    assert.deepStrictEqual(resolved, [{ name: 'setup', target: '/vault/01-setup.md' }]);
    assert.deepStrictEqual(skipped, []);
  });

  test('a missing name and an ambiguous one are counted skips, not failures', () => {
    // Under-chaining is the safe direction: a wrong guess would gate a learner
    // behind a note nobody said, while a missed edge leaves the numbered tree's.
    const { resolved, skipped } = resolveDeclaredPrerequisites(
      [
        { name: 'nothing-here', form: 'prose' },
        { name: 'Quiz', form: 'link' },
      ],
      lookup
    );
    assert.deepStrictEqual(resolved, []);
    assert.deepStrictEqual(skipped, [
      { name: 'nothing-here', reason: 'missing' },
      { name: 'Quiz', reason: 'ambiguous' },
    ]);
  });

  test('the same target reported twice is not ambiguity', () => {
    const { resolved, skipped } = resolveDeclaredPrerequisites(
      [{ name: 'dup', form: 'link' }],
      () => ['/vault/x.md', '/vault/x.md']
    );
    assert.deepStrictEqual(resolved, [{ name: 'dup', target: '/vault/x.md' }]);
    assert.deepStrictEqual(skipped, []);
  });

  test('fan-in keeps every unique hit and each target once', () => {
    const { resolved } = resolveDeclaredPrerequisites(
      [
        { name: 'setup', form: 'link' },
        { name: 'Setup', form: 'prose' },
        { name: 'lecture', form: 'link' },
      ],
      (name) => (name === 'setup' ? ['/vault/01-setup.md'] : name === 'lecture' ? ['/vault/02.md'] : [])
    );
    assert.deepStrictEqual(resolved.map((r) => r.target), ['/vault/01-setup.md', '/vault/02.md']);
  });
});
