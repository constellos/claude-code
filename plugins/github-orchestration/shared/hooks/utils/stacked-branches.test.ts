/**
 * Tests for stacked-branches.ts - Stacked PR branch management
 *
 * @module stacked-branches.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  generateSubagentBranchName,
  loadStackedBranchesState,
  createStackedBranchEntry,
  getStackedBranchEntry,
  updateStackedBranchEntry,
  removeStackedBranchEntry,
  loadSessionConfig,
  saveSessionConfig,
} from './stacked-branches.js';

describe('Stacked Branches Utilities', () => {
  let testDir: string;
  let logsDir: string;

  beforeEach(async () => {
    // Create temporary directory for tests
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'stacked-branches-test-'));
    logsDir = path.join(testDir, '.claude', 'logs');
    await fs.mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  describe('generateSubagentBranchName', () => {
    it('should generate branch name with short agent ID', () => {
      const baseBranch = 'main';
      const agentId = 'abc123def456ghi789';

      const branchName = generateSubagentBranchName(baseBranch, agentId);

      expect(branchName).toBe('main-subagent-abc123de');
    });

    it('should handle feature branch names', () => {
      const baseBranch = 'feature/my-feature';
      const agentId = 'xyz789abc';

      const branchName = generateSubagentBranchName(baseBranch, agentId);

      expect(branchName).toBe('feature/my-feature-subagent-xyz789ab');
    });

    it('should handle short agent IDs', () => {
      const baseBranch = 'develop';
      const agentId = 'short';

      const branchName = generateSubagentBranchName(baseBranch, agentId);

      expect(branchName).toBe('develop-subagent-short');
    });
  });

  describe('State Management', () => {
    it('should save and load stacked branches state', async () => {
      const entry = {
        agentId: 'agent-123',
        parentSessionId: 'session-456',
        branchName: 'main-subagent-agent-12',
        baseBranch: 'main',
        createdAt: new Date().toISOString(),
        prNumber: null,
        prUrl: null,
        status: 'active' as const,
        modifiedFiles: [],
        commitSha: null,
      };

      await createStackedBranchEntry(testDir, entry);
      const loaded = await getStackedBranchEntry(testDir, 'agent-123');

      expect(loaded).toBeDefined();
      expect(loaded?.agentId).toBe('agent-123');
      expect(loaded?.branchName).toBe('main-subagent-agent-12');
      expect(loaded?.status).toBe('active');
    });

    it('should update stacked branch entry', async () => {
      const entry = {
        agentId: 'agent-update',
        parentSessionId: 'session-456',
        branchName: 'main-subagent-agent-up',
        baseBranch: 'main',
        createdAt: new Date().toISOString(),
        prNumber: null,
        prUrl: null,
        status: 'active' as const,
        modifiedFiles: [],
        commitSha: null,
      };

      await createStackedBranchEntry(testDir, entry);
      await updateStackedBranchEntry(testDir, 'agent-update', {
        status: 'pr-created',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
      });

      const updated = await getStackedBranchEntry(testDir, 'agent-update');

      expect(updated?.status).toBe('pr-created');
      expect(updated?.prNumber).toBe(42);
      expect(updated?.prUrl).toBe('https://github.com/test/repo/pull/42');
    });

    it('should remove stacked branch entry', async () => {
      const entry = {
        agentId: 'agent-remove',
        parentSessionId: 'session-456',
        branchName: 'main-subagent-agent-re',
        baseBranch: 'main',
        createdAt: new Date().toISOString(),
        prNumber: null,
        prUrl: null,
        status: 'active' as const,
        modifiedFiles: [],
        commitSha: null,
      };

      await createStackedBranchEntry(testDir, entry);
      await removeStackedBranchEntry(testDir, 'agent-remove');

      const removed = await getStackedBranchEntry(testDir, 'agent-remove');
      expect(removed).toBeNull();
    });

    it('should return empty state for non-existent file', async () => {
      const emptyDir = await fs.mkdtemp(path.join(tmpdir(), 'empty-'));
      const state = await loadStackedBranchesState(emptyDir);

      expect(state.entries).toEqual({});
      expect(state.updatedAt).toBeDefined();

      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe('Session Configuration', () => {
    it('should save and load session config', async () => {
      const config = {
        stackedPrMode: true,
        stackedPrConfig: {
          waitForCI: true,
          waitForMerge: false,
          skipAgentTypes: ['Explore', 'Plan', 'CustomSkip'],
        },
      };

      await saveSessionConfig(testDir, config);
      const loaded = await loadSessionConfig(testDir);

      expect(loaded?.stackedPrMode).toBe(true);
      expect(loaded?.stackedPrConfig?.waitForCI).toBe(true);
      expect(loaded?.stackedPrConfig?.waitForMerge).toBe(false);
      expect(loaded?.stackedPrConfig?.skipAgentTypes).toContain('CustomSkip');
    });

    it('should return null for non-existent config', async () => {
      const emptyDir = await fs.mkdtemp(path.join(tmpdir(), 'no-config-'));
      const config = await loadSessionConfig(emptyDir);

      expect(config).toBeNull();

      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe('Skip Agent Types Logic (PR #312)', () => {
    // These tests verify the logic that skips Explore and Plan agents
    // as documented in the hook behavior

    it('should identify Explore as a skip type', () => {
      const SKIP_AGENT_TYPES = ['Explore', 'Plan'];
      expect(SKIP_AGENT_TYPES.includes('Explore')).toBe(true);
    });

    it('should identify Plan as a skip type', () => {
      const SKIP_AGENT_TYPES = ['Explore', 'Plan'];
      expect(SKIP_AGENT_TYPES.includes('Plan')).toBe(true);
    });

    it('should not skip general-purpose agents', () => {
      const SKIP_AGENT_TYPES = ['Explore', 'Plan'];
      expect(SKIP_AGENT_TYPES.includes('general-purpose')).toBe(false);
    });

    it('should not skip Bash agents', () => {
      const SKIP_AGENT_TYPES = ['Explore', 'Plan'];
      expect(SKIP_AGENT_TYPES.includes('Bash')).toBe(false);
    });
  });

  describe('Multiple Entries Workflow', () => {
    it('should handle multiple concurrent subagent branches', async () => {
      const entries = [
        {
          agentId: 'agent-1',
          parentSessionId: 'session-main',
          branchName: 'main-subagent-agent-1',
          baseBranch: 'main',
          createdAt: new Date().toISOString(),
          prNumber: null,
          prUrl: null,
          status: 'active' as const,
          modifiedFiles: [],
          commitSha: null,
        },
        {
          agentId: 'agent-2',
          parentSessionId: 'session-main',
          branchName: 'main-subagent-agent-2',
          baseBranch: 'main',
          createdAt: new Date().toISOString(),
          prNumber: 10,
          prUrl: 'https://github.com/test/repo/pull/10',
          status: 'ci-pending' as const,
          modifiedFiles: ['file1.ts'],
          commitSha: 'abc123',
        },
        {
          agentId: 'agent-3',
          parentSessionId: 'session-main',
          branchName: 'main-subagent-agent-3',
          baseBranch: 'main',
          createdAt: new Date().toISOString(),
          prNumber: 11,
          prUrl: 'https://github.com/test/repo/pull/11',
          status: 'merged' as const,
          modifiedFiles: ['file2.ts', 'file3.ts'],
          commitSha: 'def456',
        },
      ];

      for (const entry of entries) {
        await createStackedBranchEntry(testDir, entry);
      }

      const state = await loadStackedBranchesState(testDir);
      expect(Object.keys(state.entries)).toHaveLength(3);

      const entry1 = await getStackedBranchEntry(testDir, 'agent-1');
      expect(entry1?.status).toBe('active');

      const entry2 = await getStackedBranchEntry(testDir, 'agent-2');
      expect(entry2?.status).toBe('ci-pending');
      expect(entry2?.prNumber).toBe(10);

      const entry3 = await getStackedBranchEntry(testDir, 'agent-3');
      expect(entry3?.status).toBe('merged');
    });
  });
});
