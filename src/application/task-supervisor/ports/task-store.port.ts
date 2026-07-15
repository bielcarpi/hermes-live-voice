import type { TaskRecord, TaskStatus } from "../../../domain/tasks/index.js";

export interface TaskListOptions {
  ownerId?: string;
  statuses?: readonly TaskStatus[];
  notificationUnread?: boolean;
  limit?: number;
}

export interface TaskUpdateOptions {
  expectedRevision?: number;
}

export interface TaskPruneOptions {
  terminalBefore?: number;
  maxRecords?: number;
}

export interface TaskPruneResult {
  deleted: number;
  taskIds: string[];
}

export interface TaskStorePort {
  load(taskId: string): Promise<TaskRecord | undefined>;
  list(options?: TaskListOptions): Promise<TaskRecord[]>;
  put(record: TaskRecord): Promise<TaskRecord>;
  update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options?: TaskUpdateOptions,
  ): Promise<TaskRecord>;
  delete(taskId: string): Promise<boolean>;
  prune(options?: TaskPruneOptions): Promise<TaskPruneResult>;
}
