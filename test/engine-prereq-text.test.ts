import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  extractDeclaredPrerequisites,
  resolveDeclaredPrerequisites,
  type DeclaredPrereqRef,
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
    // The destination survives whole: the directory is what makes `README.md`
    // here mean one note rather than the two the vault holds.
    assert.deepStrictEqual(refs, [{ name: '../1-Clustering/README.md', form: 'mdlink' }]);
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

  test('extracts links under ## Depends on and ## Required knowledge headings', () => {
    const refs = extractDeclaredPrerequisites([
      '## Depends on',
      '- [[01-foundations]]',
      '',
      '## Required knowledge',
      '- [[02-intro]]',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.name), ['01-foundations', '02-intro']);
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

  test('a negated requirement declares nothing', () => {
    // The worst invention available: the author says the note is *not* needed,
    // and a gate would lock the learner behind precisely that note.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('This lesson does not require Setup.\n'),
      []
    );
    assert.deepStrictEqual(extractDeclaredPrerequisites('Without Gradient Descent, skip this.\n'), []);
    // The negation is bounded by the sentence or contrastive clause, so a later clause still counts.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('No calculator is needed. It requires Matrices.\n'),
      [{ name: 'Matrices', form: 'prose' }]
    );
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('No calculator is needed, but this lesson requires Matrices.\n'),
      [{ name: 'Matrices', form: 'prose' }]
    );
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('No calculator is needed; this lesson requires Matrices.\n'),
      [{ name: 'Matrices', form: 'prose' }]
    );
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('No calculator is needed, yet this lesson requires Matrices.\n'),
      [{ name: 'Matrices', form: 'prose' }]
    );
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('No calculator is needed, but this lesson does not require Setup.\n'),
      []
    );
  });

  test('a requires phrase inside a task item declares nothing', () => {
    // The section scanner declines checkboxes; the prose scan must too, or
    // `- [ ] requires knowledge of Setup` gates on a to-do nobody has done.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('# Lesson\n\n- [ ] requires knowledge of Setup\n'),
      []
    );
  });

  test('uncapitalized prose objects are dropped, as the measured corpora require', () => {
    // Run over 11,168 notes in two Azure curricula, every prose candidate that
    // named no existing note began lower-case, and every note name those same
    // sections linked was capitalized. These are the strings that run produced;
    // they live here so the screen cannot quietly loosen back into noise.
    const corpus = [
      'This lesson requires careful scrutiny of the sources.',
      'Requires attention to detail throughout.',
      'It requires more complex implementation than the last lesson.',
      'Requires identifying which data must persist versus transient state.',
      'Requires organized file structures across the project.',
      'This requires careful condition management.',
    ].join('\n');
    assert.deepStrictEqual(extractDeclaredPrerequisites(corpus), []);

    // The shape that does pay keeps working.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('This lesson requires knowledge of Gradient Descent.\n'),
      [{ name: 'Gradient Descent', form: 'prose' }]
    );
  });

  test('the same note declared twice becomes one edge', () => {
    // Two forms of one name stay two *references* — a wikilink and a prose
    // mention resolve by different rules, so they must not be merged before
    // resolution — but resolution deduplicates by target, so one note is one
    // predecessor.
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [[Setup]]',
      '- [[setup]]',
      'It requires Setup.',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.form), ['wikilink', 'prose']);

    const { resolved } = resolveDeclaredPrerequisites(refs, (ref) =>
      ref.form === 'wikilink' ? ['/vault/setup.md'] : []
    );
    assert.deepStrictEqual(resolved, [{ name: 'Setup', target: '/vault/setup.md' }]);
  });
});

describe('declared-prerequisite resolution (PAL-205 WS6)', () => {
  const index = new Map<string, string[]>([
    ['setup', ['/vault/01-setup.md']],
    ['quiz', ['/vault/a/quiz.md', '/vault/b/quiz.md']],
  ]);
  const lookup = (ref: DeclaredPrereqRef): string[] =>
    ref.form === 'prose' ? [] : index.get(ref.name.toLowerCase().trim()) ?? [];

  test('a unique hit becomes an edge', () => {
    const { resolved, skipped } = resolveDeclaredPrerequisites(
      [{ name: 'setup', form: 'wikilink' }],
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
        { name: 'nothing-here', form: 'wikilink' },
        { name: 'Quiz', form: 'wikilink' },
      ],
      lookup
    );
    assert.deepStrictEqual(resolved, []);
    assert.deepStrictEqual(skipped, [
      { name: 'nothing-here', reason: 'missing' },
      { name: 'Quiz', reason: 'ambiguous' },
    ]);
  });

  test('the lookup receives the form, not just the name', () => {
    // A markdown link resolves against its note's directory and a bare prose
    // name against an index. Handed the name alone, the caller cannot tell the
    // two apart, and folding one way through the other is how `x1/README.md`
    // became the ambiguous basename `README`.
    const seen: string[] = [];
    resolveDeclaredPrerequisites(
      [
        { name: 'x1/README.md', form: 'mdlink' },
        { name: 'Setup', form: 'prose' },
        { name: 'm/01-a', form: 'wikilink' },
      ],
      (ref) => {
        seen.push(`${ref.form}:${ref.name}`);
        return [];
      }
    );
    assert.deepStrictEqual(seen, ['mdlink:x1/README.md', 'prose:Setup', 'wikilink:m/01-a']);
  });

  test('the same target reported twice is not ambiguity', () => {
    const { resolved, skipped } = resolveDeclaredPrerequisites(
      [{ name: 'dup', form: 'wikilink' }],
      () => ['/vault/x.md', '/vault/x.md']
    );
    assert.deepStrictEqual(resolved, [{ name: 'dup', target: '/vault/x.md' }]);
    assert.deepStrictEqual(skipped, []);
  });

  test('fan-in keeps every unique hit and each target once', () => {
    const { resolved } = resolveDeclaredPrerequisites(
      [
        { name: 'setup', form: 'wikilink' },
        { name: 'Setup', form: 'mdlink' },
        { name: 'lecture', form: 'wikilink' },
      ],
      (ref) =>
        ref.name.toLowerCase() === 'setup' && ref.form === 'wikilink'
          ? ['/vault/01-setup.md']
          : ref.name === 'lecture'
            ? ['/vault/02.md']
            : []
    );
    assert.deepStrictEqual(resolved.map((r) => r.target), ['/vault/01-setup.md', '/vault/02.md']);
  });
});
