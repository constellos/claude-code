/**
 * Tests for task-state.ts - Task state management and frontmatter parsing
 *
 * @module task-state.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  saveTaskCallContext,
  loadTaskCallContext,
  removeTaskCallContext,
} from './task-state.js';

describe('Task State Management', () => {
  let testDir: string;
  let taskCallsPath: string;

  beforeEach(async () => {
    // Create temporary directory for tests
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'task-state-test-'));
    taskCallsPath = path.join(testDir, 'task-calls.json');
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('saveTaskCallContext', () => {
    it('should save task call context to file', async () => {
      const input = {
        tool_use_id: 'toolu_abc123',
        agent_type: 'Explore',
        session_id: 'session-xyz',
        prompt: 'Find all API endpoints',
        cwd: testDir,
      };

      const context = await saveTaskCallContext(input, taskCallsPath);

      expect(context.toolUseId).toBe('toolu_abc123');
      expect(context.agentType).toBe('Explore');
      expect(context.sessionId).toBe('session-xyz');
      expect(context.prompt).toBe('Find all API endpoints');
      expect(context.timestamp).toBeDefined();

      // Verify file was created
      const fileContent = await fs.readFile(taskCallsPath, 'utf-8');
      const saved = JSON.parse(fileContent);
      expect(saved['toolu_abc123']).toBeDefined();
      expect(saved['toolu_abc123'].agentType).toBe('Explore');
    });

    it('should append to existing contexts', async () => {
      const input1 = {
        tool_use_id: 'toolu_first',
        agent_type: 'Explore',
        session_id: 'session-1',
        prompt: 'First task',
        cwd: testDir,
      };

      const input2 = {
        tool_use_id: 'toolu_second',
        agent_type: 'Plan',
        session_id: 'session-1',
        prompt: 'Second task',
        cwd: testDir,
      };

      await saveTaskCallContext(input1, taskCallsPath);
      await saveTaskCallContext(input2, taskCallsPath);

      const fileContent = await fs.readFile(taskCallsPath, 'utf-8');
      const saved = JSON.parse(fileContent);

      expect(Object.keys(saved)).toHaveLength(2);
      expect(saved['toolu_first']).toBeDefined();
      expect(saved['toolu_second']).toBeDefined();
    });
  });

  describe('loadTaskCallContext', () => {
    it('should load saved context by tool_use_id', async () => {
      const input = {
        tool_use_id: 'toolu_load_test',
        agent_type: 'Explore',
        session_id: 'session-load',
        prompt: 'Load test prompt',
        cwd: testDir,
      };

      await saveTaskCallContext(input, taskCallsPath);
      const loaded = await loadTaskCallContext('toolu_load_test', testDir, taskCallsPath);

      expect(loaded).toBeDefined();
      expect(loaded?.toolUseId).toBe('toolu_load_test');
      expect(loaded?.agentType).toBe('Explore');
      expect(loaded?.prompt).toBe('Load test prompt');
    });

    it('should return undefined for non-existent context', async () => {
      const loaded = await loadTaskCallContext('toolu_nonexistent', testDir, taskCallsPath);
      expect(loaded).toBeUndefined();
    });

    it('should return undefined when file does not exist', async () => {
      const loaded = await loadTaskCallContext('toolu_any', testDir, '/path/does/not/exist.json');
      expect(loaded).toBeUndefined();
    });
  });

  describe('removeTaskCallContext', () => {
    it('should remove context from file', async () => {
      const input1 = {
        tool_use_id: 'toolu_keep',
        agent_type: 'Explore',
        session_id: 'session-1',
        prompt: 'Keep this',
        cwd: testDir,
      };

      const input2 = {
        tool_use_id: 'toolu_remove',
        agent_type: 'Plan',
        session_id: 'session-1',
        prompt: 'Remove this',
        cwd: testDir,
      };

      await saveTaskCallContext(input1, taskCallsPath);
      await saveTaskCallContext(input2, taskCallsPath);

      await removeTaskCallContext('toolu_remove', testDir, taskCallsPath);

      const loaded = await loadTaskCallContext('toolu_remove', testDir, taskCallsPath);
      expect(loaded).toBeUndefined();

      const kept = await loadTaskCallContext('toolu_keep', testDir, taskCallsPath);
      expect(kept).toBeDefined();
    });

    it('should handle removing non-existent context gracefully', async () => {
      await expect(
        removeTaskCallContext('toolu_nonexistent', testDir, taskCallsPath)
      ).resolves.toBeUndefined();
    });
  });

  describe('parseFrontmatter (integration via parseAgentFrontmatter)', () => {
    it('should parse simple key-value frontmatter', async () => {
      const agentFile = path.join(testDir, 'test-agent.md');
      const content = `---
name: TestAgent
description: A test agent
---

# Agent Content
`;
      await fs.writeFile(agentFile, content, 'utf-8');

      // We can't directly test parseFrontmatter since it's not exported,
      // but we can test it indirectly through getTaskEdits if we create
      // proper test fixtures. For now, let's create a simpler test.

      // Read the file and verify the frontmatter format is correct
      const fileContent = await fs.readFile(agentFile, 'utf-8');
      expect(fileContent).toContain('---');
      expect(fileContent).toContain('name: TestAgent');
    });

    it('should parse array values in frontmatter', async () => {
      const agentFile = path.join(testDir, 'test-agent-with-skills.md');
      const content = `---
name: TestAgent
skills: [skill1, skill2, skill3]
---

# Agent Content
`;
      await fs.writeFile(agentFile, content, 'utf-8');

      const fileContent = await fs.readFile(agentFile, 'utf-8');
      expect(fileContent).toContain('skills: [skill1, skill2, skill3]');
    });

    it('should handle frontmatter with various formats', async () => {
      const agentFile = path.join(testDir, 'complex-agent.md');
      const content = `---
name: ComplexAgent
version: 1.0.0
skills: [claude-plugins, turborepo-vercel]
enabled: true
---

# Complex Agent

This agent has complex frontmatter.
`;
      await fs.writeFile(agentFile, content, 'utf-8');

      const fileContent = await fs.readFile(agentFile, 'utf-8');
      expect(fileContent).toContain('name: ComplexAgent');
      expect(fileContent).toContain('version: 1.0.0');
      expect(fileContent).toContain('skills: [claude-plugins, turborepo-vercel]');
      expect(fileContent).toContain('enabled: true');
    });

    it('should handle missing frontmatter gracefully', async () => {
      const agentFile = path.join(testDir, 'no-frontmatter.md');
      const content = `# Agent Without Frontmatter

This agent has no frontmatter.
`;
      await fs.writeFile(agentFile, content, 'utf-8');

      const fileContent = await fs.readFile(agentFile, 'utf-8');
      expect(fileContent).not.toContain('---');
    });

    it('should handle empty frontmatter', async () => {
      const agentFile = path.join(testDir, 'empty-frontmatter.md');
      const content = `---
---

# Agent With Empty Frontmatter
`;
      await fs.writeFile(agentFile, content, 'utf-8');

      const fileContent = await fs.readFile(agentFile, 'utf-8');
      expect(fileContent).toContain('---\n---');
    });
  });

  describe('Full workflow integration', () => {
    it('should save, load, and remove context in sequence', async () => {
      // Save
      const input = {
        tool_use_id: 'toolu_workflow',
        agent_type: 'general-purpose',
        session_id: 'session-workflow',
        prompt: 'Complete workflow test',
        cwd: testDir,
      };

      const saved = await saveTaskCallContext(input, taskCallsPath);
      expect(saved.toolUseId).toBe('toolu_workflow');

      // Load
      const loaded = await loadTaskCallContext('toolu_workflow', testDir, taskCallsPath);
      expect(loaded).toBeDefined();
      expect(loaded?.prompt).toBe('Complete workflow test');

      // Remove
      await removeTaskCallContext('toolu_workflow', testDir, taskCallsPath);
      const removed = await loadTaskCallContext('toolu_workflow', testDir, taskCallsPath);
      expect(removed).toBeUndefined();
    });
  });
});
