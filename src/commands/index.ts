/**
 * Command system - slash command processing
 */

import type { InboundMessageContext } from "../types/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("commands");

// ============== Command Types ==============

/** Command context */
export interface CommandContext {
  /** Original message context */
  message: InboundMessageContext;
  /** Command arguments (everything after command name) */
  args: string;
  /** Parsed arguments array */
  argsArray: string[];
  /** Named arguments (--key=value format) */
  namedArgs: Record<string, string>;
}

/** Command handler */
export type CommandHandler = (
  ctx: CommandContext
) => string | Promise<string>;

/** Command definition */
export interface CommandDefinition {
  /** Command name (without slash) */
  name: string;
  /** Command aliases */
  aliases?: string[];
  /** Command description */
  description: string;
  /** Usage instructions */
  usage?: string;
  /** Handler function */
  handler: CommandHandler;
  /** Whether to hide (not shown in help) */
  hidden?: boolean;
}

// ============== Command Registry ==============

/** Command registry */
const commandRegistry = new Map<string, CommandDefinition>();

/** Register a command */
export function registerCommand(command: CommandDefinition): void {
  const normalizedName = command.name.toLowerCase();
  commandRegistry.set(normalizedName, command);

  // Register aliases
  if (command.aliases) {
    for (const alias of command.aliases) {
      commandRegistry.set(alias.toLowerCase(), command);
    }
  }

  logger.debug({ command: command.name }, "Command registered");
}

/** Register multiple commands */
export function registerCommands(commands: CommandDefinition[]): void {
  for (const command of commands) {
    registerCommand(command);
  }
}

/** Get a command by name */
export function getCommand(name: string): CommandDefinition | undefined {
  return commandRegistry.get(name.toLowerCase());
}

/** Get all commands */
export function getAllCommands(): CommandDefinition[] {
  const uniqueCommands = new Map<string, CommandDefinition>();
  for (const command of commandRegistry.values()) {
    uniqueCommands.set(command.name, command);
  }
  return Array.from(uniqueCommands.values());
}

// ============== Command Parsing ==============

/** Command prefixes */
const COMMAND_PREFIXES = ["/", "!"];

/** Check whether text is a command */
export function isCommand(text: string): boolean {
  const trimmed = text.trim();
  return COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Parse a command */
export function parseCommand(text: string): {
  name: string;
  args: string;
  argsArray: string[];
  namedArgs: Record<string, string>;
} | null {
  const trimmed = text.trim();

  // Check prefix
  let content = "";
  for (const prefix of COMMAND_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      content = trimmed.slice(prefix.length);
      break;
    }
  }

  if (!content) return null;

  // Separate command name and arguments
  const spaceIndex = content.indexOf(" ");
  const name = spaceIndex === -1 ? content : content.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? "" : content.slice(spaceIndex + 1).trim();

  // Parse arguments
  const argsArray: string[] = [];
  const namedArgs: Record<string, string> = {};

  if (args) {
    // Simple argument parsing (supports quoting)
    const regex = /--(\w+)=("([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;

    while ((match = regex.exec(args)) !== null) {
      if (match[1]) {
        // Named argument --key=value
        const key = match[1];
        const value = match[3] ?? match[4] ?? match[5] ?? "";
        namedArgs[key] = value;
      } else {
        // Positional argument
        const value = match[6] ?? match[7] ?? match[8] ?? "";
        argsArray.push(value);
      }
    }
  }

  return { name: name.toLowerCase(), args, argsArray, namedArgs };
}

// ============== Command Execution ==============

/** Execute a command */
export async function executeCommand(
  message: InboundMessageContext
): Promise<string | null> {
  if (!isCommand(message.content)) {
    return null;
  }

  const parsed = parseCommand(message.content);
  if (!parsed) return null;

  const command = getCommand(parsed.name);
  if (!command) {
    return `Unknown command: ${parsed.name}\nUse /help to see available commands`;
  }

  const ctx: CommandContext = {
    message,
    args: parsed.args,
    argsArray: parsed.argsArray,
    namedArgs: parsed.namedArgs,
  };

  try {
    logger.debug({ command: parsed.name, args: parsed.args }, "Executing command");
    return await command.handler(ctx);
  } catch (error) {
    logger.error({ command: parsed.name, error }, "Command execution error");
    return `Command execution error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============== Built-in Commands ==============

/** Help command */
const helpCommand: CommandDefinition = {
  name: "help",
  aliases: ["h", "?"],
  description: "Show help information",
  usage: "/help [command name]",
  handler: (ctx) => {
    const { argsArray } = ctx;

    if (argsArray.length > 0) {
      // Show help for a specific command
      const commandName = argsArray[0]!;
      const command = getCommand(commandName);
      if (!command) {
        return `Unknown command: ${commandName}`;
      }
      return `📖 ${command.name}\n\n${command.description}\n\nUsage: ${command.usage ?? `/${command.name}`}`;
    }

    // Show all commands
    const commands = getAllCommands().filter((c) => !c.hidden);
    const lines = ["📚 Available commands:\n"];

    for (const cmd of commands) {
      lines.push(`  /${cmd.name} - ${cmd.description}`);
    }

    lines.push("\nUse /help <command name> for detailed usage");
    return lines.join("\n");
  },
};

/** Clear session command */
const clearCommand: CommandDefinition = {
  name: "clear",
  aliases: ["reset", "newchat"],
  description: "Clear current session history",
  handler: () => {
    return "Session cleared. Let's start a new conversation!";
  },
};

/** Status command */
const statusCommand: CommandDefinition = {
  name: "status",
  description: "Show current status",
  handler: (ctx) => {
    const lines = [
      "📊 Current Status",
      "",
      `Channel: ${ctx.message.channelId}`,
      `Chat type: ${ctx.message.chatType === "group" ? "Group" : "Direct"}`,
      `Sender: ${ctx.message.senderName ?? ctx.message.senderId}`,
    ];
    return lines.join("\n");
  },
};

/** Register built-in commands */
export function registerBuiltinCommands(): void {
  registerCommands([helpCommand, clearCommand, statusCommand]);
}
