export type PlanAction = "create" | "update" | "recreate" | "skip" | "conflict";

export interface ExportPlanItem {
  filePath: string;
  title: string;
  selected: boolean;

  action: PlanAction;
  overrideAction?: PlanAction;
  reason: string;

  pageId?: string;
  webui?: string;

  existingTitle?: string;
  titleChanged?: boolean;

  hasSnapshot: boolean;
  hasDiff: boolean;
  diffOld?: string;
  diffNew?: string;

  // Hierarchy
  intendedParentFilePath?: string | null; // for preview
  intendedParentPageId?: string | null; // used when creating/moving
  depth?: number; // for UI indent

  conflictPageId?: string;
  conflictWebui?: string;
}

export function effectiveAction(i: ExportPlanItem): PlanAction {
  return (i.overrideAction ?? i.action) as PlanAction;
}
