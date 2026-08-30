import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import configCommand, { saveConfig } from '../src/cli/config';
import migrateCommand from '../src/cli/migrate';
import roadmapCommand from '../src/cli/roadmap';
import dashboardCommand from '../src/cli/dashboard';
import nextCommand from '../src/cli/next';
import planCommand from '../src/cli/plan';
import progressCommand from '../src/cli/progress';
import validateCommand from '../src/cli/validate';
import { RoadmapOptions } from '../src/types';

describe('CLI Command In-Process Exit Codes & Coverage', () => {
  let tempDir: string;
  let vaultDir: string;
  let prevConfigDir: string | undefined;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-cli-cov-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;
  });

  after(() => {
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('configCommand', () => {
    test('show displays current config with code 0', async () => {
      saveConfig({ vaultPath: vaultDir, aiProvider: 'test-provider', model: 'test-model' });
      await configCommand('show');
      assert.strictEqual(process.exitCode, undefined);
    });

    test('set-vault without value sets exitCode 2', async () => {
      await configCommand('set-vault');
      assert.strictEqual(process.exitCode, 2);
    });

    test('set-vault with non-existent path sets exitCode 2', async () => {
      await configCommand('set-vault', path.join(tempDir, 'non-existent'));
      assert.strictEqual(process.exitCode, 2);
    });

    test('set-vault with file instead of directory sets exitCode 2', async () => {
      const filePath = path.join(tempDir, 'a-file.txt');
      fs.writeFileSync(filePath, 'sample');
      await configCommand('set-vault', filePath);
      assert.strictEqual(process.exitCode, 2);
    });

    test('set-vault with valid directory succeeds', async () => {
      await configCommand('set-vault', vaultDir);
      assert.strictEqual(process.exitCode, undefined);
    });

    test('set-provider without value sets exitCode 2', async () => {
      await configCommand('set-provider');
      assert.strictEqual(process.exitCode, 2);
    });

    test('set-provider with value succeeds', async () => {
      await configCommand('set-provider', 'anthropic');
      assert.strictEqual(process.exitCode, undefined);
    });

    test('set-model without value sets exitCode 2', async () => {
      await configCommand('set-model');
      assert.strictEqual(process.exitCode, 2);
    });

    test('set-model with value succeeds', async () => {
      await configCommand('set-model', 'claude-3-5-sonnet');
      assert.strictEqual(process.exitCode, undefined);
    });

    test('unknown action sets exitCode 2', async () => {
      await configCommand('unknown-action');
      assert.strictEqual(process.exitCode, 2);
    });

    test('recovers gracefully from corrupted config.json with fallback to default', async () => {
      const configPath = path.join(tempDir, 'config.json');
      fs.writeFileSync(configPath, '{ "vaultPath": corrupt json');
      await configCommand('show');
      assert.strictEqual(process.exitCode, undefined);
    });
  });

  describe('migrateCommand', () => {
    test('without configured vault sets exitCode 2', async () => {
      saveConfig({});
      await migrateCommand();
      assert.strictEqual(process.exitCode, 2);
    });

    test('with valid schema v1 notes succeeds', async () => {
      saveConfig({ vaultPath: vaultDir });
      const notePath = path.join(vaultDir, 'topic-v1.md');
      fs.writeFileSync(
        notePath,
        '---\npalee_id: T-v1-test\npalee_schema: 1\ntitle: V1 Test\n---\n# Topic\n'
      );
      await migrateCommand();
      assert.strictEqual(process.exitCode, undefined);
    });

    test('with missing schema property sets exitCode 3 when --fix is false', async () => {
      saveConfig({ vaultPath: vaultDir });
      const missingSchemaNote = path.join(vaultDir, 'topic-missing-schema.md');
      fs.writeFileSync(
        missingSchemaNote,
        '---\npalee_id: T-no-schema\ntitle: No Schema\n---\n# Topic\n'
      );
      await migrateCommand({ fix: false });
      assert.strictEqual(process.exitCode, 3);
    });

    test('with --fix upgrades schema-less notes to Schema v1', async () => {
      saveConfig({ vaultPath: vaultDir });
      const missingSchemaNote = path.join(vaultDir, 'topic-missing-schema.md');
      await migrateCommand({ fix: true });
      assert.strictEqual(process.exitCode, undefined);
      const updated = fs.readFileSync(missingSchemaNote, 'utf8');
      assert.ok(updated.includes('palee_schema: 1'));
      fs.unlinkSync(missingSchemaNote);
    });

    test('with unrecognized schema version sets exitCode 3', async () => {
      saveConfig({ vaultPath: vaultDir });
      const badNote = path.join(vaultDir, 'topic-v2.md');
      fs.writeFileSync(
        badNote,
        '---\npalee_id: T-v2-test\npalee_schema: 2\ntitle: V2 Test\n---\n# Topic\n'
      );
      await migrateCommand();
      assert.strictEqual(process.exitCode, 3);
      fs.unlinkSync(badNote);
    });
  });

  describe('roadmapCommand', () => {
    test('without --from sets exitCode 2', async () => {
      await roadmapCommand({} as unknown as RoadmapOptions);
      assert.strictEqual(process.exitCode, 2);
    });

    test('with non-existent --from file sets exitCode 2', async () => {
      saveConfig({ vaultPath: vaultDir });
      await roadmapCommand({ from: path.join(tempDir, 'missing.yaml') });
      assert.strictEqual(process.exitCode, 2);
    });

    test('with invalid roadmap content sets exitCode 2', async () => {
      saveConfig({ vaultPath: vaultDir });
      const invalidRoadmap = path.join(tempDir, 'invalid-roadmap.yaml');
      fs.writeFileSync(invalidRoadmap, 'title: Invalid without topics\n');
      await roadmapCommand({ from: invalidRoadmap });
      assert.strictEqual(process.exitCode, 2);
    });

    test('with dependency cycle sets exitCode 3', async () => {
      saveConfig({ vaultPath: vaultDir });
      const cycleRoadmap = path.join(tempDir, 'cycle-roadmap.yaml');
      fs.writeFileSync(
        cycleRoadmap,
        'topics:\n  - id: T-cycle-a\n    title: Cycle A\n    path: a.md\n    depends_on: [T-cycle-b]\n  - id: T-cycle-b\n    title: Cycle B\n    path: b.md\n    depends_on: [T-cycle-a]\n'
      );
      await roadmapCommand({ from: cycleRoadmap });
      assert.strictEqual(process.exitCode, 3);
    });

    test('roadmapCommand without configured vault sets exitCode 2', async () => {
      saveConfig({});
      const validRoadmap = path.join(tempDir, 'valid-roadmap.yaml');
      fs.writeFileSync(validRoadmap, 'topics:\n  - id: T-1\n    title: T1\n    path: t1.md\n');
      await roadmapCommand({ from: validRoadmap });
      assert.strictEqual(process.exitCode, 2);
    });

    test('roadmapCommand in non-interactive environment without --yes sets exitCode 2', async () => {
      saveConfig({ vaultPath: vaultDir });
      const validRoadmap = path.join(tempDir, 'valid-roadmap.yaml');
      fs.writeFileSync(validRoadmap, 'topics:\n  - id: T-1\n    title: T1\n    path: t1.md\n');
      await roadmapCommand({ from: validRoadmap, yes: false });
      assert.strictEqual(process.exitCode, 2);
    });

    test('with valid roadmap and --yes succeeds', async () => {
      saveConfig({ vaultPath: vaultDir });
      const validRoadmap = path.join(tempDir, 'valid-roadmap.yaml');
      fs.writeFileSync(
        validRoadmap,
        'topics:\n  - id: T-roadmap-item\n    title: Roadmap Item\n    path: roadmap-item.md\n'
      );
      await roadmapCommand({ from: validRoadmap, yes: true });
      assert.strictEqual(process.exitCode, 0);
    });

    test('batch import with corrupted note creates valid topics, logs error, and sets exitCode 1', async () => {
      saveConfig({ vaultPath: vaultDir });

      // Create a corrupted note on disk that will cause updateFrontmatter to throw Malformed frontmatter
      const corruptNotePath = path.join(vaultDir, 'corrupt-topic.md');
      fs.writeFileSync(corruptNotePath, '---\npalee_id: [unclosed\n---\n# Corrupt Note\n', 'utf8');

      const mixedRoadmap = path.join(tempDir, 'corrupt-batch-roadmap.yaml');
      fs.writeFileSync(
        mixedRoadmap,
        `topics:
  - id: T-valid-first
    title: Valid First Topic
    path: valid-first.md
  - id: T-corrupt
    title: Corrupt Topic
    path: corrupt-topic.md
  - id: T-valid-second
    title: Valid Second Topic
    path: valid-second.md
`
      );

      const errorLogs: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errorLogs.push(args.map(a => String(a)).join(' '));
      };

      try {
        await roadmapCommand({ from: mixedRoadmap, yes: true });
      } finally {
        console.error = origError;
      }

      assert.strictEqual(process.exitCode, 1, 'Expected exitCode 1 on partial batch failure');

      // Verify valid topics were created
      const validFirstPath = path.join(vaultDir, 'valid-first.md');
      const validSecondPath = path.join(vaultDir, 'valid-second.md');
      assert.ok(fs.existsSync(validFirstPath), 'valid-first.md should exist');
      assert.ok(fs.existsSync(validSecondPath), 'valid-second.md should exist');

      // Verify error was logged for corrupted topic
      const combinedErrors = errorLogs.join('\n');
      assert.match(combinedErrors, /Failed T-corrupt \(corrupt-topic\.md\)/);
      assert.match(combinedErrors, /Malformed frontmatter/);
      assert.match(combinedErrors, /Failed to import 1 topics/);

      // Cleanup
      if (fs.existsSync(corruptNotePath)) fs.unlinkSync(corruptNotePath);
      if (fs.existsSync(validFirstPath)) fs.unlinkSync(validFirstPath);
      if (fs.existsSync(validSecondPath)) fs.unlinkSync(validSecondPath);
      if (fs.existsSync(mixedRoadmap)) fs.unlinkSync(mixedRoadmap);
    });
  });

  describe('dashboardCommand, nextCommand, planCommand, progressCommand, validateCommand', () => {
    before(() => {
      saveConfig({ vaultPath: vaultDir });
    });

    test('dashboardCommand executes cleanly', async () => {
      await dashboardCommand();
      assert.strictEqual(process.exitCode, undefined);
    });

    test('nextCommand executes cleanly', async () => {
      await nextCommand({});
      assert.strictEqual(process.exitCode, undefined);
    });

    test('planCommand executes cleanly', async () => {
      await planCommand({});
      assert.strictEqual(process.exitCode, undefined);
    });

    test('progressCommand executes cleanly', async () => {
      await progressCommand({});
      assert.strictEqual(process.exitCode, undefined);
    });

    test('validateCommand executes cleanly', async () => {
      await validateCommand({});
      assert.strictEqual(process.exitCode, undefined);
    });
  });

  describe('Handler catch blocks set exitCode 5 on unexpected errors', () => {
    let corruptConfigDir: string;
    let originalConfigDir: string | undefined;

    before(() => {
      corruptConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-corrupt-'));
      // Create config.json as a directory to trigger an unexpected EISDIR error on read
      fs.mkdirSync(path.join(corruptConfigDir, 'config.json'));
      originalConfigDir = process.env.PALEE_CONFIG_DIR;
      process.env.PALEE_CONFIG_DIR = corruptConfigDir;
    });

    after(() => {
      if (originalConfigDir !== undefined) {
        process.env.PALEE_CONFIG_DIR = originalConfigDir;
      } else {
        delete process.env.PALEE_CONFIG_DIR;
      }
      fs.rmSync(corruptConfigDir, { recursive: true, force: true });
    });

    test('configCommand catch sets exitCode 5', async () => {
      await configCommand('show');
      assert.strictEqual(process.exitCode, 5);
    });

    test('dashboardCommand catch sets exitCode 5', async () => {
      await dashboardCommand();
      assert.strictEqual(process.exitCode, 5);
    });

    test('nextCommand catch sets exitCode 5', async () => {
      await nextCommand({});
      assert.strictEqual(process.exitCode, 5);
    });

    test('planCommand catch sets exitCode 5', async () => {
      await planCommand({});
      assert.strictEqual(process.exitCode, 5);
    });

    test('progressCommand catch sets exitCode 5', async () => {
      await progressCommand({});
      assert.strictEqual(process.exitCode, 5);
    });

    test('validateCommand catch sets exitCode 5', async () => {
      await validateCommand({});
      assert.strictEqual(process.exitCode, 5);
    });

    test('migrateCommand catch sets exitCode 5', async () => {
      await migrateCommand();
      assert.strictEqual(process.exitCode, 5);
    });

    test('roadmapCommand catch sets exitCode 5', async () => {
      const validRoadmap = path.join(tempDir, 'valid-roadmap.yaml');
      await roadmapCommand({ from: validRoadmap });
      assert.strictEqual(process.exitCode, 5);
    });
  });
});
