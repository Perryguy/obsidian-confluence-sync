export type PlanAction = "create" | "update" | "recreate" | "skip" | "conflict";

export interface ExportPlanItem {
  filePath: string;
  title: string;

  selected: boolean;

  /** Suggested action from plan builder */
  action: PlanAction;

  /** Optional user override from the UI */
  overrideAction?: PlanAction;

  /** Target Confluence page (if known) */
  pageId?: string;
  webui?: string;

  /** If conflict, this is the conflicting page found in space (but not under parent) */
  conflictPageId?: string;
  conflictWebui?: string;

  /** Human-readable reason for the suggested action */
  reason: string;
}

/** Effective action after applying override */
export function effectiveAction(item: ExportPlanItem): PlanAction {
  return item.overrideAction ?? item.action;
}
