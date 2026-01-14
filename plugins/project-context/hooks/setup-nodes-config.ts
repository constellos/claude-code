/**
 * Nodes MCP Config Setup Hook
 * SessionStart hook that creates .nodes/.mcp.nodes.json config for the nodes-md proxy.
 * Merges with existing config if present (for multi-plugin support).
 * @module setup-nodes-config
 */

import type { SessionStartInput, SessionStartHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

/**
 * Nodes MCP server configuration
 */
interface NodesServer {
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
}

/**
 * Nodes MCP config file structure
 */
interface NodesConfig {
  servers: Record<string, NodesServer>;
}

/**
 * Servers this plugin contributes to the nodes config
 */
const PLUGIN_SERVERS: Record<string, NodesServer> = {
  context7: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
  },
};

/**
 * Load existing nodes config or return empty config
 */
function loadNodesConfig(configPath: string): NodesConfig {
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as NodesConfig;
    } catch {
      // Invalid JSON, start fresh
      return { servers: {} };
    }
  }
  return { servers: {} };
}

/**
 * Add .nodes/ to .gitignore if not already present
 */
function addToGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, '.gitignore');

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.includes('.nodes/') || content.includes('.nodes')) {
      return false; // Already present
    }
    appendFileSync(gitignorePath, '\n# nodes-md MCP config\n.nodes/\n');
    return true;
  } else {
    writeFileSync(gitignorePath, '# nodes-md MCP config\n.nodes/\n');
    return true;
  }
}

/**
 * SessionStart hook handler
 * Creates .nodes/.mcp.nodes.json with this plugin's servers
 */
async function handler(input: SessionStartInput): Promise<SessionStartHookOutput> {
  const logger = createDebugLogger(input.cwd, 'setup-nodes-config', true);
  const messages: string[] = [];

  try {
    await logger.logInput({
      source: input.source,
      session_id: input.session_id,
    });

    const nodesDir = join(input.cwd, '.nodes');
    const configPath = join(nodesDir, '.mcp.nodes.json');

    // Create .nodes directory if needed
    if (!existsSync(nodesDir)) {
      mkdirSync(nodesDir, { recursive: true });
      messages.push('Created .nodes/ directory');
    }

    // Load existing config and merge
    const config = loadNodesConfig(configPath);
    const existingServers = Object.keys(config.servers);
    const newServers: string[] = [];

    // Merge plugin servers (this plugin's servers take precedence)
    for (const [name, server] of Object.entries(PLUGIN_SERVERS)) {
      if (!config.servers[name]) {
        newServers.push(name);
      }
      config.servers[name] = server;
    }

    // Write updated config
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    if (newServers.length > 0) {
      messages.push(`Added servers to .nodes config: ${newServers.join(', ')}`);
    } else {
      messages.push('Nodes config up to date');
    }

    if (existingServers.length > 0) {
      const otherServers = existingServers.filter((s) => !PLUGIN_SERVERS[s]);
      if (otherServers.length > 0) {
        messages.push(`Other servers in config: ${otherServers.join(', ')}`);
      }
    }

    // Add to .gitignore
    if (addToGitignore(input.cwd)) {
      messages.push('Added .nodes/ to .gitignore');
    }

    const finalMessage = messages.join('\n');

    await logger.logOutput({
      success: true,
      message: finalMessage,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: finalMessage,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Nodes config setup error: ${error}`,
      },
    };
  }
}

export { handler };
runHook(handler);
