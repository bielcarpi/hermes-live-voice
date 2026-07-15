import type { TaskExecutionMode, TaskRecord } from "../../../domain/tasks/index.js";

export interface SubmitBackgroundTaskInput {
  ownerIdentity: string;
  sessionKey: string;
  input: string;
  title?: string;
  executionMode?: TaskExecutionMode;
  resourceKeys?: readonly string[];
}

export type TaskRecordListener = (record: TaskRecord) => void;

export interface TaskNotificationAnnouncementClaim {
  /** True only for the caller that durably persisted the first announcement claim. */
  claimed: boolean;
  task: TaskRecord;
}

/** Voice-facing surface of the server-owned runtime. */
export interface TaskSupervisorPort {
  registerOwner(ownerIdentity: string, sessionKey: string): string;
  submit(input: SubmitBackgroundTaskInput): Promise<TaskRecord>;
  /** Recent owner history. Callers may request one extra record to compute truthful truncation. */
  list(ownerId: string, limit?: number): Promise<TaskRecord[]>;
  /** Every retained non-terminal owner task, independent of the recent-history limit. */
  listActive(ownerId: string): Promise<TaskRecord[]>;
  /** Every retained unread owner notification, independent of the recent-history limit. */
  listUnreadNotifications(ownerId: string): Promise<TaskRecord[]>;
  get(ownerId: string, taskId: string): Promise<TaskRecord | undefined>;
  stop(ownerId: string, taskId: string, reason?: string): Promise<TaskRecord>;
  acknowledgeNotification(ownerId: string, taskId: string): Promise<TaskRecord>;
  markNotificationAnnounced(ownerId: string, taskId: string): Promise<TaskRecord>;
  claimNotificationAnnouncement(ownerId: string, taskId: string): Promise<TaskNotificationAnnouncementClaim>;
  subscribe(ownerId: string, listener: TaskRecordListener): () => void;
}
