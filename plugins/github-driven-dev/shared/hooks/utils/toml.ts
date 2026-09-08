/**
 * Simple TOML parser for configuration files
 *
 * Provides basic TOML parsing functionality for reading configuration files
 * like supabase/config.toml. This is a lightweight parser that supports the
 * most common TOML features without requiring external dependencies.
 *
 * Supported TOML features:
 * - Key-value pairs (strings, numbers, booleans)
 * - Inline arrays: `values = [1, 2, 3]`
 * - Multiline arrays spanning multiple lines
 * - Tables (sections): `[section]` and `[section.subsection]`
 * - Comments starting with `#`
 *
 * @module toml
 */

export interface TomlValue {
  [key: string]: string | number | boolean | string[] | TomlValue;
}

/**
 * Parse a TOML string into a JavaScript object
 *
 * Converts TOML configuration syntax into a JavaScript object with nested
 * structure matching the TOML sections and subsections.
 *
 * @param content - The TOML string to parse
 * @returns Parsed object with nested structure
 *
 * @example
 * ```typescript
 * import { parseToml } from './toml.js';
 *
 * const tomlContent = `
 * # Project configuration
 * project_id = "my-project"
 * enabled = true
 *
 * [api]
 * port = 54321
 * enabled_services = ["auth", "realtime", "storage"]
 *
 * [db]
 * port = 54322
 * `;
 *
 * const config = parseToml(tomlContent);
 * console.log(config.project_id); // "my-project"
 * console.log(config.enabled); // true
 * console.log(config.api.port); // 54321
 * console.log(config.api.enabled_services); // ["auth", "realtime", "storage"]
 * console.log(config.db.port); // 54322
 * ```
 */
export function parseToml(content: string): TomlValue {
  const result: TomlValue = {};
  let currentSection: TomlValue = result;
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Handle table headers [section] or [section.subsection]
    if (line.startsWith('[') && line.endsWith(']')) {
      const sectionPath = line.slice(1, -1).trim();
      currentSection = result;

      for (const part of sectionPath.split('.')) {
        if (!(part in currentSection)) {
          currentSection[part] = {};
        }
        currentSection = currentSection[part] as TomlValue;
      }
      continue;
    }

    // Handle key-value pairs
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();

    // Parse the value
    currentSection[key] = parseValue(value, lines, i);
  }

  return result;
}

/**
 * Parse a TOML value
 */
function parseValue(value: string, lines: string[], lineIndex: number): string | number | boolean | string[] {
  // Handle multiline arrays
  if (value === '[' || value.startsWith('[') && !value.endsWith(']')) {
    return parseMultilineArray(value, lines, lineIndex);
  }

  // Handle inline arrays
  if (value.startsWith('[') && value.endsWith(']')) {
    return parseInlineArray(value);
  }

  // Handle strings
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  // Handle booleans
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Handle numbers
  const num = Number(value);
  if (!isNaN(num)) return num;

  // Return as string if nothing else matches
  return value;
}

/**
 * Parse an inline array like [1, 2, 3] or ["a", "b", "c"]
 */
function parseInlineArray(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const char of inner) {
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if (char === ',' && !inQuote) {
      const trimmed = current.trim();
      if (trimmed) {
        items.push(trimmed.replace(/^["']|["']$/g, ''));
      }
      current = '';
    } else {
      current += char;
    }
  }

  const trimmed = current.trim();
  if (trimmed) {
    items.push(trimmed.replace(/^["']|["']$/g, ''));
  }

  return items;
}

/**
 * Parse a multiline array
 */
function parseMultilineArray(startValue: string, lines: string[], startIndex: number): string[] {
  const items: string[] = [];
  let content = startValue;

  // Collect lines until we find the closing bracket
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i > startIndex) {
      content += ' ' + line;
    }
    if (line.includes(']')) {
      break;
    }
  }

  // Now parse as inline array
  const match = content.match(/\[([\s\S]*)\]/);
  if (match) {
    return parseInlineArray('[' + match[1] + ']');
  }

  return items;
}

/**
 * Read and parse a TOML file
 *
 * Reads a TOML configuration file from disk and parses it into a JavaScript object.
 * Returns null if the file doesn't exist or cannot be read.
 *
 * @param filePath - Path to the TOML file
 * @returns Parsed object, or null if file doesn't exist or read fails
 *
 * @example
 * ```typescript
 * import { readTomlFile } from './toml.js';
 * import { join } from 'path';
 *
 * // Read Supabase configuration
 * const supabaseConfig = await readTomlFile(
 *   join(process.cwd(), 'supabase', 'config.toml')
 * );
 *
 * if (supabaseConfig) {
 *   console.log('Project ID:', supabaseConfig.project_id);
 *   console.log('API port:', supabaseConfig.api?.port);
 *   console.log('DB port:', supabaseConfig.db?.port);
 * } else {
 *   console.log('Supabase not initialized');
 * }
 * ```
 */
export async function readTomlFile(filePath: string): Promise<TomlValue | null> {
  try {
    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath, 'utf-8');
    return parseToml(content);
  } catch {
    return null;
  }
}
