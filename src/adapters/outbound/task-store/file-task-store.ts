import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  TaskListOptions,
  TaskPruneOptions,
  TaskPruneResult,
  TaskStorePort,
  TaskUpdateOptions,
} from "../../../application/task-supervisor/ports/task-store.port.js";
import {
  MAX_TASK_EVENTS,
  TASK_RECORD_SCHEMA_VERSION,
  TaskIdSchema,
  TaskOwnerIdSchema,
  TaskRecordSchema,
  TaskStatusSchema,
  canTransitionTask,
  isTaskTerminal,
  parseTaskRecord,
  parseTaskTimestamp,
  type TaskRecord,
  type TaskStatus,
} from "../../../domain/tasks/index.js";

const DEFAULT_FILENAME = "tasks-v1.json";
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_STORE_BYTES = 64 * 1024 * 1024;

const TaskStoreDocumentSchema = z.object({
  schemaVersion: z.literal(TASK_RECORD_SCHEMA_VERSION),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tasks: z.array(TaskRecordSchema),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  for (const task of document.tasks) {
    if (ids.has(task.taskId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate task ID: ${task.taskId}` });
      return;
    }
    ids.add(task.taskId);
  }
});

interface TaskStoreDocument {
  schemaVersion: typeof TASK_RECORD_SCHEMA_VERSION;
  updatedAt: number;
  tasks: TaskRecord[];
}

export interface FileTaskStoreOptions {
  directory: string;
  filename?: string;
  maxRecords?: number;
  retentionMs?: number;
  maxStoreBytes?: number;
  now?: () => number;
}

export class TaskStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreCorruptionError";
  }
}

export class TaskStoreCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStoreCapacityError";
  }
}

export class TaskStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStoreConflictError";
  }
}

export class FileTaskStore implements TaskStorePort {
  readonly filePath: string;
  private readonly directory: string;
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private readonly maxStoreBytes: number;
  private readonly now: () => number;
  private records?: Map<string, TaskRecord>;
  private documentUpdatedAt = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private poisoned?: TaskStoreCorruptionError;

  constructor(options: FileTaskStoreOptions) {
    if (!isAbsolute(options.directory) || options.directory.includes("\0")) {
      throw new Error("Task store directory must be an absolute safe path.");
    }
    const filename = options.filename ?? DEFAULT_FILENAME;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(filename)) {
      throw new Error("Task store filename must be a simple .json filename.");
    }
    this.directory = options.directory;
    this.filePath = join(this.directory, filename);
    this.maxRecords = positiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, "maxRecords");
    this.retentionMs = nonNegativeInteger(options.retentionMs ?? DEFAULT_RETENTION_MS, "retentionMs");
    this.maxStoreBytes = positiveInteger(options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES, "maxStoreBytes");
    this.now = options.now ?? Date.now;
  }

  load(taskId: string): Promise<TaskRecord | undefined> {
    const id = TaskIdSchema.parse(taskId);
    return this.serialized(async () => {
      await this.ensureLoaded();
      return cloneTask(this.records!.get(id));
    });
  }

  list(options: TaskListOptions = {}): Promise<TaskRecord[]> {
    const ownerId = options.ownerId === undefined ? undefined : TaskOwnerIdSchema.parse(options.ownerId);
    return this.serialized(async () => {
      await this.ensureLoaded();
      const statusSet = options.statuses ? new Set<TaskStatus>(options.statuses.map((value) => TaskStatusSchema.parse(value))) : undefined;
      // The configured record capacity is the authoritative query bound. A
      // fixed lower ceiling can hide active work or unread notifications when
      // history + queue + concurrency legitimately exceed that ceiling.
      const limit = Math.min(positiveInteger(options.limit ?? this.maxRecords, "list limit"), this.maxRecords);
      return [...this.records!.values()]
        .filter((record) => !ownerId || record.ownerId === ownerId)
        .filter((record) => !statusSet || statusSet.has(record.status))
        .filter((record) => options.notificationUnread === undefined
          || record.notification.unread === options.notificationUnread)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId))
        .slice(0, limit)
        .map((record) => cloneTask(record)!);
    });
  }

  put(value: TaskRecord): Promise<TaskRecord> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const record = parseTaskRecord(value);
      if (this.records!.has(record.taskId)) {
        throw new TaskStoreConflictError(`Task already exists: ${record.taskId}`);
      }
      const next = new Map(this.records);
      this.pruneMap(next, this.now() - this.retentionMs, this.maxRecords - 1);
      if (next.size >= this.maxRecords) {
        throw new TaskStoreCapacityError(
          `Task store reached its ${this.maxRecords}-record capacity and has no terminal record eligible for pruning.`,
        );
      }
      next.set(record.taskId, cloneTask(record)!);
      await this.persist(next);
      this.records = next;
      return cloneTask(record)!;
    });
  }

  update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord> {
    const id = TaskIdSchema.parse(taskId);
    return this.serialized(async () => {
      await this.ensureLoaded();
      const current = this.records!.get(id);
      if (!current) throw new Error(`Task not found: ${id}`);
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
        throw new TaskStoreConflictError(
          `Task revision conflict for ${id}: expected ${options.expectedRevision}, found ${current.revision}.`,
        );
      }
      const updated = parseTaskRecord(updater(cloneTask(current)!));
      if (!hasSameTaskDefinition(current, updated)) {
        throw new TaskStoreConflictError("Task identity and execution-definition fields are immutable.");
      }
      if (isDeepStrictEqual(updated, current)) {
        return cloneTask(current)!;
      }
      if (updated.revision !== current.revision + 1) {
        throw new TaskStoreConflictError("Task updates must advance revision by exactly one.");
      }
      if (updated.sequence !== current.sequence + 1) {
        throw new TaskStoreConflictError("Non-idempotent task updates must advance sequence by exactly one.");
      }
      if (updated.updatedAt < current.updatedAt) {
        throw new TaskStoreConflictError("Task updates cannot move updatedAt backwards.");
      }
      if (!canTransitionTask(current.status, updated.status)) {
        throw new TaskStoreConflictError(`Task status cannot move from ${current.status} to ${updated.status}.`);
      }
      if (current.runId !== undefined && updated.runId !== current.runId) {
        throw new TaskStoreConflictError("A persisted task run ID is immutable after assignment.");
      }
      if (
        current.stopRequestedAt !== undefined
        && updated.stopRequestedAt !== current.stopRequestedAt
      ) {
        throw new TaskStoreConflictError("A persisted task stop intent is append-only.");
      }
      if (current.stopRequestedAt === undefined && updated.stopRequestedAt !== undefined) {
        const stopEvent = updated.events.at(-1);
        if (stopEvent?.type !== "stop_requested" || stopEvent.timestamp !== updated.stopRequestedAt) {
          throw new TaskStoreConflictError("A persisted task stop intent requires its append-only stop event.");
        }
      }
      const expectedPriorEvents = current.events.length === MAX_TASK_EVENTS
        ? current.events.slice(1)
        : current.events;
      if (!isDeepStrictEqual(updated.events.slice(0, -1), expectedPriorEvents)) {
        throw new TaskStoreConflictError("Task event history is append-only.");
      }
      const next = new Map(this.records);
      next.set(id, cloneTask(updated)!);
      await this.persist(next);
      this.records = next;
      return cloneTask(updated)!;
    });
  }

  delete(taskId: string): Promise<boolean> {
    const id = TaskIdSchema.parse(taskId);
    return this.serialized(async () => {
      await this.ensureLoaded();
      if (!this.records!.has(id)) return false;
      const next = new Map(this.records);
      next.delete(id);
      await this.persist(next);
      this.records = next;
      return true;
    });
  }

  prune(options: TaskPruneOptions = {}): Promise<TaskPruneResult> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const terminalBefore = parseTaskTimestamp(
        options.terminalBefore ?? Math.max(0, this.now() - this.retentionMs),
        "Prune timestamp",
      );
      const maxRecords = positiveInteger(options.maxRecords ?? this.maxRecords, "prune maxRecords");
      const next = new Map(this.records);
      const taskIds = this.pruneMap(next, terminalBefore, maxRecords);
      if (taskIds.length > 0) {
        await this.persist(next);
        this.records = next;
      }
      return { deleted: taskIds.length, taskIds };
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.poisoned) throw this.poisoned;
      return operation();
    };
    const result = this.operationTail.then(guarded, guarded);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.records) return;
    await this.ensureDirectory();
    let handle;
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.records = new Map();
        this.documentUpdatedAt = 0;
        return;
      }
      if (isNodeError(error, "ELOOP")) {
        throw new TaskStoreCorruptionError("Task store path must not be a symbolic link.", { cause: error });
      }
      throw error;
    }
    let raw: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new TaskStoreCorruptionError("Task store path is not a regular file.");
      }
      if (stat.size > this.maxStoreBytes) {
        throw new TaskStoreCorruptionError(`Task store exceeds its ${this.maxStoreBytes}-byte safety limit.`);
      }
      await handle.chmod(0o600);
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new TaskStoreCorruptionError("Task store contains invalid JSON; refusing to reset it.", { cause: error });
    }
    const parsed = TaskStoreDocumentSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new TaskStoreCorruptionError(
        `Task store failed schema validation; refusing to reset it: ${parsed.error.issues[0]?.message ?? "invalid document"}`,
      );
    }
    const loaded = new Map(parsed.data.tasks.map((task) => [task.taskId, cloneTask(task)!]));
    const pruned = this.pruneMap(
      loaded,
      Math.max(0, this.now() - this.retentionMs),
      this.maxRecords,
    );
    if (loaded.size > this.maxRecords) {
      throw new TaskStoreCorruptionError(
        `Task store has ${loaded.size} non-prunable records, above the configured ${this.maxRecords}-record limit.`,
      );
    }
    this.documentUpdatedAt = parsed.data.updatedAt;
    if (pruned.length > 0) await this.persist(loaded);
    this.records = loaded;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TaskStoreCorruptionError("Task store directory is not a regular directory.");
    }
    if (
      process.platform !== "win32"
      && typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    ) {
      throw new TaskStoreCorruptionError("Task store directory must be owned by the gateway process user.");
    }
    await chmod(this.directory, 0o700);
  }

  private async persist(records: Map<string, TaskRecord>): Promise<void> {
    await this.ensureDirectory();
    const updatedAt = Math.max(this.documentUpdatedAt, parseTaskTimestamp(this.now(), "Store timestamp"));
    const document: TaskStoreDocument = {
      schemaVersion: TASK_RECORD_SCHEMA_VERSION,
      updatedAt,
      tasks: [...records.values()]
        .map((task) => parseTaskRecord(task))
        .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)),
    };
    TaskStoreDocumentSchema.parse(document);
    const payload = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.maxStoreBytes) {
      throw new TaskStoreCapacityError(`Task store write exceeds its ${this.maxStoreBytes}-byte safety limit.`);
    }

    const tempPath = join(this.directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let renamed = false;
    try {
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.filePath);
      renamed = true;
      await syncDirectory(this.directory);
      this.documentUpdatedAt = updatedAt;
    } catch (error) {
      if (renamed) {
        // The new document is visible but its directory entry could not be
        // proven durable. Freeze this instance so stale in-memory state can
        // never overwrite an ambiguously committed document; restart reloads
        // the actual file and re-establishes one coherent source of truth.
        this.poisoned = new TaskStoreCorruptionError(
          "Task store commit could not be confirmed after rename; restart the gateway before retrying.",
          { cause: error },
        );
        throw this.poisoned;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  private pruneMap(records: Map<string, TaskRecord>, terminalBefore: number, maxRecords: number): string[] {
    const deleted: string[] = [];
    const terminal = [...records.values()]
      .filter((record) => isTaskTerminal(record.status))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.taskId.localeCompare(right.taskId));
    for (const record of terminal) {
      if (record.updatedAt < terminalBefore) {
        records.delete(record.taskId);
        deleted.push(record.taskId);
      }
    }
    for (const record of terminal) {
      if (records.size <= maxRecords) break;
      if (!records.has(record.taskId)) continue;
      records.delete(record.taskId);
      deleted.push(record.taskId);
    }
    return deleted;
  }
}

function cloneTask(record: TaskRecord | undefined): TaskRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function hasSameTaskDefinition(current: TaskRecord, updated: TaskRecord): boolean {
  return current.schemaVersion === updated.schemaVersion
    && current.taskId === updated.taskId
    && current.ownerId === updated.ownerId
    && current.input === updated.input
    && current.title === updated.title
    && current.hermesSessionId === updated.hermesSessionId
    && current.executionMode === updated.executionMode
    && current.createdAt === updated.createdAt
    && isDeepStrictEqual(current.resourceKeys, updated.resourceKeys);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
