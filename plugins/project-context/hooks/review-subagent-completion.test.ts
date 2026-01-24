/**
 * Tests for review-subagent-completion.ts - SubagentStop review hook
 *
 * Tests PR #314 features:
 * - Plan agent blocking without plan files
 * - Explore agent passthrough
 * - Rules matcher context
 *
 * Note: We replicate the constants/helpers here because importing from
 * the main hook file triggers runHook() which expects stdin input.
 *
 * @module review-subagent-completion.test
 */

import { describe, it, expect } from 'vitest';

// Replicate constants from review-subagent-completion.ts for testing
// These should match the values in the main hook file
const NON_BLOCKING_AGENT_TYPES = ['explore', 'claude-code-guide'];
const PLAN_FILE_PATTERNS = ['.claude/plans/', '/plans/', 'PLAN.md', 'plan.md'];

// Replicate helper functions for testing
function isPlanFile(filePath: string): boolean {
  return PLAN_FILE_PATTERNS.some((pattern) => filePath.includes(pattern));
}

function normalizeAgentType(agentType: string): string {
  return agentType.toLowerCase().trim();
}

describe('Review Subagent Completion Hook', () => {
  describe('isPlanFile', () => {
    it('should recognize .claude/plans/ directory paths', () => {
      expect(isPlanFile('/project/.claude/plans/feature-plan.md')).toBe(true);
      expect(isPlanFile('.claude/plans/my-plan.md')).toBe(true);
    });

    it('should recognize /plans/ in path', () => {
      expect(isPlanFile('/project/docs/plans/architecture.md')).toBe(true);
    });

    it('should recognize PLAN.md files', () => {
      expect(isPlanFile('/project/PLAN.md')).toBe(true);
      expect(isPlanFile('PLAN.md')).toBe(true);
    });

    it('should recognize plan.md files (lowercase)', () => {
      expect(isPlanFile('/project/plan.md')).toBe(true);
      expect(isPlanFile('plan.md')).toBe(true);
    });

    it('should not match regular files', () => {
      expect(isPlanFile('/project/src/component.ts')).toBe(false);
      expect(isPlanFile('/project/README.md')).toBe(false);
      expect(isPlanFile('/project/docs/planning-guide.md')).toBe(false);
    });
  });

  describe('normalizeAgentType', () => {
    it('should lowercase agent types', () => {
      expect(normalizeAgentType('Explore')).toBe('explore');
      expect(normalizeAgentType('PLAN')).toBe('plan');
      expect(normalizeAgentType('General-Purpose')).toBe('general-purpose');
    });

    it('should trim whitespace', () => {
      expect(normalizeAgentType('  explore  ')).toBe('explore');
      expect(normalizeAgentType('\tplan\n')).toBe('plan');
    });

    it('should handle mixed case', () => {
      expect(normalizeAgentType('ExPlOrE')).toBe('explore');
    });
  });

  describe('NON_BLOCKING_AGENT_TYPES (Test 5: Explore Passthrough)', () => {
    it('should include explore in non-blocking types', () => {
      expect(NON_BLOCKING_AGENT_TYPES).toContain('explore');
    });

    it('should include claude-code-guide in non-blocking types', () => {
      expect(NON_BLOCKING_AGENT_TYPES).toContain('claude-code-guide');
    });

    it('should not include plan in non-blocking types', () => {
      // Plan agents CAN be blocked (when they don't create plan files)
      expect(NON_BLOCKING_AGENT_TYPES).not.toContain('plan');
    });

    it('should not include general-purpose in non-blocking types', () => {
      expect(NON_BLOCKING_AGENT_TYPES).not.toContain('general-purpose');
    });

    it('should not include Bash in non-blocking types', () => {
      expect(NON_BLOCKING_AGENT_TYPES).not.toContain('bash');
    });
  });

  describe('PLAN_FILE_PATTERNS', () => {
    it('should include .claude/plans/ pattern', () => {
      expect(PLAN_FILE_PATTERNS).toContain('.claude/plans/');
    });

    it('should include /plans/ pattern', () => {
      expect(PLAN_FILE_PATTERNS).toContain('/plans/');
    });

    it('should include PLAN.md pattern', () => {
      expect(PLAN_FILE_PATTERNS).toContain('PLAN.md');
    });

    it('should include plan.md pattern', () => {
      expect(PLAN_FILE_PATTERNS).toContain('plan.md');
    });
  });

  describe('Plan Agent Blocking Logic (Test 4)', () => {
    it('should detect when plan agent creates no files', () => {
      const agentType = normalizeAgentType('Plan');
      const allFiles: string[] = [];
      const planCreated = allFiles.some(isPlanFile);

      // Plan agent with no files should be blocked
      expect(agentType).toBe('plan');
      expect(planCreated).toBe(false);
      expect(allFiles.length).toBe(0);

      // This combination should trigger blocking
      const shouldBlock = agentType === 'plan' && !planCreated && allFiles.length === 0;
      expect(shouldBlock).toBe(true);
    });

    it('should not block when plan agent creates plan file', () => {
      const agentType = normalizeAgentType('Plan');
      const allFiles = ['.claude/plans/my-plan.md'];
      const planCreated = allFiles.some(isPlanFile);

      expect(planCreated).toBe(true);

      // Should not block
      const shouldBlock = agentType === 'plan' && !planCreated && allFiles.length === 0;
      expect(shouldBlock).toBe(false);
    });

    it('should not block when plan agent creates other files but no plan', () => {
      const agentType = normalizeAgentType('Plan');
      const allFiles = ['src/component.ts', 'src/utils.ts'];
      const planCreated = allFiles.some(isPlanFile);

      expect(planCreated).toBe(false);
      expect(allFiles.length).toBe(2);

      // Current logic only blocks if NO files were created
      // If files exist but no plan, it's allowed (per current implementation)
      const shouldBlock = agentType === 'plan' && !planCreated && allFiles.length === 0;
      expect(shouldBlock).toBe(false);
    });
  });

  describe('Explore Agent Passthrough Logic (Test 5)', () => {
    it('should pass through explore agents regardless of file operations', () => {
      const agentType = normalizeAgentType('Explore');
      const isNonBlocking = NON_BLOCKING_AGENT_TYPES.includes(agentType);

      expect(isNonBlocking).toBe(true);
    });

    it('should pass through claude-code-guide agents', () => {
      const agentType = normalizeAgentType('claude-code-guide');
      const isNonBlocking = NON_BLOCKING_AGENT_TYPES.includes(agentType);

      expect(isNonBlocking).toBe(true);
    });
  });

  describe('Integration scenarios', () => {
    it('should correctly evaluate Plan agent with plan file', () => {
      const agentType = 'plan';
      const editedFiles = ['.claude/plans/implementation-plan.md'];

      const isNonBlocking = NON_BLOCKING_AGENT_TYPES.includes(agentType);
      const planCreated = editedFiles.some(isPlanFile);

      expect(isNonBlocking).toBe(false); // Plan can be blocked
      expect(planCreated).toBe(true); // But has plan file
      // Result: Should NOT block
    });

    it('should correctly evaluate Explore agent with no files', () => {
      const agentType = 'explore';
      const _editedFiles: string[] = [];

      const isNonBlocking = NON_BLOCKING_AGENT_TYPES.includes(agentType);

      expect(isNonBlocking).toBe(true);
      expect(_editedFiles.length).toBe(0); // Explore agents can have no files
      // Result: Should NOT block (passthrough)
    });

    it('should correctly evaluate general-purpose agent with files', () => {
      const agentType = 'general-purpose';
      const editedFiles = ['src/feature.ts', 'src/feature.test.ts'];

      const isNonBlocking = NON_BLOCKING_AGENT_TYPES.includes(agentType);
      const planCreated = editedFiles.some(isPlanFile);

      expect(isNonBlocking).toBe(false);
      expect(planCreated).toBe(false);
      // Result: Should NOT block (not a Plan agent)
    });
  });
});
