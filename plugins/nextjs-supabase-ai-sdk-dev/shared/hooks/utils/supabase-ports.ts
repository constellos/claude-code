/**
 * Supabase Port Management Utility
 * Manages port allocation for multiple concurrent Supabase instances across worktrees.
 * @module supabase-ports
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { isPortAvailable, killProcessOnPort } from './port.js';

/**
 * Default Supabase service ports
 */
export const SUPABASE_DEFAULT_PORTS = {
  api: 54321,
  db: 54322,
  shadowDb: 54320,
  studio: 54323,
  inbucket: 54324,
  analytics: 54327,
  pooler: 54329,
  edgeRuntime: 8083,
} as const;

/**
 * Port increment between slots (allows ~25 concurrent instances)
 */
export const PORT_INCREMENT = 10;

/**
 * A complete set of Supabase service ports
 */
export interface SupabasePortSet {
  api: number;
  db: number;
  shadowDb: number;
  studio: number;
  inbucket: number;
  analytics: number;
  pooler: number;
  edgeRuntime: number;
}

/**
 * Result of checking port usage
 */
export interface PortUsageResult {
  /** All critical ports (API, DB, Studio) are in use */
  allRunning: boolean;
  /** At least one port is in use but not all */
  someRunning: boolean;
  /** List of ports currently in use */
  runningPorts: number[];
  /** Ports that are available */
  availablePorts: number[];
}

/**
 * Calculate a port set for a given slot number
 * Slot 0 = default ports, Slot 1 = +10, Slot 2 = +20, etc.
 *
 * @param slot - Slot number (0 for default, 1+ for worktrees)
 * @returns Complete port set for the slot
 */
export function calculatePortSet(slot: number): SupabasePortSet {
  const offset = slot * PORT_INCREMENT;
  return {
    api: SUPABASE_DEFAULT_PORTS.api + offset,
    db: SUPABASE_DEFAULT_PORTS.db + offset,
    shadowDb: SUPABASE_DEFAULT_PORTS.shadowDb + offset,
    studio: SUPABASE_DEFAULT_PORTS.studio + offset,
    inbucket: SUPABASE_DEFAULT_PORTS.inbucket + offset,
    analytics: SUPABASE_DEFAULT_PORTS.analytics + offset,
    pooler: SUPABASE_DEFAULT_PORTS.pooler + offset,
    edgeRuntime: SUPABASE_DEFAULT_PORTS.edgeRuntime + offset,
  };
}

/**
 * Get all ports from a port set as an array
 *
 * @param ports - Port set to extract from
 * @returns Array of all port numbers
 */
export function getPortArray(ports: SupabasePortSet): number[] {
  return [
    ports.api,
    ports.db,
    ports.shadowDb,
    ports.studio,
    ports.inbucket,
    ports.analytics,
    ports.pooler,
    ports.edgeRuntime,
  ];
}

/**
 * Critical ports that indicate Supabase is fully running
 * If all three are in use, Supabase is considered "fully running"
 */
const CRITICAL_PORTS: (keyof typeof SUPABASE_DEFAULT_PORTS)[] = ['api', 'db', 'studio'];

/**
 * Check which Supabase services are running on default ports
 * Determines if instance is fully running, partially running, or not running
 *
 * @param portSet - Optional port set to check (defaults to default ports)
 * @returns Port usage information
 */
export async function checkSupabasePortUsage(
  portSet: SupabasePortSet = calculatePortSet(0)
): Promise<PortUsageResult> {
  const criticalPorts = CRITICAL_PORTS.map((key) => portSet[key]);
  const allPorts = getPortArray(portSet);

  const runningPorts: number[] = [];
  const availablePorts: number[] = [];

  // Check all ports in parallel
  const results = await Promise.all(
    allPorts.map(async (port) => ({
      port,
      available: await isPortAvailable(port),
    }))
  );

  for (const { port, available } of results) {
    if (available) {
      availablePorts.push(port);
    } else {
      runningPorts.push(port);
    }
  }

  // Check if all critical ports are in use
  const criticalInUse = criticalPorts.filter((p) => runningPorts.includes(p));
  const allRunning = criticalInUse.length === CRITICAL_PORTS.length;
  const someRunning = runningPorts.length > 0 && !allRunning;

  return {
    allRunning,
    someRunning,
    runningPorts,
    availablePorts,
  };
}

/**
 * Find the next available port slot
 * Starts from slot 1 and increments until finding a slot with all ports available
 *
 * @param maxSlots - Maximum number of slots to check (default: 25)
 * @returns Slot number with available ports, or null if none found
 */
export async function findAvailableSlot(maxSlots: number = 25): Promise<number | null> {
  for (let slot = 1; slot <= maxSlots; slot++) {
    const portSet = calculatePortSet(slot);
    const usage = await checkSupabasePortUsage(portSet);

    // If no critical ports are in use, this slot is available
    if (usage.runningPorts.length === 0) {
      return slot;
    }
  }
  return null;
}

/**
 * Find an available port set, starting from a given slot
 *
 * @param startSlot - Slot to start checking from (default: 1)
 * @returns Port set with all available ports, or null if none found
 */
export async function findAvailablePortSet(startSlot: number = 1): Promise<{
  slot: number;
  ports: SupabasePortSet;
} | null> {
  const slot = await findAvailableSlot(25);
  if (slot === null || slot < startSlot) {
    return null;
  }
  return {
    slot,
    ports: calculatePortSet(slot),
  };
}

/**
 * Kill stale Supabase processes on a port set
 * Useful for cleaning up partial/crashed instances
 *
 * @param portSet - Ports to clean up
 * @returns Results of kill attempts for each port
 */
export async function killStaleSupabasePorts(
  portSet: SupabasePortSet = calculatePortSet(0)
): Promise<Array<{ port: number; killed: boolean }>> {
  const ports = getPortArray(portSet);
  const results = await Promise.all(
    ports.map(async (port) => {
      const available = await isPortAvailable(port);
      if (available) {
        return { port, killed: false };
      }
      const killed = await killProcessOnPort(port);
      return { port, killed };
    })
  );
  return results;
}

// ==================== Config.toml Management ====================

/**
 * Parse port values from a Supabase config.toml file
 * Uses regex to extract port settings from TOML content
 *
 * @param configPath - Path to config.toml
 * @returns Current port configuration, or null if can't be parsed
 */
export function parseSupabaseConfigPorts(configPath: string): SupabasePortSet | null {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');

    // Extract ports using regex patterns
    // Format: port = 54321 (with optional whitespace)
    const extractPort = (section: string, key: string = 'port'): number | null => {
      // Build regex to match [section] followed by key = value
      const sectionRegex = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'm');
      const sectionMatch = content.match(sectionRegex);
      if (!sectionMatch) return null;

      const sectionContent = sectionMatch[1];
      const portRegex = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm');
      const portMatch = sectionContent.match(portRegex);
      return portMatch ? parseInt(portMatch[1], 10) : null;
    };

    return {
      api: extractPort('api') ?? SUPABASE_DEFAULT_PORTS.api,
      db: extractPort('db') ?? SUPABASE_DEFAULT_PORTS.db,
      shadowDb: extractPort('db', 'shadow_port') ?? SUPABASE_DEFAULT_PORTS.shadowDb,
      studio: extractPort('studio') ?? SUPABASE_DEFAULT_PORTS.studio,
      inbucket: extractPort('inbucket') ?? SUPABASE_DEFAULT_PORTS.inbucket,
      analytics: extractPort('analytics') ?? SUPABASE_DEFAULT_PORTS.analytics,
      pooler: extractPort('db\\.pooler') ?? extractPort('db', 'pooler_port') ?? SUPABASE_DEFAULT_PORTS.pooler,
      edgeRuntime: extractPort('edge_runtime', 'inspector_port') ?? SUPABASE_DEFAULT_PORTS.edgeRuntime,
    };
  } catch {
    return null;
  }
}

/**
 * Update port values in a Supabase config.toml file
 * Creates a backup before modifying
 *
 * @param configPath - Path to config.toml
 * @param ports - New port values to set
 * @param backupSuffix - Suffix for backup file (default: '.backup')
 * @returns Path to backup file
 */
export function updateSupabaseConfigPorts(
  configPath: string,
  ports: SupabasePortSet,
  backupSuffix: string = '.backup'
): string {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // Create backup
  const backupPath = `${configPath}${backupSuffix}`;
  copyFileSync(configPath, backupPath);

  let content = readFileSync(configPath, 'utf-8');

  // Helper to update a port in a section
  const updatePort = (section: string, key: string, value: number): void => {
    // Pattern to match the section and the key within it
    const sectionRegex = new RegExp(`(\\[${section}\\][\\s\\S]*?)(${key}\\s*=\\s*)(\\d+)`, 'gm');

    // Check if the key exists in the section
    if (sectionRegex.test(content)) {
      // Reset regex state
      sectionRegex.lastIndex = 0;
      content = content.replace(sectionRegex, `$1$2${value}`);
    } else {
      // Key doesn't exist, try to add it after section header
      const addKeyRegex = new RegExp(`(\\[${section}\\]\\s*\\n)`, 'm');
      if (addKeyRegex.test(content)) {
        content = content.replace(addKeyRegex, `$1${key} = ${value}\n`);
      }
    }
  };

  // Update each port
  updatePort('api', 'port', ports.api);
  updatePort('db', 'port', ports.db);
  updatePort('db', 'shadow_port', ports.shadowDb);
  updatePort('db\\.pooler', 'port', ports.pooler);
  updatePort('studio', 'port', ports.studio);
  updatePort('inbucket', 'port', ports.inbucket);
  updatePort('analytics', 'port', ports.analytics);
  updatePort('edge_runtime', 'inspector_port', ports.edgeRuntime);

  writeFileSync(configPath, content, 'utf-8');

  return backupPath;
}

/**
 * Restore config.toml from backup
 *
 * @param configPath - Path to config.toml
 * @param backupSuffix - Suffix used for backup (default: '.backup')
 * @returns true if restored, false if backup not found
 */
export function restoreSupabaseConfig(
  configPath: string,
  backupSuffix: string = '.backup'
): boolean {
  const backupPath = `${configPath}${backupSuffix}`;

  if (!existsSync(backupPath)) {
    return false;
  }

  copyFileSync(backupPath, configPath);
  return true;
}

/**
 * Get the path to supabase config.toml in a project
 *
 * @param cwd - Project root directory
 * @returns Path to config.toml
 */
export function getSupabaseConfigPath(cwd: string): string {
  return join(cwd, 'supabase', 'config.toml');
}

/**
 * Check if a project has Supabase initialized
 *
 * @param cwd - Project root directory
 * @returns true if supabase/config.toml exists
 */
export function hasSupabaseConfig(cwd: string): boolean {
  return existsSync(getSupabaseConfigPath(cwd));
}

// ============================================================================
// Project ID Management (for Database Isolation)
// ============================================================================

/**
 * Extract the base project ID by stripping any slot suffixes
 * Handles cascading suffixes like: "myapp-1", "myapp-3-4-5" -> "myapp"
 *
 * @param projectId - The project ID to clean
 * @returns The base project ID without slot suffixes
 * @example
 * ```typescript
 * extractBaseProjectId('myapp')       // Returns: "myapp"
 * extractBaseProjectId('myapp-1')     // Returns: "myapp"
 * extractBaseProjectId('myapp-3-4-5') // Returns: "myapp"
 * ```
 */
export function extractBaseProjectId(projectId: string): string {
  // Strip trailing slot suffixes like -1, -2, -3-4-5, etc.
  // Pattern: one or more occurrences of dash followed by digits at the end
  return projectId.replace(/(-\d+)+$/, '');
}

/**
 * Read original project_id from config.toml
 * Tries backup file first (has true original), then falls back to current config
 * with suffix stripping to handle corrupted state from previous sessions.
 *
 * @param configPath - Path to config.toml
 * @param worktreeId - Optional worktree ID to check backup file
 * @returns The project_id string, or null if not found
 * @example
 * ```typescript
 * const projectId = getOriginalProjectId('/path/to/supabase/config.toml', 'abc12345');
 * // Returns: "myapp" (from backup or stripped from current config)
 * ```
 */
export function getOriginalProjectId(configPath: string, worktreeId?: string): string | null {
  // Try backup file first (has true original project ID)
  if (worktreeId) {
    const backupPath = `${configPath}.backup-${worktreeId}`;
    if (existsSync(backupPath)) {
      try {
        const backupContent = readFileSync(backupPath, 'utf-8');
        const match = backupContent.match(/project_id\s*=\s*"([^"]+)"/);
        if (match) return match[1];
      } catch {
        // Fall through to current config
      }
    }
  }

  // Also try the main backup (for main repo sessions)
  const mainBackupPath = `${configPath}.backup-main`;
  if (existsSync(mainBackupPath)) {
    try {
      const backupContent = readFileSync(mainBackupPath, 'utf-8');
      const match = backupContent.match(/project_id\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {
      // Fall through to current config
    }
  }

  // Fall back to current config, but strip any slot suffix
  if (!existsSync(configPath)) {
    return null;
  }

  const content = readFileSync(configPath, 'utf-8');
  const match = content.match(/project_id\s*=\s*"([^"]+)"/);
  if (match) {
    // Strip any existing slot suffixes to get the true base project ID
    return extractBaseProjectId(match[1]);
  }
  return null;
}

/**
 * Generate worktree-specific project_id
 * Slot 0 = original project_id (main repo)
 * Slot 1+ = original-{slot} (worktrees)
 *
 * @param originalId - Original project_id from config.toml
 * @param slot - Slot number (0 for main, 1+ for worktrees)
 * @returns Worktree-specific project_id
 * @example
 * ```typescript
 * generateWorktreeProjectId('myapp', 0)  // Returns: "myapp-0"
 * generateWorktreeProjectId('myapp', 1)  // Returns: "myapp-1"
 * generateWorktreeProjectId('myapp', 2)  // Returns: "myapp-2"
 * ```
 */
export function generateWorktreeProjectId(originalId: string, slot: number): string {
  return `${originalId}-${slot}`;
}

/**
 * Update project_id in config.toml with backup
 *
 * @param configPath - Path to config.toml
 * @param newProjectId - New project_id to set
 * @param backupSuffix - Suffix for backup file (e.g., ".backup-abc12345")
 * @returns Path to backup file
 * @throws Error if config.toml cannot be read or written
 * @example
 * ```typescript
 * const backupPath = updateSupabaseProjectId(
 *   '/path/to/supabase/config.toml',
 *   'myapp-1',
 *   '.backup-abc12345'
 * );
 * // Creates backup at: /path/to/supabase/config.toml.backup-abc12345
 * // Updates project_id to: "myapp-1"
 * ```
 */
export function updateSupabaseProjectId(
  configPath: string,
  newProjectId: string,
  backupSuffix: string
): string {
  const content = readFileSync(configPath, 'utf-8');
  const backupPath = `${configPath}${backupSuffix}`;

  // Backup original config
  copyFileSync(configPath, backupPath);

  // Replace project_id
  const updated = content.replace(/project_id\s*=\s*"[^"]+"/, `project_id = "${newProjectId}"`);

  writeFileSync(configPath, updated, 'utf-8');
  return backupPath;
}

// ============================================================================
// Service Optimization (Resource Management)
// ============================================================================

/**
 * Detect which Supabase services are enabled in config.toml
 *
 * @param configPath - Path to config.toml
 * @returns Array of enabled service names
 * @example
 * ```typescript
 * const enabled = getEnabledServices('/path/to/supabase/config.toml');
 * // Returns: ['gotrue', 'realtime', 'storage-api', 'postgrest', ...]
 * ```
 */
export function getEnabledServices(configPath: string): string[] {
  if (!existsSync(configPath)) {
    return [];
  }

  const content = readFileSync(configPath, 'utf-8');

  // Map of service names to their config.toml section names
  const serviceMap: Record<string, string> = {
    gotrue: 'auth',
    realtime: 'realtime',
    'storage-api': 'storage',
    'edge-runtime': 'edge-runtime',
    logflare: 'analytics',
    vector: 'vector',
  };

  const services = Object.keys(serviceMap);

  return services.filter((service) => {
    const section = serviceMap[service];
    // Match [section] ... enabled = true pattern (case insensitive, multiline)
    const pattern = new RegExp(`\\[${section}\\][\\s\\S]*?enabled\\s*=\\s*true`, 'i');
    return pattern.test(content);
  });
}

/**
 * Build --exclude flag for disabled Supabase services
 * This optimizes resource usage by skipping services not used by the project
 *
 * @param configPath - Path to config.toml
 * @returns CLI flag string (e.g., " --exclude edge-runtime,logflare") or empty string
 * @example
 * ```typescript
 * const excludeFlags = buildExcludeFlags('/path/to/supabase/config.toml');
 * const command = `supabase start${excludeFlags}`;
 * // If edge-runtime and logflare are disabled:
 * // command = "supabase start --exclude edge-runtime,logflare"
 * ```
 */
export function buildExcludeFlags(configPath: string): string {
  const enabled = getEnabledServices(configPath);
  const allServices = ['gotrue', 'realtime', 'storage-api', 'edge-runtime', 'logflare', 'vector'];
  const disabled = allServices.filter((s) => !enabled.includes(s));

  if (disabled.length === 0) return '';

  return ` --exclude ${disabled.join(',')}`;
}
