import type { GmCommand, GmCommandType } from '../types/index.js';

/**
 * GM override commands parsed from Foundry chat messages.
 * Format: /command [args...]
 *
 * v4 additions:
 * - /plan <card name> — override session plan card
 * - /note <text> — inject GM note into reasoning context
 * - @magi <text> — shorthand for /note
 */

const COMMAND_PATTERN = /^\/(\w+)\s*(.*)/;

const VALID_COMMANDS: ReadonlySet<string> = new Set<GmCommandType>([
  'act', 'scene', 'spotlight', 'engagement',
  'separation', 'climax', 'seed', 'sleep', 'wake',
  'endtime', 'npc', 'status', 'rediscover',
  'plan', 'note',
]);

/** Commands where the full remaining text is a single argument (not split by whitespace). */
const FULL_TEXT_COMMANDS: ReadonlySet<string> = new Set(['plan', 'note']);

/**
 * Parse a chat message for a GM command or @magi mention.
 * Returns null if the message isn't a valid GM command.
 */
export function parseGmCommand(text: string, timestamp: string): GmCommand | null {
  const trimmed = text.trim();

  // Check for @magi prefix → treat as /note
  const magiMatch = trimmed.match(/^@magi\s+(.*)/i);
  if (magiMatch && magiMatch[1].trim()) {
    return {
      type: 'note',
      args: [magiMatch[1].trim()],
      raw: trimmed,
      timestamp,
    };
  }

  const match = trimmed.match(COMMAND_PATTERN);
  if (!match) return null;

  const commandName = match[1].toLowerCase();
  if (!VALID_COMMANDS.has(commandName)) return null;

  const argsStr = match[2].trim();

  // For /plan and /note, keep the full text as a single argument
  if (FULL_TEXT_COMMANDS.has(commandName)) {
    return {
      type: commandName as GmCommandType,
      args: argsStr ? [argsStr] : [],
      raw: trimmed,
      timestamp,
    };
  }

  const args = argsStr ? argsStr.split(/\s+/) : [];

  return {
    type: commandName as GmCommandType,
    args,
    raw: trimmed,
    timestamp,
  };
}
