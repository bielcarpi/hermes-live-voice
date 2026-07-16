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
  /** True only for the caller holding the gateway-local announcement lease. */
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
  claimNotificationAnnouncement(
    ownerId: string,
    taskId: string,
    claimantId: string,
  ): Promise<TaskNotificationAnnouncementClaim>;
  /** Persist announcement only after the realtime provider accepts the handoff. */
  completeNotificationAnnouncement(ownerId: string, taskId: string, claimantId: string): Promise<TaskRecord>;
  /** Release an uncompleted gateway-local claim so another live session can retry it. */
  releaseNotificationAnnouncement(ownerId: string, taskId: string, claimantId: string): void;
  subscribe(ownerId: string, listener: TaskRecordListener): () => void;
}
