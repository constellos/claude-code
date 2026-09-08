/**
 * Hook Utilities - Re-exports
 *
 * Centralized exports for all hook utility functions, types, and helpers.
 * This index file provides convenient access to all shared utilities used
 * across Claude Code plugins.
 *
 * For smaller bundle sizes, prefer importing directly from individual modules
 * rather than using this index file. Direct imports allow tree-shaking to
 * eliminate unused code.
 *
 * @example
 * ```typescript
 * // Preferred: Direct import (better for tree-shaking)
 * import { readStdinJson } from './utils/io.js';
 * import { createDebugLogger } from './utils/debug.js';
 *
 * // Alternative: Import from index (more convenient)
 * import { readStdinJson, createDebugLogger } from './utils/index.js';
 * ```
 *
 * @module utils/index
 */

// ============================================================================
// I/O Utilities and Hook Runner
// ============================================================================
// Functions for reading hook input from stdin, writing output to stdout,
// and wrapping hook handlers for execution.

export { readStdinJson, writeStdoutJson, runHook, type HookHandler } from './io.js';

// ============================================================================
// Debug Utilities
// ============================================================================
// Debug logging with JSONL output to .claude/logs/hook-events.json.
// Supports DEBUG environment variable for filtering output.

export {
  createDebugLogger,
  createBlockingErrorResponse,
  createPassthroughResponse,
  type DebugConfig,
  type DebugLogger,
  type HookEventEntry,
} from './debug.js';

// ============================================================================
// Transcript Parsing
// ============================================================================
// Parse Claude Code transcript JSONL files to analyze agent conversations,
// tool uses, and file operations.

export {
  parseTranscript,
  parseTranscriptLine,
  getTranscriptInfo,
  getToolUses,
  getEditedFiles,
  getNewFiles,
  getDeletedFiles,
  findPendingTaskCall,
  findTaskCallForAgent,
  type Transcript,
  type Message,
  type UserMessage,
  type AssistantMessage,
  type SystemMessage,
} from './transcripts.js';

// ============================================================================
// Subagent State Management
// ============================================================================
// Save and load subagent execution context, and analyze file operations
// performed by agents.

export {
  saveAgentStartContext,
  loadAgentStartContext,
  removeAgentStartContext,
  getAgentEdits,
  type AgentStartContext,
  type AgentEditsResult,
} from './subagent-state.js';

// ============================================================================
// Task State Management
// ============================================================================
// Save and load Task tool call context, and analyze file operations
// performed within tasks.

export {
  saveTaskCallContext,
  loadTaskCallContext,
  removeTaskCallContext,
  getTaskEdits,
  type TaskCallContext,
  type TaskEditsResult,
} from './task-state.js';

// ============================================================================
// Package Manager Detection
// ============================================================================
// Detect which package manager (npm, yarn, pnpm, bun) a project uses
// and construct appropriate commands.

export { detectPackageManager, getScriptCommand } from './package-manager.js';

// ============================================================================
// TOML Parsing
// ============================================================================
// Simple TOML parser for reading configuration files like supabase/config.toml.

export { parseToml, readTomlFile, type TomlValue } from './toml.js';

// ============================================================================
// Agent Type Detection
// ============================================================================
// Utilities for determining if a tool event was triggered by the main agent
// or a subagent, and extracting agent IDs from transcripts.

export {
  wasToolEventMainAgent,
  isMainAgentTranscript,
  isSubagentType,
  getTranscriptAgentId,
} from './was-tool-event-main-agent.js';

// ============================================================================
// Log File Utilities
// ============================================================================
// Save hook output to log files and return concise summaries.
// Used to reduce context injection while preserving full output for debugging.

export {
  saveOutputToLog,
  parseEslintCounts,
  parseTscErrorCount,
  parseVitestResults,
  parseCiChecks,
  formatCiChecksTable,
  formatErrorSummary,
  formatSuccessMessage,
} from './log-file.js';

// ============================================================================
// Work Type Detection
// ============================================================================
// Detect work type from prompts and issue labels for branch naming and
// issue categorization.

export {
  detectWorkType,
  formatWorkTypeLabel,
  type WorkType,
} from './work-type-detector.js';

// ============================================================================
// Branch Naming
// ============================================================================
// Generate, parse, and validate branch names following the convention
// {issueNumber}-{workType}/{kebab-name}.

export {
  generateBranchName,
  parseBranchName,
  validateBranchName,
  extractIssueNumber,
  toKebabCase,
  type ParsedBranchName,
  type BranchValidation,
} from './branch-naming.js';

// ============================================================================
// Issue Templates
// ============================================================================
// GitHub issue templates for bug reports, feature requests, and epics.

export {
  getBugTemplate,
  getFeatureTemplate,
  getEpicTemplate,
  getTaskTemplate,
  renderTemplate,
  getMinimalIssueBody,
  addBranchReference,
  type TemplateVars,
} from './issue-templates.js';

// ============================================================================
// PR Templates
// ============================================================================
// GitHub PR templates and description generation from commits.

export {
  getFeaturePRTemplate,
  getBugfixPRTemplate,
  getChorePRTemplate,
  getDocsPRTemplate,
  getRefactorPRTemplate,
  getPRTemplateByWorkType,
  renderPRTemplate,
  generatePRDescription,
  extractCommitType,
  groupCommitsByType,
  formatGroupedCommits,
  type PRTemplateVars,
} from './pr-templates.js';

