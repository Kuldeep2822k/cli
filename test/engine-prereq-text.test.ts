import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  declaredPrereqCue,
  extractDeclaredPrerequisites,
  resolveDeclaredPrerequisites,
  type DeclaredPrereqRef,
} from '../src/engine/prereq-text';

/**
 * A note that writes its own prerequisites is making an author statement, the
 * same class as hand-typed `depends_on`. Everything downstream — that these
 * edges gate, that an inferred edge yields to them — rests on this extraction,
 * so each rule here is a rule about which statements are allowed to lock a
 * learner out of a note. Only links are.
 */
describe('declared-prerequisite extraction (PAL-205 WS6)', () => {
  test('reads a markdown link out of a Prerequisites section', () => {
    // The ML-For-Beginners shape: the section is prose plus one link to the
    // lesson before it, and the link's destination is the reference.
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

  test('reads wikilinks from a bulleted section and ignores a plain bullet', () => {
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

  test('task-list checkboxes and escaped links do not count', () => {
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [ ] [[unfinished-todo]]',
      '\\[[escaped-example]]',
      '- [[genuine]]',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.name), ['genuine']);
  });

  test('a sentence never declares a prerequisite, linked or not', () => {
    // Deliberately the load-bearing test of this module's scope. An earlier
    // revision read `requires X` phrases out of prose and had to grow clause,
    // aside and negation analysis to stop the false gates it invented; measured
    // over 11,168 notes in two Azure curricula it produced no edge at all, while
    // every real one came from a link. These strings are what that scan either
    // misread or was written to catch — under the current scope all of them
    // declare nothing, and a prose scanner added back would fail here.
    const sentences = [
      'This lesson requires knowledge of Gradient Descent.',
      'Requires attention to detail throughout.',
      'It requires more complex implementation than the last lesson.',
      'Requires identifying which data must persist versus transient state.',
      'This lesson does not require Setup.',
      'This lesson no longer requires Setup.',
      'This lesson does not, and it bears repeating, require Setup.',
      'This lesson does not need a calculator, but for the lab, it requires Setup.',
      'This lesson does not, under any circumstances, when it is hard, require Setup.',
      'No lesson requires Setup.',
    ].join('\n');
    assert.deepStrictEqual(extractDeclaredPrerequisites(sentences), []);

    // Not even inside a Prerequisites section, where the heading would make a
    // bare word look intentional: `- Setup` names nothing the engine can resolve
    // without guessing at a basename, and guessing is what this cut removes.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites(['## Prerequisites', '', 'Requires Setup.', '- Setup'].join('\n')),
      []
    );

    // #261: the same three sentences with a heading above them *and* the note
    // name written as a link. That is the shape that actually occurs in a lesson,
    // and it was never pinned — this test held the negations in prose, where the
    // section branch never fires, so the branch that gated survived the suite.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites(
        [
          '## Prerequisites',
          '',
          '- This lesson does not require [[Setup]].',
          '- This lesson no longer requires [[Quiz]].',
          '- No lesson requires [[Nothing]].',
        ].join('\n')
      ),
      []
    );
  });

  test('a requires heading that only holds prose declares nothing', () => {
    // The heading is a trigger, not a licence: what follows still has to be a
    // link for anything to be read.
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('# Lesson\n\n## Requires\n\n- [ ] requires knowledge of Setup\n'),
      []
    );
  });

  test('the same note declared twice becomes one edge', () => {
    // Two forms of one name stay two *references* — a wikilink and a markdown
    // link resolve by different rules, so they must not be merged before
    // resolution — but resolution deduplicates by target, so one note is one
    // predecessor.
    const refs = extractDeclaredPrerequisites([
      '## Prerequisites',
      '- [[Setup]]',
      '- [[setup]]',
      '- [Setup again](../01-foundations/setup.md)',
    ].join('\n'));
    assert.deepStrictEqual(refs.map((r) => r.form), ['wikilink', 'mdlink']);

    const { resolved } = resolveDeclaredPrerequisites(refs, (ref) =>
      ref.form === 'wikilink' ? ['/vault/setup.md'] : []
    );
    assert.deepStrictEqual(resolved, [{ name: 'Setup', target: '/vault/setup.md' }]);
  });
});

describe('prerequisite-section cues (#261)', () => {
  // Every item below sits under a real `## Prerequisites` heading, because that
  // is the branch that authors an edge. The section scan took any link it found
  // and labelled the result `declared`, which gates, so an ordinary sentence
  // under the heading locked a learner out: `palee plan --json` returned only
  // Setup for a note that said `does not require [[m/01-setup]]` and
  // `no longer requires [[m/02-alpha]]` — the two notes the author disclaimed
  // were the two that got gated behind.
  const section = (...items: string[]): string => ['## Prerequisites', '', ...items.map((i) => `- ${i}`)].join('\n');

  const names = (items: string[]): string[] =>
    extractDeclaredPrerequisites(section(...items)).map((r) => r.name);

  test('a negated item declares nothing', () => {
    // Gating behind a note the author ruled out is the worst invention
    // available, and #232 already said so about the prose branch. The same
    // vocabulary governs here: `not`, `n't`, `no longer`, `never`, `cannot`,
    // `neither`, `nor`, `without`, and a negative subject opening the item.
    assert.deepStrictEqual(names(['does not require [[m/01-setup]]']), []);
    assert.deepStrictEqual(names(['no longer requires [[m/01-setup]]']), []);
    assert.deepStrictEqual(names(["doesn't require [[m/01-setup]]"]), []);
    assert.deepStrictEqual(names(['never required [[m/01-setup]]']), []);
    assert.deepStrictEqual(names(['cannot be assumed alongside [[m/01-setup]]']), []);
    assert.deepStrictEqual(names(['No prior knowledge of [[m/01-setup]] is needed']), []);
    assert.deepStrictEqual(names(['[[m/01-setup]] is not a prerequisite']), []);
  });

  test('a disjunctive item declares nothing, in either direction', () => {
    // `or` offers the learner a choice; `areDependenciesSatisfied` only knows
    // AND. Gating on both links is wrong, and gating on either would need new
    // semantics, so the item contributes no edge at all.
    assert.deepStrictEqual(names(['requires [[m/01-setup]] or [[m/02-alpha]]']), []);
    assert.deepStrictEqual(names(['either [[m/01-setup]] or [[m/02-alpha]]']), []);
    assert.deepStrictEqual(names(['[[m/01-setup]] and/or [[m/02-alpha]]']), []);
  });

  test('a reversed item declares nothing', () => {
    // Not a denial but the other direction: the note is saying that *it* is a
    // prerequisite for the link. Reading it as `this note depends on X` is a
    // invented gate, and authoring the reverse edge is out of scope, so the
    // item is refused outright.
    assert.deepStrictEqual(names(['This note is a prerequisite for [[m/02-alpha]]']), []);
    assert.deepStrictEqual(names(['[[m/02-alpha]] is required by this note']), []);
    assert.deepStrictEqual(names(['[[m/02-alpha]] requires this note']), []);
    assert.deepStrictEqual(names(['[[m/02-alpha]] depends on this lesson']), []);
  });

  test('an HTML comment and an inline code span declare nothing', () => {
    // Fenced code was already blanked, and for the reason that covers both of
    // these: a link written to be read is not a link written to be followed.
    assert.deepStrictEqual(extractDeclaredPrerequisites('## Prerequisites\n\n<!-- [[m/01-setup]] -->\n'), []);
    assert.deepStrictEqual(names(['write `[[m/01-setup]]` to depend on Setup']), []);
    assert.deepStrictEqual(names(['see `[setup](m/01-setup.md)`']), []);
  });

  test('an unambiguous item still authors its gating edge', () => {
    // The filter must stay a filter. These are the shapes a real curriculum
    // writes, and each one still produces the edge it produced before #261.
    assert.deepStrictEqual(names(['[[m/01-setup]]']), ['m/01-setup']);
    // Conjunction is not disjunction: both are genuinely required, and a
    // blanket "contains `or`/`and` anywhere" rule would have broken this.
    assert.deepStrictEqual(names(['[[m/01-setup]] and [[m/02-alpha]] are required']), [
      'm/01-setup',
      'm/02-alpha',
    ]);
    assert.deepStrictEqual(names(['[[m/01-setup]] is required']), ['m/01-setup']);
    assert.deepStrictEqual(names(['[previous lesson quiz](../1-Clustering/README.md)']), [
      '../1-Clustering/README.md',
    ]);
  });

  test('a cue counts only in the prose, never inside a link', () => {
    // The reference itself is the author's chosen name, and note names say
    // things: `01-or-basics` and an alias reading `either of the two` are not
    // the author hedging. The cue window is the item's prose around its links.
    assert.deepStrictEqual(names(['[[m/01-or-basics]]']), ['m/01-or-basics']);
    assert.deepStrictEqual(names(['[[m/02-alpha|either of the two]]']), ['m/02-alpha']);
    assert.deepStrictEqual(names(['[[m/02-alpha]] (see the error log)']), ['m/02-alpha']);
  });

  test('a cue condemns its own item and no more', () => {
    // Item-level, not line-level and not section-level: each bullet is its own
    // declaration, so one hedged item cannot disarm the section around it.
    assert.deepStrictEqual(
      names(['[[m/01-setup]]', 'does not require [[m/02-alpha]]', '[[m/03-beta]]']),
      ['m/01-setup', 'm/03-beta']
    );
    // Two links sharing one disjunctive line lose both — the item as a whole
    // offered a choice, and splitting it would guess which half the author
    // meant. Losing an edge leaves the numbered tree's in place.
    assert.deepStrictEqual(names(['[[m/01-setup]] or [[m/02-alpha]]']), []);
  });

  test('the cue that fired is reported honestly', () => {
    // A reversal is not a denial: the note is saying something true, about the
    // other end. A report that called every refusal "negation" would teach the
    // next reader the wrong rule.
    assert.strictEqual(declaredPrereqCue('does not require [[m/01-setup]]'), 'negation');
    assert.strictEqual(declaredPrereqCue('No prior knowledge of [[m/01-setup]] is needed'), 'negation');
    assert.strictEqual(declaredPrereqCue('requires [[m/01-setup]] or [[m/02-alpha]]'), 'disjunction');
    assert.strictEqual(declaredPrereqCue('This note is a prerequisite for [[m/02-alpha]]'), 'reversal');
    assert.strictEqual(declaredPrereqCue('[[m/02-alpha]] depends on this lesson'), 'reversal');
    assert.strictEqual(declaredPrereqCue('[[m/01-setup]]'), null);
    assert.strictEqual(declaredPrereqCue('[[m/01-setup]] and [[m/02-alpha]] are required'), null);
    assert.strictEqual(declaredPrereqCue('[[m/01-or-basics]]'), null);
    // Negation is checked before the others: a denied choice is still a denial.
    assert.strictEqual(declaredPrereqCue('does not require [[m/01-setup]] or [[m/02-alpha]]'), 'negation');
  });

  test('`for` naming the current note is a prerequisite, not a reversal', () => {
    // `for` points both ways. `This note is a prerequisite for [[m/02]]` makes
    // the link the dependent, but `[[m/01]] is required for this lesson` is an
    // ordinary prerequisite stated from the other end — and reading it as a
    // reversal dropped a real gating edge, which is the commonest phrasing in a
    // `## Prerequisites` section of that shape.
    assert.strictEqual(declaredPrereqCue('[[m/01-setup]] is required for this lesson'), null);
    assert.strictEqual(declaredPrereqCue('[[m/01-setup]] (prerequisite for this module)'), null);
    assert.strictEqual(declaredPrereqCue('[[m/01-setup]] is a requirement for the current note'), null);
    // The reversal the arm exists for still fires: the link is past `for`.
    assert.strictEqual(declaredPrereqCue('This note is a prerequisite for [[m/02-alpha]]'), 'reversal');
    assert.deepStrictEqual(
      extractDeclaredPrerequisites('## Prerequisites\n\n- [[m/01-setup]] is required for this lesson\n')
        .map((entry) => entry.name),
      ['m/01-setup']
    );
  });
});

describe('declared-prerequisite resolution (PAL-205 WS6)', () => {
  const index = new Map<string, string[]>([
    ['setup', ['/vault/01-setup.md']],
    ['quiz', ['/vault/a/quiz.md', '/vault/b/quiz.md']],
  ]);
  const lookup = (ref: DeclaredPrereqRef): string[] => index.get(ref.name.toLowerCase().trim()) ?? [];

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
    // A markdown link resolves against its note's directory and a bare wikilink
    // against an index. Handed the name alone, the caller cannot tell the two
    // apart, and folding one way through the other is how `x1/README.md` became
    // the ambiguous basename `README`.
    const seen: string[] = [];
    resolveDeclaredPrerequisites(
      [
        { name: 'x1/README.md', form: 'mdlink' },
        { name: 'setup', form: 'wikilink' },
        { name: 'm/01-a', form: 'wikilink' },
      ],
      (ref) => {
        seen.push(`${ref.form}:${ref.name}`);
        return [];
      }
    );
    assert.deepStrictEqual(seen, ['mdlink:x1/README.md', 'wikilink:setup', 'wikilink:m/01-a']);
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

describe('one prerequisite named two ways is one prerequisite', () => {
  // The section's own dedupe. APFS stores `cafe` + U+0301 while a wikilink typed
  // for it arrives composed, and the key folded case only, so the same note read
  // as two declarations — and `declared` is the label nothing downstream questions.
  const NFD_ACUTE = String.fromCharCode(0x0301);
  const NFC_ACUTE = String.fromCharCode(0x00e9);

  test('deduplicates a name spelled in either normalization', () => {
    const section = [
      '## Prerequisites',
      '',
      `- [[caf${NFC_ACUTE}]]`,
      `- [[cafe${NFD_ACUTE}]]`,
      '',
    ].join('\n');
    assert.deepStrictEqual(extractDeclaredPrerequisites(section), [
      { name: `caf${NFC_ACUTE}`, form: 'wikilink' },
    ]);
  });

  test('keeps two names that merely share a case-folded spelling', () => {
    // The fold must not fuse distinct notes: `Setup` and `setup` are one target,
    // which is what the key already decided, and that stays true.
    const section = ['## Prerequisites', '', '- [[Setup]]', '- [[setup]]', ''].join('\n');
    assert.strictEqual(extractDeclaredPrerequisites(section).length, 1);
  });
});
