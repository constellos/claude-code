/**
 * Transcript parsing utilities for Claude Code
 * Lenient JSONL parsing without Zod - uses type guards for safety
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Types for Transcript Parsing
// ============================================================================

export interface BaseMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  isSidechain: boolean;
  cwd: string;
  version: string;
  gitBranch?: string;
  slug?: string;
  agentId?: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
}

export type AssistantContent = ToolUseContent | TextContent | { type: string; [key: string]: unknown };
export type UserContent = string | Array<ToolResultContent | { type: string; [key: string]: unknown }>;

export interface UserMessage extends BaseMessage {
  type: 'user';
  userType: 'external';
  message: {
    role: 'user';
    content: UserContent;
  };
  toolUseResult?: Record<string, unknown>;
}

export interface AssistantMessage extends BaseMessage {
  type: 'assistant';
  requestId: string;
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: AssistantContent[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface SystemMessage extends BaseMessage {
  type: 'system';
  subtype: string;
  content: string;
  isMeta: boolean;
  level: 'info' | 'warning' | 'error';
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

export interface Transcript {
  sourcePath: string;
  sessionId: string;
  subagentType?: string;
  agentId?: string;
  isSidechain: boolean;
  messages: Message[];
}

// ============================================================================
// Type Guards
// ============================================================================

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessage(line: unknown): line is Message {
  if (!isObject(line)) return false;
  const type = line.type;
  return type === 'user' || type === 'assistant' || type === 'system';
}

function hasRequiredFields(line: unknown): boolean {
  if (!isObject(line)) return false;
  return (
    typeof line.uuid === 'string' &&
    typeof line.timestamp === 'string' &&
    typeof line.sessionId === 'string'
  );
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse a single JSONL line (lenient - returns null on error)
 */
export function parseTranscriptLine(line: string): Message | null {
  try {
    const json = JSON.parse(line);
    if (!isMessage(json) || !hasRequiredFields(json)) {
      return null;
    }
    return json as Message;
  } catch {
    return null;
  }
}

/**
 * Get transcript metadata from file path
 */
export function getTranscriptInfo(filePath: string): { agentId?: string; isSidechain: boolean } {
  const filename = path.basename(filePath);
  const isSubagent = filename.startsWith('agent-');
  const agentId = isSubagent ? filename.replace('agent-', '').replace('.jsonl', '') : undefined;

  return { agentId, isSidechain: isSubagent };
}

/**
 * Parse a full .jsonl transcript file
 */
export async function parseTranscript(filePath: string): Promise<Transcript> {
  const info = getTranscriptInfo(filePath);
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const messages: Message[] = [];
  let sessionId = '';

  for (const line of lines) {
    const parsed = parseTranscriptLine(line);
    if (!parsed) continue;

    if (!sessionId) sessionId = parsed.sessionId;
    messages.push(parsed);
  }

  return {
    sourcePath: filePath,
    sessionId,
    agentId: info.agentId,
    isSidechain: info.isSidechain,
    messages,
  };
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Extract all tool uses from a transcript
 */
export function getToolUses(transcript: Transcript): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}> {
  const toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: string;
  }> = [];

  for (const msg of transcript.messages) {
    if (msg.type !== 'assistant') continue;

    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const tu = content as ToolUseContent;
        toolUses.push({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          timestamp: msg.timestamp,
        });
      }
    }
  }

  return toolUses;
}

/**
 * Extract unique file paths edited by Write/Edit tools
 */
export function getEditedFiles(transcript: Transcript): string[] {
  const files = new Set<string>();

  for (const msg of transcript.messages) {
    if (msg.type !== 'assistant') continue;

    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const tu = content as ToolUseContent;
        if (tu.name === 'Write' || tu.name === 'Edit') {
          const filePath = tu.input.file_path;
          if (typeof filePath === 'string') {
            files.add(filePath);
          }
        }
      }
    }
  }

  return Array.from(files);
}

/**
 * Extract unique file paths created by Write tool (new files only)
 */
export function getNewFiles(transcript: Transcript): string[] {
  const newFiles: string[] = [];
  const seenPaths = new Set<string>();

  for (const msg of transcript.messages) {
    if (msg.type !== 'assistant') continue;

    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const tu = content as ToolUseContent;
        if (tu.name === 'Write') {
          const filePath = tu.input.file_path;
          if (typeof filePath === 'string' && !seenPaths.has(filePath)) {
            newFiles.push(filePath);
            seenPaths.add(filePath);
          }
        }
      }
    }
  }

  return newFiles;
}

/**
 * Extract unique file paths deleted via Bash rm commands
 */
export function getDeletedFiles(transcript: Transcript): string[] {
  const deletedFiles = new Set<string>();
  const rmPattern = /^\s*rm\s+(?:-[rfiv]+\s+)*(.+)$/;

  for (const msg of transcript.messages) {
    if (msg.type !== 'assistant') continue;

    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const tu = content as ToolUseContent;
        if (tu.name === 'Bash') {
          const command = tu.input.command;
          if (typeof command !== 'string') continue;

          const commands = command.split(/\s*(?:&&|;)\s*/);
          for (const cmd of commands) {
            const match = cmd.match(rmPattern);
            if (match) {
              const pathsStr = match[1].trim();
              const paths = pathsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

              for (const p of paths) {
                const cleanPath = p.replace(/^["']|["']$/g, '');
                if (!cleanPath.startsWith('-')) {
                  deletedFiles.add(cleanPath);
                }
              }
            }
          }
        }
      }
    }
  }

  return Array.from(deletedFiles);
}

/**
 * Find pending Task tool call matching agent type
 */
export function findPendingTaskCall(
  transcript: Transcript,
  agentType: string
): { subagentType: string; prompt: string; toolUseId: string } | undefined {
  const taskCalls: Array<{
    toolUseId: string;
    subagentType: string;
    prompt: string;
    timestamp: string;
  }> = [];

  // Collect all Task tool_use calls
  for (const msg of transcript.messages) {
    if (msg.type !== 'assistant') continue;

    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const tu = content as ToolUseContent;
        if (tu.name === 'Task') {
          taskCalls.push({
            toolUseId: tu.id,
            subagentType: (tu.input.subagent_type as string) || 'unknown',
            prompt: (tu.input.prompt as string) || '',
            timestamp: msg.timestamp,
          });
        }
      }
    }
  }

  // Collect completed tool_use_ids
  const completedToolUseIds = new Set<string>();
  for (const msg of transcript.messages) {
    if (msg.type !== 'user') continue;
    const content = msg.message.content;
    if (typeof content === 'string') continue;
    for (const rc of content) {
      if ('tool_use_id' in rc && typeof rc.tool_use_id === 'string') {
        completedToolUseIds.add(rc.tool_use_id);
      }
    }
  }

  // Find pending Task calls matching agent type
  const pendingTasks = taskCalls
    .filter((t) => !completedToolUseIds.has(t.toolUseId))
    .filter((t) => t.subagentType === agentType)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return pendingTasks[0];
}

/**
 * Find Task tool call for an agent using multiple strategies
 */
export function findTaskCallForAgent(
  transcript: Transcript,
  targetAgentId: string,
  options?: {
    subagentType?: string;
    toolUseId?: string;
    agentStartTimestamp?: string;
  }
): { subagentType: string; prompt: string; toolUseId: string } | undefined {
  const taskCalls = new Map<string, {
    subagentType: string;
    prompt: string;
    toolUseId: string;
    timestamp: string;
  }>();

  // Collect all Task tool_use calls
  for (const msg of transcript.messages) {
    if (msg.type !== 'assistant') continue;

    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const tu = content as ToolUseContent;
        if (tu.name === 'Task') {
          taskCalls.set(tu.id, {
            toolUseId: tu.id,
            subagentType: (tu.input.subagent_type as string) || 'unknown',
            prompt: (tu.input.prompt as string) || '',
            timestamp: msg.timestamp,
          });
        }
      }
    }
  }

  // Strategy 1: Direct lookup by toolUseId
  if (options?.toolUseId) {
    const direct = taskCalls.get(options.toolUseId);
    if (direct) return direct;
  }

  // Strategy 2: Match via tool_result.agentId
  for (const msg of transcript.messages) {
    if (msg.type !== 'user') continue;
    const toolResult = msg.toolUseResult as { agentId?: string } | undefined;
    if (toolResult?.agentId === targetAgentId) {
      const content = msg.message.content;
      if (typeof content === 'string') continue;

      for (const rc of content) {
        if ('tool_use_id' in rc && typeof rc.tool_use_id === 'string') {
          const taskInfo = taskCalls.get(rc.tool_use_id);
          if (taskInfo) return taskInfo;
        }
      }
    }
  }

  // Strategy 3: Fuzzy match by subagentType and timestamp
  if (options?.subagentType && options?.agentStartTimestamp) {
    const agentStartTime = new Date(options.agentStartTimestamp).getTime();
    const maxDelta = 10000; // 10 seconds

    const candidates = Array.from(taskCalls.values())
      .filter((t) => t.subagentType === options.subagentType)
      .filter((t) => {
        const taskTime = new Date(t.timestamp).getTime();
        return taskTime <= agentStartTime && agentStartTime - taskTime <= maxDelta;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (candidates[0]) return candidates[0];
  }

  return undefined;
}
