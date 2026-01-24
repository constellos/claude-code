/**
 * Task state management for Claude Code hooks
 *
 * Coordinates context between PreToolUse[Task] and SubagentStop hooks by saving
 * task call metadata at PreToolUse time and retrieving it later for analysis.
 * This enables tracking what tasks were requested, what agents executed them,
 * and what file operations resulted from the task execution.
 *
 * The typical flow is:
 * 1. PreToolUse[Task] - Save task context (prompt, agent type, tool use ID)
 * 2. Task executes - Agent runs and performs file operations
 * 3. SubagentStop - Load context, analyze edits, cleanup
 *
 * @module task-state
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  parseTranscript,
  findTaskCallForAgent,
  getNewFiles,
  getDeletedFiles,
  getEditedFiles,
} from './transcripts.js';
import matter from './frontmatter.js';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const TASK_CALLS_FILE = 'task-calls.json';

// ============================================================================
// Types
// ============================================================================

export interface TaskCallContext {
  toolUseId: string;
  agentType: string;
  sessionId: string;
  timestamp: string;
  prompt: string;
}

interface TaskCallsMap {
  [toolUseId: string]: TaskCallContext;
}

export interface TaskEditsResult {
  sessionId: string;
  agentSessionId: string;
  parentSessionTranscript: string;
  agentSessionTranscript: string;
  subagentType: string;
  agentPrompt: string;
  agentFile?: string;
  agentPreloadedSkillsFiles: string[];
  agentNewFiles: string[];
  agentDeletedFiles: string[];
  agentEditedFiles: string[];
}

// ============================================================================
// Context Management
// ============================================================================

/**
 * Get the path to task-calls.json
 */
function getTasksFilePath(cwd: string, customPath?: string): string {
  return customPath || path.join(cwd, LOGS_DIR, TASK_CALLS_FILE);
}

/**
 * Save task call context at PreToolUse[Task] for later retrieval at SubagentStop
 *
 * Stores task metadata in .claude/logs/task-calls.json so that SubagentStop hooks
 * can correlate the task's original prompt and parameters with the agent's execution
 * results. This enables rich commit messages and task tracking.
 *
 * @param input - Task call metadata to save
 * @param input.tool_use_id - The unique ID of the Task tool use
 * @param input.agent_type - The type of agent that will execute (e.g., 'Explore', 'Plan')
 * @param input.session_id - The current session ID
 * @param input.prompt - The task prompt/description provided to the agent
 * @param input.cwd - The working directory where logs should be stored
 * @param outputPath - Optional custom path for task-calls.json (for testing)
 * @returns The saved context object
 *
 * @example
 * ```typescript
 * import { saveTaskCallContext } from './task-state.js';
 *
 * // In PreToolUse[Task] hook
 * const context = await saveTaskCallContext({
 *   tool_use_id: 'toolu_abc123',
 *   agent_type: 'Explore',
 *   session_id: 'session-xyz',
 *   prompt: 'Find all API endpoints',
 *   cwd: '/path/to/project'
 * });
 * ```
 */
export async function saveTaskCallContext(
  input: {
    tool_use_id: string;
    agent_type: string;
    session_id: string;
    prompt: string;
    cwd: string;
  },
  outputPath?: string
): Promise<TaskCallContext> {
  const contextPath = getTasksFilePath(input.cwd, outputPath);
  const timestamp = new Date().toISOString();

  const context: TaskCallContext = {
    toolUseId: input.tool_use_id,
    agentType: input.agent_type,
    sessionId: input.session_id,
    timestamp,
    prompt: input.prompt,
  };

  // Load existing contexts
  let contexts: TaskCallsMap = {};
  try {
    const existing = await fs.readFile(contextPath, 'utf-8');
    contexts = JSON.parse(existing);
  } catch {
    // File doesn't exist yet
  }

  contexts[input.tool_use_id] = context;

  // Ensure directory exists
  await fs.mkdir(path.dirname(contextPath), { recursive: true });
  await fs.writeFile(contextPath, JSON.stringify(contexts, null, 2), 'utf-8');

  return context;
}

/**
 * Load saved task call context from PreToolUse[Task]
 *
 * Retrieves the task metadata that was saved during PreToolUse. This allows
 * SubagentStop hooks to access the original task prompt and parameters.
 *
 * @param toolUseId - The tool_use_id from the Task tool call
 * @param cwd - The working directory where logs are stored
 * @param contextPath - Optional custom path for task-calls.json (for testing)
 * @returns The saved context, or undefined if not found
 *
 * @example
 * ```typescript
 * import { loadTaskCallContext } from './task-state.js';
 *
 * // In SubagentStop hook
 * const context = await loadTaskCallContext(
 *   'toolu_abc123',
 *   '/path/to/project'
 * );
 * if (context) {
 *   console.log('Task prompt:', context.prompt);
 *   console.log('Agent type:', context.agentType);
 * }
 * ```
 */
export async function loadTaskCallContext(
  toolUseId: string,
  cwd: string,
  contextPath?: string
): Promise<TaskCallContext | undefined> {
  const filePath = getTasksFilePath(cwd, contextPath);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const contexts: TaskCallsMap = JSON.parse(content);
    return contexts[toolUseId];
  } catch {
    return undefined;
  }
}

/**
 * Remove task context after processing
 *
 * Cleans up the saved task context once it has been processed by SubagentStop.
 * This prevents the context file from growing indefinitely.
 *
 * @param toolUseId - The tool_use_id of the context to remove
 * @param cwd - The working directory where logs are stored
 * @param contextPath - Optional custom path for task-calls.json (for testing)
 * @returns Promise that resolves when context is removed (or fails silently)
 *
 * @example
 * ```typescript
 * import { removeTaskCallContext } from './task-state.js';
 *
 * // After processing in SubagentStop
 * await removeTaskCallContext('toolu_abc123', '/path/to/project');
 * ```
 */
export async function removeTaskCallContext(
  toolUseId: string,
  cwd: string,
  contextPath?: string
): Promise<void> {
  const filePath = getTasksFilePath(cwd, contextPath);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const contexts: TaskCallsMap = JSON.parse(content);
    delete contexts[toolUseId];
    await fs.writeFile(filePath, JSON.stringify(contexts, null, 2), 'utf-8');
  } catch {
    // Nothing to remove
  }
}

// ============================================================================
// Task Edits Analysis
// ============================================================================

/**
 * Parse YAML frontmatter from an agent markdown file
 */
async function parseAgentFrontmatter(
  filePath: string
): Promise<{ name?: string; skills?: string[] }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const { data } = matter(content);
    return data as { name?: string; skills?: string[] };
  } catch {
    return {};
  }
}

/**
 * Analyze a task transcript to extract comprehensive edit information
 *
 * Parses an agent transcript to determine what files were created, edited, or deleted
 * during task execution. Correlates with saved task context to provide complete
 * metadata about the task, including the original prompt, agent type, and preloaded skills.
 *
 * This function:
 * 1. Parses the agent transcript to extract messages and metadata
 * 2. Finds the parent session transcript and locates the matching Task tool call
 * 3. Loads the saved task context (if available)
 * 4. Analyzes file operations (new, edited, deleted files)
 * 5. Identifies preloaded skills from agent frontmatter
 * 6. Cleans up the saved context
 *
 * @param agentTranscriptPath - Path to the agent transcript file (from SubagentStop's agent_transcript_path field)
 * @param options - Optional configuration
 * @param options.contextPath - Custom path for task-calls.json (for testing)
 * @param options.subagentType - Fallback subagent type if not found in context
 * @returns Comprehensive task execution metadata and file operation lists
 * @throws Error if agent transcript is empty
 * @throws Error if agentId cannot be determined
 * @throws Error if parent session transcript not found
 *
 * @example
 * ```typescript
 * import { getTaskEdits } from './task-state.js';
 *
 * // In SubagentStop hook
 * const edits = await getTaskEdits(input.agent_transcript_path);
 *
 * console.log('Task prompt:', edits.agentPrompt);
 * console.log('Agent type:', edits.subagentType);
 * console.log('Files created:', edits.agentNewFiles);
 * console.log('Files edited:', edits.agentEditedFiles);
 * console.log('Files deleted:', edits.agentDeletedFiles);
 * console.log('Preloaded skills:', edits.agentPreloadedSkillsFiles);
 * ```
 *
 * @example
 * ```typescript
 * // Complete PreToolUse → SubagentStop flow
 *
 * // 1. PreToolUse[Task] - Save context
 * import { saveTaskCallContext } from './task-state.js';
 *
 * async function handlePreToolUse(input: PreToolUseInput) {
 *   if (input.tool_name === 'Task') {
 *     await saveTaskCallContext({
 *       tool_use_id: input.tool_use_id,
 *       agent_type: input.tool_input.subagent_type,
 *       session_id: input.session_id,
 *       prompt: input.tool_input.prompt,
 *       cwd: input.cwd
 *     });
 *   }
 *   return { hookSpecificOutput: { permissionDecision: 'allow' } };
 * }
 *
 * // 2. Task executes (agent runs)
 *
 * // 3. SubagentStop - Analyze edits
 * import { getTaskEdits } from './task-state.js';
 *
 * async function handleSubagentStop(input: SubagentStopInput) {
 *   const edits = await getTaskEdits(input.agent_transcript_path);
 *
 *   // Use edits for commit message, logging, etc.
 *   console.log(`Task "${edits.agentPrompt}" completed`);
 *   console.log(`Modified ${edits.agentEditedFiles.length} files`);
 *
 *   return {};
 * }
 * ```
 */
export async function getTaskEdits(
  agentTranscriptPath: string,
  options?: {
    contextPath?: string;
    subagentType?: string;
  }
): Promise<TaskEditsResult> {
  // Parse agent transcript
  const agentTranscript = await parseTranscript(agentTranscriptPath);
  const firstMsg = agentTranscript.messages[0];
  if (!firstMsg) {
    throw new Error(`Agent transcript is empty: ${agentTranscriptPath}`);
  }

  const sessionId = firstMsg.sessionId;
  const cwd = firstMsg.cwd;
  const agentId = agentTranscript.agentId;
  const agentStartTimestamp = firstMsg.timestamp;

  if (!agentId) {
    throw new Error(`Could not determine agentId from transcript: ${agentTranscriptPath}`);
  }

  // Find parent session transcript
  // Agent transcripts are at: .../project/{sessionId}/subagents/agent-{agentId}.jsonl
  // Parent transcripts are at: .../project/{sessionId}.jsonl
  let dir = path.dirname(agentTranscriptPath); // .../sessionId/subagents/
  if (path.basename(dir) === 'subagents') {
    dir = path.dirname(dir); // .../sessionId/
  }
  dir = path.dirname(dir); // .../project/
  const parentPath = path.join(dir, `${sessionId}.jsonl`);

  try {
    await fs.access(parentPath);
  } catch {
    throw new Error(`Parent session transcript not found: ${parentPath}`);
  }

  // Parse parent transcript and find matching Task call
  const parentTranscript = await parseTranscript(parentPath);
  const taskInfo = findTaskCallForAgent(parentTranscript, agentId, {
    subagentType: options?.subagentType,
    agentStartTimestamp,
  });

  // Try to load saved context using tool_use_id from task call
  let savedContext: TaskCallContext | undefined;
  if (cwd && taskInfo?.toolUseId) {
    savedContext = await loadTaskCallContext(taskInfo.toolUseId, cwd, options?.contextPath);
  }

  const subagentType = taskInfo?.subagentType || savedContext?.agentType || options?.subagentType || 'unknown';
  const agentPrompt = savedContext?.prompt || taskInfo?.prompt || '';
  const toolUseId = taskInfo?.toolUseId || savedContext?.toolUseId;

  // Find agent definition file
  let agentFile: string | undefined;
  if (cwd) {
    const agentFilePath = path.join(cwd, '.claude', 'agents', `${subagentType}.md`);
    try {
      await fs.access(agentFilePath);
      agentFile = agentFilePath;
    } catch {
      // Agent file doesn't exist
    }
  }

  // Parse agent frontmatter for skills
  let skills: string[] = [];
  if (agentFile) {
    const frontmatter = await parseAgentFrontmatter(agentFile);
    skills = frontmatter.skills || [];
  }

  const agentPreloadedSkillsFiles = cwd
    ? skills.map((s) => path.join(cwd, '.claude', 'skills', s, 'SKILL.md'))
    : [];

  // Get file operations
  const agentNewFiles = getNewFiles(agentTranscript);
  const agentDeletedFiles = getDeletedFiles(agentTranscript);
  const agentEditedFiles = getEditedFiles(agentTranscript);

  // Cleanup saved context
  if (cwd && toolUseId) {
    await removeTaskCallContext(toolUseId, cwd, options?.contextPath);
  }

  return {
    sessionId,
    agentSessionId: agentId,
    parentSessionTranscript: parentPath,
    agentSessionTranscript: agentTranscriptPath,
    subagentType,
    agentPrompt,
    agentFile,
    agentPreloadedSkillsFiles,
    agentNewFiles,
    agentDeletedFiles,
    agentEditedFiles,
  };
}
