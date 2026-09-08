/**
 * Pure TypeScript types for Claude Code hooks
 *
 * This module provides comprehensive type definitions for all Claude Code hook events,
 * including inputs, outputs, and handler function signatures. These are pure TypeScript
 * types with no runtime dependencies (no Zod or other validation libraries).
 *
 * @module types
 * @example
 * ```typescript
 * import type { SubagentStopInput, SubagentStopHookOutput } from 'claude-code-kit-ts';
 *
 * export default async function(input: SubagentStopInput): Promise<SubagentStopHookOutput> {
 *   // Your hook implementation
 *   return { continue: true };
 * }
 * ```
 */

// ============================================================================
// Permission Mode
// ============================================================================

/**
 * Permission mode for Claude Code execution
 *
 * Determines how Claude Code handles operations that require user permission:
 * - `default`: Normal permission checking
 * - `plan`: Plan mode - Claude can only read and plan, not execute
 * - `acceptEdits`: Automatically accept all edit operations
 * - `bypassPermissions`: Bypass all permission checks
 */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

// ============================================================================
// Hook Event Names
// ============================================================================

/**
 * All available hook event names in Claude Code
 *
 * Hook events fire at specific points during Claude Code execution:
 * - `PreToolUse`: Before a tool is executed (can modify or block)
 * - `PostToolUse`: After a tool completes (can add context or block)
 * - `Notification`: When Claude sends a notification
 * - `UserPromptSubmit`: When user submits a prompt (can add context or block)
 * - `Stop`: When execution is stopping (can block the stop)
 * - `SubagentStart`: When a subagent (Task tool) begins execution
 * - `SubagentStop`: When a subagent completes
 * - `PreCompact`: Before transcript compaction occurs
 * - `SessionStart`: When a new session starts
 * - `SessionEnd`: When a session ends
 */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd";

// ============================================================================
// Base Hook Input/Output
// ============================================================================

/**
 * Base input provided to all hook functions
 *
 * All hook event inputs extend this interface with event-specific properties.
 */
export interface BaseHookInput {
  /** Unique identifier for the current Claude Code session */
  session_id: string;
  /**
   * Absolute path to the JSONL transcript file for this session
   *
   * IMPORTANT: This always points to the main session transcript, even when hooks
   * are executed within a subagent context. To access the current agent's transcript
   * in SubagentStop hooks, use the agent_transcript_path field instead.
   */
  transcript_path: string;
  /** Current working directory for the session */
  cwd: string;
  /** Current permission mode */
  permission_mode: PermissionMode;
}

/**
 * Base output that all hook functions can return
 *
 * All hook outputs can include these optional fields to control execution flow.
 */
export interface BaseHookOutput {
  /** If false, stops Claude Code execution (default: true) */
  continue?: boolean;
  /** Reason for stopping execution (shown to user when continue=false) */
  stopReason?: string;
  /** If true, suppresses the hook's output from being shown to the user */
  suppressOutput?: boolean;
  /** Additional message to display to Claude (not the user) */
  systemMessage?: string;
}

// ============================================================================
// PreToolUse Hook
// ============================================================================

/**
 * Input provided to PreToolUse hooks
 *
 * Fired before a tool is executed, allowing hooks to inspect and potentially
 * modify tool inputs or block tool execution based on custom logic.
 */
export interface PreToolUseInput extends BaseHookInput {
  /** Hook event name (always "PreToolUse") */
  hook_event_name: "PreToolUse";
  /** Unique ID for this tool use */
  tool_use_id: string;
  /** Name of the tool being called (e.g., "Read", "Write", "Bash") */
  tool_name: string;
  /** Input parameters passed to the tool */
  tool_input: unknown;
}

/**
 * Output from PreToolUse hooks
 *
 * Must include a permission decision to allow, deny, or ask the user about tool execution.
 * Can optionally modify tool inputs before execution.
 */
export type PreToolUseHookOutput = BaseHookOutput & {
  hookSpecificOutput:
    | {
        hookEventName: "PreToolUse";
        /** Allow the tool to execute */
        permissionDecision: "allow";
        /** Optional reason for allowing */
        permissionDecisionReason?: string;
        /** Optional modified tool input parameters */
        updatedInput?: Record<string, unknown>;
      }
    | {
        hookEventName: "PreToolUse";
        /** Deny or ask user about tool execution */
        permissionDecision: "deny" | "ask";
        /** Required reason for denying or asking */
        permissionDecisionReason: string;
      };
};

/**
 * PreToolUse hook function signature
 *
 * @example
 * ```typescript
 * export default async function(input: PreToolUseInput): Promise<PreToolUseHookOutput> {
 *   // Block writes to specific files
 *   if (input.tool_name === "Write" && input.tool_input.file_path.includes("config")) {
 *     return {
 *       hookSpecificOutput: {
 *         hookEventName: "PreToolUse",
 *         permissionDecision: "deny",
 *         permissionDecisionReason: "Config files are protected"
 *       }
 *     };
 *   }
 *   return {
 *     hookSpecificOutput: {
 *       hookEventName: "PreToolUse",
 *       permissionDecision: "allow"
 *     }
 *   };
 * }
 * ```
 */
export type PreToolUseHook = (
  input: PreToolUseInput
) => PreToolUseHookOutput | Promise<PreToolUseHookOutput>;

// ============================================================================
// PostToolUse Hook
// ============================================================================

/**
 * Input provided to PostToolUse hooks
 *
 * Fired after a tool completes execution, allowing hooks to inspect results,
 * add additional context, or block further execution based on tool output.
 */
export interface PostToolUseInput extends BaseHookInput {
  /** Hook event name (always "PostToolUse") */
  hook_event_name: "PostToolUse";
  /** Unique ID for this tool use */
  tool_use_id: string;
  /** Name of the tool that was called */
  tool_name: string;
  /** Input parameters that were passed to the tool */
  tool_input: unknown;
  /** Result returned by the tool */
  tool_response: unknown;
}

/**
 * Output from PostToolUse hooks
 *
 * Can add additional context for Claude or block execution based on tool results.
 */
export type PostToolUseHookOutput = BaseHookOutput &
  (
    | {
        /** No blocking decision (default: allow continuation) */
        decision?: undefined;
        /** Optional reason for allowing */
        reason?: string;
        hookSpecificOutput?: {
          hookEventName: "PostToolUse";
          /** Additional context to provide to Claude about the tool result */
          additionalContext?: string;
        };
      }
    | {
        /** Block further execution */
        decision: "block";
        /** Optional reason for blocking */
        reason?: string;
        hookSpecificOutput: {
          hookEventName: "PostToolUse";
          /** Required context when blocking */
          additionalContext: string;
        };
      }
  );

/**
 * PostToolUse hook function signature
 *
 * @example
 * ```typescript
 * export default async function(input: PostToolUseInput): Promise<PostToolUseHookOutput> {
 *   // Add context after file edits
 *   if (input.tool_name === "Edit") {
 *     return {
 *       hookSpecificOutput: {
 *         hookEventName: "PostToolUse",
 *         additionalContext: `File ${input.tool_input.file_path} was modified`
 *       }
 *     };
 *   }
 *   return {};
 * }
 * ```
 */
export type PostToolUseHook = (
  input: PostToolUseInput
) => PostToolUseHookOutput | Promise<PostToolUseHookOutput>;

// ============================================================================
// Tool-Specific Input Types (for type-safe multi-tool hooks)
// ============================================================================

/**
 * Tool-specific input types for common Claude Code tools
 *
 * These types enable type-safe handling of tool inputs in hooks that work
 * with multiple tools. Use with PostToolUseInputTyped or PreToolUseInputTyped
 * for compile-time type narrowing based on tool_name.
 */

/** Input for Write tool - creates or overwrites a file */
export interface WriteToolInput {
  file_path: string;
  content: string;
}

/** Input for Edit tool - modifies part of an existing file */
export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Input for Read tool - reads file contents */
export interface ReadToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

/** Input for Bash tool - executes shell commands */
export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

/** Input for Glob tool - finds files by pattern */
export interface GlobToolInput {
  pattern: string;
  path?: string;
}

/** Input for Grep tool - searches file contents */
export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
}

/** Input for Task tool - launches subagent */
export interface TaskToolInput {
  prompt: string;
  description: string;
  subagent_type: string;
  model?: "sonnet" | "opus" | "haiku";
  resume?: string;
}

/**
 * Type-safe PostToolUse input with discriminated union for tool types
 *
 * Use this instead of PostToolUseInput for hooks that need compile-time
 * type safety when working with specific tools.
 *
 * @example
 * ```typescript
 * async function handler(input: PostToolUseInputTyped): Promise<PostToolUseHookOutput> {
 *   if (input.tool_name === 'Write') {
 *     // TypeScript knows input.tool_input is WriteToolInput
 *     const filePath = input.tool_input.file_path;
 *     const content = input.tool_input.content;
 *   }
 * }
 * ```
 */
export type PostToolUseInputTyped =
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Write";
      tool_input: WriteToolInput;
      tool_response: unknown;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Edit";
      tool_input: EditToolInput;
      tool_response: unknown;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Read";
      tool_input: ReadToolInput;
      tool_response: unknown;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Bash";
      tool_input: BashToolInput;
      tool_response: unknown;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Glob";
      tool_input: GlobToolInput;
      tool_response: unknown;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Grep";
      tool_input: GrepToolInput;
      tool_response: unknown;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_use_id: string;
      tool_name: "Task";
      tool_input: TaskToolInput;
      tool_response: unknown;
    })
  | PostToolUseInput; // Fallback for other tools

/**
 * Helper type to extract PostToolUse input for specific tool(s)
 *
 * Use this for hooks that only work with specific tools to get precise type narrowing.
 *
 * @example
 * ```typescript
 * // Hook that only handles Write and Edit
 * async function handler(
 *   input: PostToolUseInputFor<'Write' | 'Edit'>
 * ): Promise<PostToolUseHookOutput> {
 *   // input.tool_name is 'Write' | 'Edit'
 *   // input.tool_input is WriteToolInput | EditToolInput
 *   const filePath = input.tool_input.file_path; // Type-safe!
 * }
 * ```
 */
export type PostToolUseInputFor<T extends string> = Extract<
  PostToolUseInputTyped,
  { tool_name: T }
>;

/**
 * Type-safe PreToolUse input with discriminated union for tool types
 *
 * Use this instead of PreToolUseInput for hooks that need compile-time
 * type safety when working with specific tools.
 */
export type PreToolUseInputTyped =
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Write";
      tool_input: WriteToolInput;
    })
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Edit";
      tool_input: EditToolInput;
    })
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Read";
      tool_input: ReadToolInput;
    })
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Bash";
      tool_input: BashToolInput;
    })
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Glob";
      tool_input: GlobToolInput;
    })
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Grep";
      tool_input: GrepToolInput;
    })
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_use_id: string;
      tool_name: "Task";
      tool_input: TaskToolInput;
    })
  | PreToolUseInput; // Fallback for other tools

/**
 * Helper type to extract PreToolUse input for specific tool(s)
 *
 * Use this for hooks that only work with specific tools to get precise type narrowing.
 */
export type PreToolUseInputFor<T extends string> = Extract<
  PreToolUseInputTyped,
  { tool_name: T }
>;

// ============================================================================
// SessionStart Hook
// ============================================================================

/** Source trigger that initiated the session */
export type SessionStartSource = "startup" | "resume" | "clear" | "compact";

/**
 * Input provided to SessionStart hooks
 *
 * Fired when a new Claude Code session begins.
 */
export interface SessionStartInput extends BaseHookInput {
  /** Hook event name (always "SessionStart") */
  hook_event_name: "SessionStart";
  /** How the session was started */
  source: SessionStartSource;
}

/**
 * Output from SessionStart hooks
 *
 * Must provide additional context that will be shown to Claude.
 */
export interface SessionStartHookOutput extends BaseHookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    /** Context to provide to Claude at session start */
    additionalContext: string;
  };
}

/** SessionStart hook function signature */
export type SessionStartHook = (
  input: SessionStartInput
) => SessionStartHookOutput | Promise<SessionStartHookOutput>;

// ============================================================================
// SessionEnd Hook
// ============================================================================

/** Reason the session is ending */
export type SessionEndReason = "clear" | "logout" | "prompt_input_exit" | "other";

/**
 * Input provided to SessionEnd hooks
 *
 * Fired when a Claude Code session is ending.
 */
export interface SessionEndInput extends BaseHookInput {
  /** Hook event name (always "SessionEnd") */
  hook_event_name: "SessionEnd";
  /** Why the session is ending */
  reason: SessionEndReason;
}

/** Output from SessionEnd hooks */
export type SessionEndHookOutput = BaseHookOutput;

/** SessionEnd hook function signature */
export type SessionEndHook = (
  input: SessionEndInput
) => SessionEndHookOutput | Promise<SessionEndHookOutput>;

// ============================================================================
// SubagentStart Hook
// ============================================================================

/**
 * Input provided to SubagentStart hooks
 *
 * Fired when a subagent (spawned via Task tool) begins execution. This is the
 * ideal place to save agent context for later retrieval in SubagentStop.
 *
 * @example
 * ```typescript
 * import { saveAgentStartContext } from 'claude-code-kit-ts';
 *
 * export default async function(input: SubagentStartInput): Promise<SubagentStartHookOutput> {
 *   await saveAgentStartContext(input);
 *   return {};
 * }
 * ```
 */
export interface SubagentStartInput extends BaseHookInput {
  /** Hook event name (always "SubagentStart") */
  hook_event_name: "SubagentStart";
  /** Unique identifier for this agent instance */
  agent_id: string;
  /** Type of agent being started (e.g., "Explore", "Plan", custom agent name) */
  agent_type: string;
}

/**
 * Output from SubagentStart hooks
 */
export interface SubagentStartHookOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: "SubagentStart";
  };
}

/** SubagentStart hook function signature */
export type SubagentStartHook = (
  input: SubagentStartInput
) => SubagentStartHookOutput | Promise<SubagentStartHookOutput>;

// ============================================================================
// SubagentStop Hook
// ============================================================================

/**
 * Input provided to SubagentStop hooks
 *
 * Fired when a subagent completes execution. Use this to analyze the agent's
 * transcript, extract file edits, and perform any cleanup.
 *
 * @example
 * ```typescript
 * import { getAgentEdits } from 'claude-code-kit-ts';
 *
 * export default async function(input: SubagentStopInput): Promise<SubagentStopHookOutput> {
 *   const edits = await getAgentEdits(input.agent_transcript_path);
 *   console.log('Agent edited files:', edits.agentEditedFiles);
 *   return {};
 * }
 * ```
 */
export interface SubagentStopInput extends BaseHookInput {
  /** Hook event name (always "SubagentStop") */
  hook_event_name: "SubagentStop";
  /** Whether the Stop hook is currently active */
  stop_hook_active: boolean;
  /** Unique identifier for the agent that stopped */
  agent_id: string;
  /** Path to the agent's transcript file */
  agent_transcript_path: string;
}

/**
 * Output from SubagentStop hooks
 *
 * Can optionally block the agent's results from being used.
 */
export interface SubagentStopHookOutput extends BaseHookOutput {
  /** If "block", prevents the agent's results from being used */
  decision?: "block";
  /** Reason for blocking (shown when decision is "block") */
  reason?: string;
}

/** SubagentStop hook function signature */
export type SubagentStopHook = (
  input: SubagentStopInput
) => SubagentStopHookOutput | Promise<SubagentStopHookOutput>;

// ============================================================================
// Notification Hook
// ============================================================================

/** Input provided to Notification hooks */
export interface NotificationInput extends BaseHookInput {
  /** Hook event name (always "Notification") */
  hook_event_name: "Notification";
  /** The notification message */
  message: string;
}

/** Output from Notification hooks */
export type NotificationHookOutput = BaseHookOutput;

/** Notification hook function signature */
export type NotificationHook = (
  input: NotificationInput
) => NotificationHookOutput | Promise<NotificationHookOutput>;

// ============================================================================
// UserPromptSubmit Hook
// ============================================================================

/**
 * Input provided to UserPromptSubmit hooks
 *
 * Fired when the user submits a prompt to Claude Code.
 */
export interface UserPromptSubmitInput extends BaseHookInput {
  /** Hook event name (always "UserPromptSubmit") */
  hook_event_name: "UserPromptSubmit";
  /** The user's prompt text */
  prompt: string;
}

/**
 * Output from UserPromptSubmit hooks
 *
 * Can add additional context or block the prompt from being processed.
 */
export type UserPromptSubmitHookOutput = BaseHookOutput &
  (
    | {
        /** No blocking decision (default: allow) */
        decision?: undefined;
        /** Optional reason */
        reason?: string;
        hookSpecificOutput?: {
          hookEventName: "UserPromptSubmit";
          /** Additional context to provide to Claude */
          additionalContext?: string;
        };
      }
    | {
        /** Block the prompt from being processed */
        decision: "block";
        /** Optional reason for blocking */
        reason?: string;
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit";
          /** Required context when blocking */
          additionalContext: string;
        };
      }
  );

/** UserPromptSubmit hook function signature */
export type UserPromptSubmitHook = (
  input: UserPromptSubmitInput
) => UserPromptSubmitHookOutput | Promise<UserPromptSubmitHookOutput>;

// ============================================================================
// Stop Hook
// ============================================================================

/**
 * Input provided to Stop hooks
 *
 * Fired when Claude Code is about to stop execution.
 */
export interface StopInput extends BaseHookInput {
  /** Hook event name (always "Stop") */
  hook_event_name: "Stop";
  /** Whether the Stop hook is currently active */
  stop_hook_active: boolean;
}

/**
 * Output from Stop hooks
 *
 * Can block the stop operation to prevent execution from halting.
 */
export interface StopHookOutput extends BaseHookOutput {
  /** "block" prevents Claude Code from stopping, "approve" allows it */
  decision?: "block" | "approve";
  /** Reason for blocking the stop (required when decision is "block") */
  reason?: string;
}

/** Stop hook function signature */
export type StopHook = (
  input: StopInput
) => StopHookOutput | Promise<StopHookOutput>;

// ============================================================================
// PreCompact Hook
// ============================================================================

/** What triggered the compaction */
export type PreCompactTrigger = "manual" | "auto";

/**
 * Input provided to PreCompact hooks
 *
 * Fired before the transcript is compacted (summarized to save space).
 */
export interface PreCompactInput extends BaseHookInput {
  /** Hook event name (always "PreCompact") */
  hook_event_name: "PreCompact";
  /** Whether compaction was triggered manually or automatically */
  trigger: PreCompactTrigger;
  /** Custom instructions for the compaction process */
  custom_instructions: string;
}

/** Output from PreCompact hooks */
export type PreCompactHookOutput = BaseHookOutput;

/** PreCompact hook function signature */
export type PreCompactHook = (
  input: PreCompactInput
) => PreCompactHookOutput | Promise<PreCompactHookOutput>;

// ============================================================================
// Hook Input/Output Union Types
// ============================================================================

/**
 * Union of all possible hook input types
 *
 * Used for generic hook handlers that can process any hook event.
 */
export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | SessionStartInput
  | SessionEndInput
  | SubagentStartInput
  | SubagentStopInput
  | NotificationInput
  | UserPromptSubmitInput
  | StopInput
  | PreCompactInput;

/**
 * Union of all possible hook output types
 *
 * Used for generic hook handlers that can return any hook output.
 */
export type HookOutput =
  | PreToolUseHookOutput
  | PostToolUseHookOutput
  | SessionStartHookOutput
  | SessionEndHookOutput
  | SubagentStartHookOutput
  | SubagentStopHookOutput
  | NotificationHookOutput
  | UserPromptSubmitHookOutput
  | StopHookOutput
  | PreCompactHookOutput;

// ============================================================================
// Hook Function Type
// ============================================================================

/**
 * Generic hook function type with optional type parameters
 *
 * @template I - Input type (defaults to HookInput union)
 * @template O - Output type (defaults to HookOutput union)
 * @param input - The hook input
 * @returns The hook output (can be sync or async)
 *
 * @example
 * ```typescript
 * const myHook: HookFunction<SubagentStopInput, SubagentStopHookOutput> =
 *   async (input) => {
 *     // Type-safe hook implementation
 *     return {};
 *   };
 * ```
 */
export type HookFunction<I extends HookInput = HookInput, O extends HookOutput = HookOutput> = (
  input: I
) => O | Promise<O>;
