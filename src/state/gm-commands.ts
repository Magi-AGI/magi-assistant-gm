import type { GmCommand, GmCommandType } from '../types/index.js';

/**
 * GM override commands parsed from Foundry chat messages.
 * Format: /command [args...]
 */

const COMMAND_PATTERN = /^\/(\w+)\s*(.*)/;

const VALID_COMMANDS: ReadonlySet<string> = new Set<GmCommandType>([
  'act', 'scene', 'spotlight', 'engagement',
  'separation', 'climax', 'seed', 'sleep', 'wake',
  'endtime', 'npc',
]);

/**
 * Parse a chat message for a GM command.
 * Returns null if the message isn't a valid GM command.
 */
export function parseGmCommand(text: string, timestamp: string): GmCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(COMMAND_PATTERN);
  if (!match) return null;

  const commandName = match[1].toLowerCase();
  if (!VALID_COMMANDS.has(commandName)) return null;

  const argsStr = match[2].trim();
  const args = argsStr ? argsStr.split(/\s+/) : [];

  return {
    type: commandName as GmCommandType,
    args,
    raw: trimmed,
    timestamp,
  };
}
