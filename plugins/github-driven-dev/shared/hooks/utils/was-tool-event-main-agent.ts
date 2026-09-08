/**
 * Utility to determine if a tool event was executed by the main agent vs a subagent
 */

import { parseTranscript, type AssistantMessage } from './transcripts.js';

/**
 * Check if a specific tool use was executed by the main agent (not a subagent)
 *
 * @param transcriptPath - Path to the session transcript JSONL file
 * @param toolUseId - The tool_use_id to check
 * @returns true if the tool was used by the main agent, false if by a subagent
 *
 * @example
 * ```typescript
 * const isMainAgent = await wasToolEventMainAgent(
 *   input.transcript_path,
 *   input.tool_use_id
 * );
 * if (!isMainAgent) {
 *   // Skip processing for subagent tool use
 *   return { continue: true };
 * }
 * ```
 */
export async function wasToolEventMainAgent(
  transcriptPath: string,
  toolUseId: string
): Promise<boolean> {
  const transcript = await parseTranscript(transcriptPath);

  // Find the assistant message containing this tool use
  for (const msg of transcript.messages) {
    if (msg.type === 'assistant') {
      const assistantMsg = msg as AssistantMessage;
      const toolUse = assistantMsg.message.content.find(
        (c) => c.type === 'tool_use' && 'id' in c && c.id === toolUseId
      );

      if (toolUse) {
        // If agentId is undefined/null, it's the main agent
        // If agentId is a string, it's a subagent
        return !msg.agentId;
      }
    }
  }

  // If we can't find the tool use, default to assuming it's the main agent
  // This is safer than blocking legitimate main agent operations
  return true;
}

/**
 * Check if the entire transcript is from the main agent session (not a subagent session)
 *
 * @param transcriptPath - Path to the session transcript JSONL file
 * @returns true if this is a main agent transcript, false if it's a subagent transcript
 *
 * @example
 * ```typescript
 * const isMainSession = await isMainAgentTranscript(input.transcript_path);
 * if (!isMainSession) {
 *   // This is a subagent session, skip processing
 *   return { continue: true };
 * }
 * ```
 */
export async function isMainAgentTranscript(transcriptPath: string): Promise<boolean> {
  const transcript = await parseTranscript(transcriptPath);
  return !transcript.isSidechain;
}

/**
 * Check if a transcript belongs to a specific subagent type
 *
 * @param transcriptPath - Path to the session transcript JSONL file
 * @param subagentType - The subagent type to check for (e.g., "Explore", "Plan")
 * @returns true if the transcript is from the specified subagent type
 *
 * @example
 * ```typescript
 * const isExploreAgent = await isSubagentType(input.transcript_path, 'Explore');
 * if (isExploreAgent) {
 *   // Special handling for Explore agents
 * }
 * ```
 */
export async function isSubagentType(
  transcriptPath: string,
  subagentType: string
): Promise<boolean> {
  const transcript = await parseTranscript(transcriptPath);
  return transcript.subagentType === subagentType;
}

/**
 * Get the agent ID from a transcript (undefined for main agent, string for subagents)
 *
 * @param transcriptPath - Path to the session transcript JSONL file
 * @returns The agent ID if this is a subagent, undefined if main agent
 *
 * @example
 * ```typescript
 * const agentId = await getTranscriptAgentId(input.transcript_path);
 * if (agentId) {
 *   console.log(`Processing subagent: ${agentId}`);
 * } else {
 *   console.log('Processing main agent');
 * }
 * ```
 */
export async function getTranscriptAgentId(transcriptPath: string): Promise<string | undefined> {
  const transcript = await parseTranscript(transcriptPath);
  return transcript.agentId;
}
