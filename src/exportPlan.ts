export type PlanAction = "create" | "update" | "recreate" | "skip";

export interface ExportPlanItem {
  filePath: string;
  title: string;

  selected: boolean;
  action: PlanAction;

  // Where we think it will go
  pageId?: string;
  webui?: string;

  reason: string;
}