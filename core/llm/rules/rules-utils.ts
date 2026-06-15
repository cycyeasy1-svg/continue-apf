import { RuleMetadata } from "../..";
import { getLastNPathParts } from "../../util/uri";
import type { RulePolicy } from "./types";

/**
 * The default on/off policy for a rule when the user has not explicitly toggled it.
 * Agent files (AGENTS.md / AGENT.md / CLAUDE.md) are opt-in; all other sources default on.
 */
export function getDefaultRulePolicy(rule: RuleMetadata): RulePolicy {
  return rule.source === "agentFile" ? "off" : "on";
}

export function getRuleDisplayName(rule: RuleMetadata): string {
  if (rule.name) {
    return rule.name;
  }
  return getRuleSourceDisplayName(rule);
}

export function getRuleSourceDisplayName(rule: RuleMetadata): string {
  switch (rule.source) {
    case ".continuerules":
      return "Project rules";
    case "default-chat":
      return "Default chat system message";
    case "default-plan":
      return "Default plan mode system message";
    case "default-agent":
      return "Default agent system message";
    case "json-systemMessage":
      return "System Message (JSON)";
    case "model-options-agent":
      return "Base System Agent Message";
    case "model-options-plan":
      return "Base System Plan Message";
    case "model-options-chat":
      return "Base System Chat Message";
    case "agentFile":
      if (rule.sourceFile) {
        return getLastNPathParts(rule.sourceFile, 2);
      } else {
        return "Agent file";
      }
    case "colocated-markdown":
      if (rule.sourceFile) {
        return getLastNPathParts(rule.sourceFile, 2);
      } else {
        return "rules.md";
      }
    case "rules-block":
      return "Rules Block";
    default:
      return rule.source;
  }
}
