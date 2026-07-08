/**
 * Extensions index — registers all built-in extensions (Persona, ShareLink, Skill Learner)
 */

import type { VexConfig } from "../types/index.js";
import type { Agent } from "../agents/agent.js";
import type { MemoryManager } from "../memory/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("extensions");

/** Initialize all built-in extensions */
export async function initExtensions(
  config: VexConfig,
  agent: Agent,
  options?: { memoryManager?: MemoryManager; ownerId?: string },
): Promise<void> {
  logger.debug(
    {
      sharelinkEnabled: config.sharelink?.enabled !== false,
      skillLearnerEnabled: config.skillLearner?.enabled !== false,
      personaEnabled: config.persona?.enabled !== false,
    },
    "Initializing built-in extensions"
  );
  // ShareLink
  if (config.sharelink?.enabled !== false) {
    try {
      const { initShareLink } = await import("./sharelink/index.js");
      void agent;
      initShareLink(config, { ownerId: options?.ownerId });
      logger.info("ShareLink extension initialized");
    } catch (error) {
      logger.error({ error }, "Failed to initialize ShareLink extension");
    }
  } else {
    logger.debug("ShareLink extension disabled");
  }

  // Skill Learner
  if (config.skillLearner?.enabled !== false) {
    try {
      const { initSkillLearner } = await import("./skilllearner/index.js");
      await initSkillLearner(config, { memoryManager: options?.memoryManager, ownerId: options?.ownerId });
      logger.info("Skill Learner extension initialized");
    } catch (error) {
      logger.error({ error }, "Failed to initialize Skill Learner extension");
    }
  } else {
    logger.debug("Skill Learner extension disabled");
  }

  // Private Persona
  if (config.persona?.enabled !== false) {
    try {
      const { initPersona } = await import("./persona/index.js");
      await initPersona(config, { memoryManager: options?.memoryManager, ownerId: options?.ownerId });
      logger.info("Private Persona extension initialized");
    } catch (error) {
      logger.error({ error }, "Failed to initialize Private Persona extension");
    }
  } else {
    logger.debug("Private Persona extension disabled");
  }
}

/** Release a single owner's per-user extension state when their runtime is torn down. */
export async function disposeExtensions(ownerId: string): Promise<void> {
  try {
    const { disposePersonaOwner } = await import("./persona/index.js");
    disposePersonaOwner(ownerId);
  } catch (error) {
    logger.warn({ error, ownerId }, "Failed to dispose persona owner state");
  }
  try {
    const { disposeSkillLearnerOwner } = await import("./skilllearner/index.js");
    disposeSkillLearnerOwner(ownerId);
  } catch (error) {
    logger.warn({ error, ownerId }, "Failed to dispose skill-learner owner state");
  }
  try {
    const { disposeShareLinkOwner } = await import("./sharelink/index.js");
    disposeShareLinkOwner(ownerId);
  } catch (error) {
    logger.warn({ error, ownerId }, "Failed to dispose sharelink owner state");
  }
}
