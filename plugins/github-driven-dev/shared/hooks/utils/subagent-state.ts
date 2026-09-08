/**
 * Subagent state management for Claude Code hooks
 * Coordinates context between SubagentStart and SubagentStop hooks
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import matter from './frontmatter.js';
import {
  parseTranscript,
  findPendingTaskCall,
  findTaskCallForAgent,
  getNewFiles,
  getDeletedFiles,
  getEditedFiles,
} from './transcripts.js';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const SUBAGENT_TASKS_FILE = 'subagent-tasks.json';

// ============================================================================
// Types
// ============================================================================

export interface AgentStartContext {
  agentId: string;
  agentType: string;
  sessionId: string;
  timestamp: string;
  prompt: string;
  toolUseId: string;
}

interface SubagentTasksMap {
  [agentId: string]: AgentStartContext;
}

export interface AgentEditsResult {
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
 * Get the path to subagent-tasks.json
 */
function getTasksFilePath(cwd: string, customPath?: string): string {
  return customPath || path.join(cwd, LOGS_DIR, SUBAGENT_TASKS_FILE);
}

/**
 * Save agent context at SubagentStart for later retrieval at SubagentStop
 */
export async function saveAgentStartContext(
  input: {
    agent_id: string;
    agent_type: string;
    session_id: string;
    cwd: string;
    transcript_path: string;
  },
  outputPath?: string
): Promise<AgentStartContext> {
  const contextPath = getTasksFilePath(input.cwd, outputPath);
  const timestamp = new Date().toISOString();

  // Parse parent transcript to find the Task call
  const parentTranscript = await parseTranscript(input.transcript_path);
  const taskInfo = findPendingTaskCall(parentTranscript, input.agent_type);

  const context: AgentStartContext = {
    agentId: input.agent_id,
    agentType: input.agent_type,
    sessionId: input.session_id,
    timestamp,
    prompt: taskInfo?.prompt || '',
    toolUseId: taskInfo?.toolUseId || '',
  };

  // Load existing contexts
  let contexts: SubagentTasksMap = {};
  try {
    const existing = await fs.readFile(contextPath, 'utf-8');
    contexts = JSON.parse(existing);
  } catch {
    // File doesn't exist yet
  }

  contexts[input.agent_id] = context;

  // Ensure directory exists
  await fs.mkdir(path.dirname(contextPath), { recursive: true });
  await fs.writeFile(contextPath, JSON.stringify(contexts, null, 2), 'utf-8');

  return context;
}

/**
 * Load saved agent context from SubagentStart
 */
export async function loadAgentStartContext(
  agentId: string,
  cwd: string,
  contextPath?: string
): Promise<AgentStartContext | undefined> {
  const filePath = getTasksFilePath(cwd, contextPath);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const contexts: SubagentTasksMap = JSON.parse(content);
    return contexts[agentId];
  } catch {
    return undefined;
  }
}

/**
 * Remove agent context after SubagentStop processing
 */
export async function removeAgentStartContext(
  agentId: string,
  cwd: string,
  contextPath?: string
): Promise<void> {
  const filePath = getTasksFilePath(cwd, contextPath);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const contexts: SubagentTasksMap = JSON.parse(content);
    delete contexts[agentId];
    await fs.writeFile(filePath, JSON.stringify(contexts, null, 2), 'utf-8');
  } catch {
    // Nothing to remove
  }
}

// ============================================================================
// Agent Edits Analysis
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
 * Analyze an agent transcript to extract comprehensive edit information
 */
export async function getAgentEdits(
  agentTranscriptPath: string,
  options?: {
    contextPath?: string;
    subagentType?: string;
  }
): Promise<AgentEditsResult> {
  const filename = path.basename(agentTranscriptPath);
  if (!filename.startsWith('agent-')) {
    throw new Error(`Path must be an agent transcript (starting with agent-): ${filename}`);
  }

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
  const dir = path.dirname(agentTranscriptPath);
  const parentPath = path.join(dir, `${sessionId}.jsonl`);

  try {
    await fs.access(parentPath);
  } catch {
    throw new Error(`Parent session transcript not found: ${parentPath}`);
  }

  // Try to load saved context
  let savedContext: AgentStartContext | undefined;
  if (cwd) {
    savedContext = await loadAgentStartContext(agentId, cwd, options?.contextPath);
  }

  // Parse parent transcript and find matching Task call
  const parentTranscript = await parseTranscript(parentPath);
  const taskInfo = findTaskCallForAgent(parentTranscript, agentId, {
    toolUseId: savedContext?.toolUseId,
    subagentType: savedContext?.agentType || options?.subagentType,
    agentStartTimestamp,
  });

  const subagentType = taskInfo?.subagentType || savedContext?.agentType || options?.subagentType || 'unknown';
  const agentPrompt = taskInfo?.prompt || savedContext?.prompt || '';

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
  if (cwd) {
    await removeAgentStartContext(agentId, cwd, options?.contextPath);
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
