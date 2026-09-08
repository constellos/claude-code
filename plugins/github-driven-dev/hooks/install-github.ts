/**
 * GitHub CLI Setup Hook
 * SessionStart hook that installs and configures GitHub CLI for the project.
 * On remote: always installs if missing. On local: warns if missing or outdated.
 * @module install-github
 */

import type { SessionStartInput, SessionStartHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Execute a shell command with error handling
 */
async function execCommand(
  command: string,
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeout || 300000,
      env: { ...process.env, ...options.env },
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || err.message || '',
    };
  }
}

/**
 * Check if a command is available in PATH
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await execCommand(`which ${command}`);
  return result.success && result.stdout.length > 0;
}

/**
 * Detect if running in remote (cloud) environment
 */
function isRemoteEnvironment(): boolean {
  return process.env.CLAUDE_CODE_ENTRYPOINT === 'remote';
}

/**
 * Get GitHub CLI version
 */
async function getGhVersion(): Promise<string | null> {
  const result = await execCommand('gh --version');
  if (result.success) {
    const match = result.stdout.match(/gh version ([\d.]+)/);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Get latest GitHub CLI version from GitHub releases
 */
async function getLatestGhVersion(): Promise<string | null> {
  const result = await execCommand(
    'curl -s https://api.github.com/repos/cli/cli/releases/latest | grep tag_name',
    { timeout: 15000 }
  );
  if (result.success) {
    const match = result.stdout.match(/"v?([\d.]+)"/);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Compare semver versions
 */
function isVersionOlder(v1: string, v2: string): boolean {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return true;
    if (p1 > p2) return false;
  }
  return false;
}

/**
 * Install GitHub CLI (gh) on Ubuntu
 */
async function installGitHubCLI(): Promise<ExecResult> {
  if (await isCommandAvailable('gh')) {
    return { success: true, stdout: 'gh already installed', stderr: '' };
  }

  const commands = [
    'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg',
    'sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
    'sudo apt-get update',
    'sudo apt-get install -y gh',
  ];

  for (const cmd of commands) {
    const result = await execCommand(cmd);
    if (!result.success) {
      return { success: false, stdout: '', stderr: `Failed to install gh: ${result.stderr}` };
    }
  }

  return { success: true, stdout: 'gh installed successfully', stderr: '' };
}

/**
 * Check if GitHub CLI is authenticated
 */
async function isAuthenticated(): Promise<boolean> {
  const result = await execCommand('gh auth status');
  return result.success;
}

/**
 * SessionStart hook handler
 * On remote: installs gh if missing. On local: warns if missing or outdated.
 */
async function handler(input: SessionStartInput): Promise<SessionStartHookOutput> {
  const logger = createDebugLogger(input.cwd, 'setup-github', true);
  const isRemote = isRemoteEnvironment();
  const messages: string[] = [];

  try {
    await logger.logInput({
      source: input.source,
      session_id: input.session_id,
      is_remote: isRemote,
    });

    const ghAvailable = await isCommandAvailable('gh');

    if (!ghAvailable) {
      if (isRemote) {
        messages.push('Installing GitHub CLI...');
        const installResult = await installGitHubCLI();
        messages.push(installResult.success ? '✓ gh installed' : `⚠️ ${installResult.stderr}`);
      } else {
        messages.push('⚠️ GitHub CLI not installed');
        messages.push('  Install: curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && sudo apt install gh');
      }
    } else {
      const ghVersion = await getGhVersion();
      messages.push(`✓ GitHub CLI v${ghVersion || 'unknown'}`);

      const latestVersion = await getLatestGhVersion();
      if (ghVersion && latestVersion && isVersionOlder(ghVersion, latestVersion)) {
        messages.push(`⚠️ Update available: v${latestVersion} (current: v${ghVersion})`);
        if (!isRemote) {
          messages.push('  Run: gh upgrade');
        }
      }

      const authed = await isAuthenticated();
      if (authed) {
        messages.push('✓ GitHub CLI authenticated');
      } else {
        messages.push('⚠️ GitHub CLI not authenticated');
        messages.push('  Run: gh auth login');
      }
    }

    const finalMessage = messages.join('\n');

    await logger.logOutput({
      success: true,
      is_remote: isRemote,
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
        additionalContext: `GitHub CLI setup error: ${error}`,
      },
    };
  }
}

export { handler };
runHook(handler);
