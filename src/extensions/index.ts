/**
 * Extensions index — registers all built-in extensions (Persona, ShareLink, Skill Learner)
 */

import type { VexConfig } from "../types/index.js";
import type { Agent } from "../agents/agent.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("extensions");

/** Initialize all built-in extensions */
export async function initExtensions(config: VexConfig, agent: Agent): Promise<void> {
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
      await initShareLink(config, agent);
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
      await initSkillLearner(config);
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
      await initPersona(config);
      logger.info("Private Persona extension initialized");
    } catch (error) {
      logger.error({ error }, "Failed to initialize Private Persona extension");
    }
  } else {
    logger.debug("Private Persona extension disabled");
  }
}
