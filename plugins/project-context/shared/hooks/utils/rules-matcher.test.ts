/**
 * Tests for rules-matcher.ts - Rules discovery and matching
 *
 * Tests PR #314 feature:
 * - Rules are discovered and matched to edited files
 * - Rules context is included in SubagentStop output
 *
 * @module rules-matcher.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  discoverRules,
  matchRulesToFiles,
  formatRulesContext,
} from './rules-matcher.js';

describe('Rules Matcher', () => {
  let testDir: string;
  let rulesDir: string;

  beforeEach(async () => {
    // Create temporary directory for tests
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'rules-matcher-test-'));
    rulesDir = path.join(testDir, '.claude', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('discoverRules', () => {
    it('should discover rules files in .claude/rules/', async () => {
      // Create a rule file - use unquoted YAML array format
      const ruleContent = `---
paths:
  - src/**/*.ts
  - lib/**/*.ts
---

# TypeScript Rule

All TypeScript files must have types.
`;
      await fs.writeFile(path.join(rulesDir, 'typescript-rule.md'), ruleContent);

      const rules = await discoverRules(testDir);

      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe('typescript-rule');
      expect(rules[0].paths).toEqual(['src/**/*.ts', 'lib/**/*.ts']);
    });

    it('should handle rules without paths frontmatter', async () => {
      const ruleContent = `---
description: General rule
---

# General Rule

This rule has no path patterns.
`;
      await fs.writeFile(path.join(rulesDir, 'general-rule.md'), ruleContent);

      const rules = await discoverRules(testDir);

      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe('general-rule');
      expect(rules[0].paths).toBeUndefined();
    });

    it('should discover multiple rules', async () => {
      const rule1 = `---
paths: ["*.tsx"]
---
# React Rule
`;
      const rule2 = `---
paths: ["*.css"]
---
# CSS Rule
`;
      await fs.writeFile(path.join(rulesDir, 'react-rule.md'), rule1);
      await fs.writeFile(path.join(rulesDir, 'css-rule.md'), rule2);

      const rules = await discoverRules(testDir);

      expect(rules).toHaveLength(2);
      const names = rules.map((r) => r.name).sort();
      expect(names).toEqual(['css-rule', 'react-rule']);
    });

    it('should return empty array when no rules directory exists', async () => {
      const emptyDir = await fs.mkdtemp(path.join(tmpdir(), 'no-rules-'));

      const rules = await discoverRules(emptyDir);

      expect(rules).toEqual([]);

      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe('matchRulesToFiles', () => {
    it('should match rules to edited files by glob pattern', async () => {
      const rules = [
        {
          filePath: path.join(rulesDir, 'ts-rule.md'),
          relativePath: 'ts-rule.md',
          paths: ['src/**/*.ts'],
          content: '# TS Rule',
          name: 'ts-rule',
        },
        {
          filePath: path.join(rulesDir, 'css-rule.md'),
          relativePath: 'css-rule.md',
          paths: ['**/*.css'],
          content: '# CSS Rule',
          name: 'css-rule',
        },
      ];

      const editedFiles = [
        path.join(testDir, 'src', 'component.ts'),
        path.join(testDir, 'src', 'utils.ts'),
      ];

      const matched = matchRulesToFiles(rules, editedFiles, testDir);

      expect(matched).toHaveLength(1);
      expect(matched[0].name).toBe('ts-rule');
    });

    it('should not match rules without paths', async () => {
      const rules = [
        {
          filePath: path.join(rulesDir, 'no-paths.md'),
          relativePath: 'no-paths.md',
          paths: undefined,
          content: '# No Paths Rule',
          name: 'no-paths',
        },
      ];

      const editedFiles = [path.join(testDir, 'src', 'file.ts')];

      const matched = matchRulesToFiles(rules, editedFiles, testDir);

      expect(matched).toHaveLength(0);
    });

    it('should match multiple rules to the same file', async () => {
      const rules = [
        {
          filePath: path.join(rulesDir, 'ts-rule.md'),
          relativePath: 'ts-rule.md',
          paths: ['**/*.ts'],
          content: '# TS Rule',
          name: 'ts-rule',
        },
        {
          filePath: path.join(rulesDir, 'src-rule.md'),
          relativePath: 'src-rule.md',
          paths: ['src/**/*'],
          content: '# Src Rule',
          name: 'src-rule',
        },
      ];

      const editedFiles = [path.join(testDir, 'src', 'component.ts')];

      const matched = matchRulesToFiles(rules, editedFiles, testDir);

      expect(matched).toHaveLength(2);
    });

    it('should deduplicate matching rules', async () => {
      const rules = [
        {
          filePath: path.join(rulesDir, 'ts-rule.md'),
          relativePath: 'ts-rule.md',
          paths: ['**/*.ts'],
          content: '# TS Rule',
          name: 'ts-rule',
        },
      ];

      // Multiple TS files should still only match once
      const editedFiles = [
        path.join(testDir, 'src', 'a.ts'),
        path.join(testDir, 'src', 'b.ts'),
        path.join(testDir, 'lib', 'c.ts'),
      ];

      const matched = matchRulesToFiles(rules, editedFiles, testDir);

      expect(matched).toHaveLength(1);
      expect(matched[0].name).toBe('ts-rule');
    });
  });

  describe('formatRulesContext', () => {
    it('should format rules as markdown context', () => {
      const rules = [
        {
          filePath: '/rules/test.md',
          relativePath: 'test.md',
          paths: ['**/*.ts'],
          content: '# Test Rule\n\nThis is a test rule.',
          name: 'test',
        },
      ];

      const context = formatRulesContext(rules);

      expect(context).toContain('## Applicable Rules');
      expect(context).toContain('### test');
      expect(context).toContain('This is a test rule.');
    });

    it('should return empty string for no rules', () => {
      const context = formatRulesContext([]);

      expect(context).toBe('');
    });

    it('should truncate long rule content', () => {
      const longContent = 'x'.repeat(2000);
      const rules = [
        {
          filePath: '/rules/long.md',
          relativePath: 'long.md',
          paths: ['**/*'],
          content: longContent,
          name: 'long',
        },
      ];

      const context = formatRulesContext(rules, 100);

      expect(context.length).toBeLessThan(longContent.length);
      expect(context).toContain('...');
    });

    it('should format multiple rules', () => {
      const rules = [
        {
          filePath: '/rules/a.md',
          relativePath: 'a.md',
          paths: ['**/*.ts'],
          content: '# Rule A',
          name: 'a',
        },
        {
          filePath: '/rules/b.md',
          relativePath: 'b.md',
          paths: ['**/*.css'],
          content: '# Rule B',
          name: 'b',
        },
      ];

      const context = formatRulesContext(rules);

      expect(context).toContain('### a');
      expect(context).toContain('### b');
      expect(context).toContain('# Rule A');
      expect(context).toContain('# Rule B');
    });
  });

  describe('Integration: Full rules workflow (Test 6)', () => {
    it('should discover, match, and format rules for edited files', async () => {
      // Create rules with path patterns - use unquoted YAML
      const hookRule = `---
paths:
  - plugins/**/*.ts
  - hooks/**/*.ts
---

# Hook Development Rule

All hooks must:
1. Be non-blocking by default
2. Use debug logger
3. Handle errors gracefully
`;
      await fs.writeFile(path.join(rulesDir, 'hook-rule.md'), hookRule);

      const testRule = `---
paths:
  - '**/*.test.ts'
---

# Test Rule

Tests must use vitest.
`;
      await fs.writeFile(path.join(rulesDir, 'test-rule.md'), testRule);

      // Simulate edited files
      const editedFiles = [
        path.join(testDir, 'plugins', 'my-plugin', 'hooks', 'my-hook.ts'),
        path.join(testDir, 'plugins', 'my-plugin', 'hooks', 'my-hook.test.ts'),
      ];

      // Discover rules
      const rules = await discoverRules(testDir);
      expect(rules.length).toBeGreaterThanOrEqual(2);

      // Match rules to files
      const matched = matchRulesToFiles(rules, editedFiles, testDir);
      expect(matched.length).toBeGreaterThanOrEqual(1);

      // Format context
      const context = formatRulesContext(matched);
      expect(context).toContain('## Applicable Rules');

      // At least hook-rule should match
      const hookRuleMatched = matched.some((r) => r.name === 'hook-rule');
      expect(hookRuleMatched).toBe(true);
    });
  });
});
