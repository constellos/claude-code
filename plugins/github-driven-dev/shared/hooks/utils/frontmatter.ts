/**
 * Simple YAML frontmatter parser - zero dependencies
 *
 * Replaces gray-matter with a lightweight custom implementation
 * that handles the basic YAML frontmatter patterns used in this project.
 *
 * @module frontmatter
 */

/**
 * Parse YAML frontmatter from markdown content
 *
 * Extracts YAML frontmatter between --- delimiters and parses
 * simple key-value pairs and arrays. Returns data object and remaining content.
 *
 * Supported YAML patterns:
 * - Simple key-value: `name: value`
 * - Arrays: `skills: [item1, item2]` or multi-line arrays
 * - Nested (basic): `field: { key: value }`
 *
 * @param content - Markdown content with optional frontmatter
 * @returns Object with `data` (parsed YAML) and `content` (remaining markdown)
 *
 * @example
 * ```typescript
 * import { parseFrontmatter } from './frontmatter.js';
 *
 * const markdown = `---
 * name: MyAgent
 * skills: [skill1, skill2]
 * ---
 *
 * # Content here
 * `;
 *
 * const { data, content } = parseFrontmatter(markdown);
 * console.log(data.name); // 'MyAgent'
 * console.log(data.skills); // ['skill1', 'skill2']
 * ```
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { data: {}, content };
  }

  const [, yamlContent, remainingContent] = match;
  const data = parseSimpleYaml(yamlContent);

  return { data, content: remainingContent };
}

/**
 * Parse simple YAML content into JavaScript object
 *
 * Handles common YAML patterns used in frontmatter:
 * - Key-value pairs
 * - Inline arrays: [item1, item2, item3]
 * - Multi-line arrays with - prefix
 * - Nested objects (basic)
 *
 * @param yaml - YAML content string
 * @returns Parsed JavaScript object
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }

    // Parse key-value pair
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = line.substring(0, colonIndex).trim();
    const value = line.substring(colonIndex + 1).trim();

    // Handle inline array: [item1, item2]
    if (value.startsWith('[') && value.endsWith(']')) {
      const arrayContent = value.slice(1, -1);
      data[key] = arrayContent.split(',').map(item => item.trim());
      i++;
      continue;
    }

    // Handle multi-line array
    if (value === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('-')) {
      const arrayItems: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim().startsWith('-')) {
        const item = lines[i].trim().substring(1).trim();
        arrayItems.push(item);
        i++;
      }
      data[key] = arrayItems;
      continue;
    }

    // Handle inline object: { key: value }
    if (value.startsWith('{') && value.endsWith('}')) {
      const objectContent = value.slice(1, -1);
      const obj: Record<string, unknown> = {};
      const pairs = objectContent.split(',');
      for (const pair of pairs) {
        const [objKey, objValue] = pair.split(':').map(s => s.trim());
        obj[objKey] = parseValue(objValue);
      }
      data[key] = obj;
      i++;
      continue;
    }

    // Handle simple value
    data[key] = parseValue(value);
    i++;
  }

  return data;
}

/**
 * Parse a YAML value to appropriate JavaScript type
 *
 * Converts:
 * - 'true'/'false' → boolean
 * - 'null' → null
 * - Numbers → number
 * - Quoted strings → unquoted string
 * - Everything else → string
 *
 * @param value - YAML value string
 * @returns Parsed value in appropriate type
 */
function parseValue(value: string): unknown {
  // Handle boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Handle null
  if (value === 'null' || value === '~') return null;

  // Handle number
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  // Handle quoted strings
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Return as string
  return value;
}

/**
 * gray-matter compatible interface
 *
 * Provides same API as gray-matter for drop-in replacement.
 *
 * @param content - Markdown content with frontmatter
 * @returns Object with `data` and `content` properties
 */
export default function matter(content: string): {
  data: Record<string, unknown>;
  content: string;
} {
  return parseFrontmatter(content);
}
