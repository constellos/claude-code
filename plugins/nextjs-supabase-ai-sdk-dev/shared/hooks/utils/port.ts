/**
 * Port availability utilities for checking and finding available TCP ports
 *
 * Provides functions to check if a port is available and find the next available
 * port in a range. Useful for avoiding port conflicts when starting development servers.
 *
 * @module port
 */

import { createServer } from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Check if a TCP port is available
 *
 * Attempts to bind a server to the given port. If successful, the port is available.
 * If binding fails with EADDRINUSE, the port is already in use.
 *
 * @param port - Port number to check
 * @returns Promise that resolves to true if port is available, false if in use
 *
 * @example
 * ```typescript
 * import { isPortAvailable } from './port.js';
 *
 * const available = await isPortAvailable(8787);
 * if (!available) {
 *   console.log('Port 8787 is already in use');
 * }
 * ```
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        // Other errors (EACCES, etc.) also mean port is not available
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port);
  });
}

/**
 * Find the next available port starting from a given port
 *
 * Sequentially checks ports starting from `startPort` until an available port
 * is found or `maxAttempts` is reached.
 *
 * @param startPort - Port number to start checking from
 * @param maxAttempts - Maximum number of ports to check (default: 10)
 * @returns Promise that resolves to an available port number, or null if none found
 *
 * @example
 * ```typescript
 * import { findAvailablePort } from './port.js';
 *
 * // Try to find an available port starting from 8787
 * const port = await findAvailablePort(8787, 10);
 * if (port) {
 *   console.log(`Found available port: ${port}`);
 * } else {
 *   console.log('No available ports found in range 8787-8796');
 * }
 * ```
 */
export async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 10
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  return null;
}

/**
 * Kill process(es) using a specific port
 *
 * Uses lsof to find the process ID and kills it, with fallback to ss if lsof fails.
 * This is useful for freeing up ports that are held by stale dev servers from previous sessions.
 *
 * @param port - Port number to free up
 * @returns Promise that resolves to true if process was killed, false otherwise
 *
 * @example
 * ```typescript
 * import { killProcessOnPort } from './port.js';
 *
 * const killed = await killProcessOnPort(3000);
 * if (killed) {
 *   console.log('Freed up port 3000');
 * }
 * ```
 */
export async function killProcessOnPort(port: number): Promise<boolean> {
  try {
    let pids: string[] = [];

    // Try lsof first (preferred, more portable)
    try {
      const { stdout } = await execAsync(`lsof -ti tcp:${port}`, { timeout: 5000 });
      pids = stdout.trim().split('\n').filter(Boolean);
    } catch {
      // lsof failed or not available, will try ss fallback
    }

    // Fallback to ss if lsof found nothing
    if (pids.length === 0) {
      try {
        const { stdout } = await execAsync(
          `ss -tlnp | grep ':${port}\\b' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`,
          { timeout: 5000 }
        );
        pids = stdout.trim().split('\n').filter(Boolean);
      } catch {
        // ss also failed or not available
      }
    }

    if (pids.length === 0) {
      return false;
    }

    // Kill all processes found
    for (const pid of pids) {
      try {
        await execAsync(`kill -9 ${pid}`, { timeout: 5000 });
      } catch {
        // Process might have already exited
      }
    }

    // Verify port is now available (give it a moment)
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await isPortAvailable(port);
  } catch {
    return false;
  }
}

/**
 * Kill processes on multiple ports
 *
 * Kills processes on all specified ports in parallel.
 *
 * @param ports - Array of port numbers to free up
 * @returns Promise that resolves to array of results with port and success status
 *
 * @example
 * ```typescript
 * import { killProcessesOnPorts } from './port.js';
 *
 * const results = await killProcessesOnPorts([3000, 3001, 3002]);
 * for (const { port, killed } of results) {
 *   console.log(`Port ${port}: ${killed ? 'freed' : 'failed or not in use'}`);
 * }
 * ```
 */
export async function killProcessesOnPorts(
  ports: number[]
): Promise<Array<{ port: number; killed: boolean }>> {
  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      killed: await killProcessOnPort(port),
    }))
  );
  return results;
}

/**
 * Find next available port scanning at +10 increments
 *
 * Checks ports at 10-port intervals starting from basePort until an available
 * port is found. This allows multiple dev servers to run on predictable ports
 * (e.g., 3000, 3010, 3020...) without conflicts.
 *
 * @param basePort - Starting port (e.g., 3000)
 * @param maxSlots - Maximum slots to check (default: 25)
 * @returns Available port, or null if none found in range
 *
 * @example
 * ```typescript
 * import { findAvailablePortAt10Increments } from './port.js';
 *
 * // Find next available port starting from 3000, checking 3000, 3010, 3020...
 * const port = await findAvailablePortAt10Increments(3000);
 * if (port) {
 *   console.log(`Starting server on port ${port}`);
 * }
 * ```
 */
export async function findAvailablePortAt10Increments(
  basePort: number,
  maxSlots: number = 25
): Promise<number | null> {
  for (let slot = 0; slot < maxSlots; slot++) {
    const port = basePort + slot * 10;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  return null;
}
