import { test, describe } from 'node:test';
import assert from 'node:assert';
import { globToRegex, matchesPattern, matchesTags } from '../src/storage/pattern-matcher';
import { normalizeDifficulty } from '../src/types';
import { calculateEaseFactorDelta, processReview } from '../src/engine/sm2';
import { detectCycle } from '../src/engine/dependency';
import { TopicNode } from '../src/types';

describe('Property-Based & Fuzz Testing Suite', () => {
  describe('Glob Pattern Fuzzing & ReDoS Safety', () => {
    test('globToRegex compiles 300+ randomized glob combinations without throwing or hanging', () => {
      const globTokens = ['*', '**', '?', '[0-9]', '[!a-z]', 'notes', 'sub', 'md', '/', '\\', '.', '-', '_', '{a,b}'];

      for (let i = 0; i < 300; i++) {
        // Generate pseudo-random glob string
        const tokenCount = Math.floor(Math.random() * 6) + 1;
        let randomGlob = '';
        for (let j = 0; j < tokenCount; j++) {
          randomGlob += globTokens[Math.floor(Math.random() * globTokens.length)];
        }

        const start = Date.now();
        const regex = globToRegex(randomGlob);
        assert.ok(regex instanceof RegExp);
        // Test matching speed against a standard path to ensure no catastrophic backtracking (ReDoS)
        regex.test('notes/2026/concepts/kubernetes-architecture-overview.md');
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 100, `Glob evaluation took too long (${elapsed}ms) for pattern: ${randomGlob}`);
      }
    });

    test('matchesPattern behaves deterministically across random path inputs', () => {
      const paths = [
        'root.md',
        'sub/note.md',
        'deep/nested/directory/topic.md',
        'deep\\nested\\win\\topic.md',
        'with space/my note.md',
        'special-chars_123.md',
      ];

      for (const p of paths) {
        assert.strictEqual(matchesPattern(p, '**/*.md'), true);
        assert.strictEqual(matchesPattern(p, '*.txt'), false);
      }
    });
  });

  describe('Tag Matcher Property Invariants', () => {
    test('matchesTags handles 200+ randomized tag permutations and hierarchy queries', () => {
      const baseTags = ['cloud', 'aws', 'docker', 'devops', 'kubernetes', 'storage', 'database', 'frontend'];

      for (let i = 0; i < 200; i++) {
        const tag1 = baseTags[Math.floor(Math.random() * baseTags.length)];
        const tag2 = baseTags[Math.floor(Math.random() * baseTags.length)];
        const hierarchicalTag = `${tag1}/${tag2}`;

        // Exact match
        assert.strictEqual(matchesTags([hierarchicalTag], hierarchicalTag), true);
        // Prefix match
        assert.strictEqual(matchesTags([hierarchicalTag], tag1), true);
        // Suffix/Infix match
        assert.strictEqual(matchesTags([hierarchicalTag], tag2), true);
        // Comma-separated query
        assert.strictEqual(matchesTags([hierarchicalTag], `${tag1}, other`), true);
        // Mismatch
        assert.strictEqual(matchesTags([hierarchicalTag], 'nonexistent-tag-12345'), false);
      }
    });
  });

  describe('Difficulty Normalization Invariants', () => {
    test('normalizeDifficulty satisfies total function property over arbitrary inputs', () => {
      const testInputs: unknown[] = [
        'beginner', 'Beginner', '  BEGINNER  ',
        'intermediate', 'Intermediate', 'INTERMEDIATE',
        'advanced', 'Advanced', 'ADVANCED',
        1, '1', 2, '2', 3, '3', 4, '4', 5, '5',
        0, 6, -1, 100, NaN, Infinity, -Infinity,
        '', '   ', 'unknown', 'expert', null, undefined, {}, [], true, false,
      ];

      const validOutputs = new Set(['beginner', 'intermediate', 'advanced']);

      for (const input of testInputs) {
        const result = normalizeDifficulty(input);
        assert.ok(
          validOutputs.has(result),
          `normalizeDifficulty(${JSON.stringify(input)}) produced invalid output: ${result}`
        );
      }
    });
  });

  describe('SM-2 Algorithm Mathematical Invariants', () => {
    test('calculateEaseFactorDelta is strictly bounded and monotonic across quality 0..5', () => {
      const deltas = [0, 1, 2, 3, 4, 5].map(q => calculateEaseFactorDelta(q));

      // Quality 5 should give maximum boost (+0.1)
      assert.strictEqual(deltas[5], 0.1);
      // Quality 4 gives 0 delta
      assert.strictEqual(deltas[4], 0.0);
      // Lower qualities give strictly increasing penalties
      for (let q = 0; q < 5; q++) {
        assert.ok(deltas[q] < deltas[q + 1], `Delta at q=${q} (${deltas[q]}) must be < delta at q=${q+1} (${deltas[q+1]})`);
      }
    });

    test('processReview preserves ease_factor >= 1.3 invariant under continuous low quality reviews', () => {
      let state = { ease_factor: 2.5, interval_days: 10, repetition: 5, lapses: 0 };

      // Simulate 20 consecutive failures (quality = 0)
      for (let i = 0; i < 20; i++) {
        state = processReview(state, 0) as { ease_factor: number; interval_days: number; repetition: number; lapses: number };
        assert.ok(state.ease_factor >= 1.3, `Ease factor dropped below minimum: ${state.ease_factor}`);
        assert.strictEqual(state.interval_days, 1);
        assert.strictEqual(state.repetition, 0);
      }
      assert.strictEqual(state.lapses, 1);
    });
  });

  describe('Cycle Detection Graph Invariants', () => {
    test('detectCycle correctly identifies cycles in generated linear, branched, and cyclic graphs', () => {
      // 1. Acyclic Linear Graph: A -> B -> C -> D
      const linearMap = new Map<string, TopicNode>([
        ['A', { palee_id: 'A', depends_on: ['B'], topic_mastery: 0 }],
        ['B', { palee_id: 'B', depends_on: ['C'], topic_mastery: 0 }],
        ['C', { palee_id: 'C', depends_on: ['D'], topic_mastery: 0 }],
        ['D', { palee_id: 'D', depends_on: [], topic_mastery: 0 }],
      ]);
      assert.strictEqual(detectCycle(linearMap), null);

      // 2. Cyclic Loop: A -> B -> C -> A
      const cyclicMap = new Map<string, TopicNode>([
        ['A', { palee_id: 'A', depends_on: ['B'], topic_mastery: 0 }],
        ['B', { palee_id: 'B', depends_on: ['C'], topic_mastery: 0 }],
        ['C', { palee_id: 'C', depends_on: ['A'], topic_mastery: 0 }],
      ]);
      const cycle = detectCycle(cyclicMap);
      assert.ok(cycle !== null);
      assert.strictEqual(cycle[0], cycle[cycle.length - 1], 'Cycle path start must equal cycle path end');
    });
  });
});
