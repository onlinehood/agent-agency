import type { ProjectStatus } from "../types.js";
import { InvalidTransitionError } from "../../util/errors.js";

/**
 * Project lifecycle (PRD §5.3):
 * proposed → active → paused/blocked → completed → archived, archive is restorable.
 */
const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  proposed: ["active", "archived"],
  active: ["paused", "blocked", "completed", "archived"],
  paused: ["active", "archived", "completed"],
  blocked: ["active", "paused", "archived"],
  completed: ["active", "archived"],
  archived: ["active", "paused", "completed"], // restore
};

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) throw new InvalidTransitionError("project", from, to);
}

export function isProjectRunnable(status: ProjectStatus): boolean {
  return status === "active";
}
