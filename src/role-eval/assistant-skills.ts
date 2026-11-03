import { WORKBENCH_ROLES, type WorkbenchRole } from './workbench-access.js';

export const FRONT_CLAW = 'Front Claw';

/** The seven existing roles stay as skills of the single assistant. */
export const ASSISTANT_SKILL_NAMES: Record<WorkbenchRole, string> = {
  reception: '顾客接待',
  frontdesk: '前台预约',
  marketing: '内容营销',
  ads: '投放分析',
  manager: '店长分析',
  qa: '评测质检',
  training: '培训问答',
};

export interface AssistantSkill { key: WorkbenchRole; name: string; }

export function skillsFor(roles: readonly WorkbenchRole[]): AssistantSkill[] {
  return WORKBENCH_ROLES.filter(role => roles.includes(role)).map(key => ({ key, name: ASSISTANT_SKILL_NAMES[key] }));
}

export const ASSISTANT_TOOL_NAMES = [
  'report_numbers',
  'get_summary',
  'my_progress',
  'unreported',
  'stores_ranking',
  'set_target',
  'submit_appointment',
  'confirm_appointment',
] as const;

export type AssistantToolName = typeof ASSISTANT_TOOL_NAMES[number];
