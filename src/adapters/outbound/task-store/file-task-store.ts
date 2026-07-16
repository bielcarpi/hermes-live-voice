import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
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
const LOCK_OWNER_FILENAME = "owner.json";
const MAX_LOCK_OWNER_BYTES = 4_096;
// JSON can encode one allowed lone UTF-16 surrogate as six ASCII bytes. Two
// MiB therefore covers the largest retained 200k-character output, terminal
// event/usage metadata, and conservative serialization overhead.
const TERMINAL_TRANSITION_RESERVE_BYTES = 2 * 1024 * 1024;
const CONTROL_TRANSITION_RESERVE_BYTES = 64 * 1024;
// Stable admission also leaves 32 KiB inside each 2 MiB task slot for the
// supervisor's bounded progress, retry, stop, and lifecycle metadata. Later
// transitions may consume that allowance without weakening the remaining
// terminal-output budget.
const CONTROL_TRANSITION_ALLOWANCE_BYTES_PER_SLOT = 32 * 1024;
const MAX_CONFIGURED_TERMINAL_RESERVE_SLOTS = 16;
// A beta-era document could legitimately fill the old 64 MiB payload ceiling
// before terminal-transition reserves existed. Stable v0.5 may temporarily
// exceed that ceiling only while draining such existing work. The allowance is
// exactly bounded to the largest supported concurrency plus control metadata.
const LEGACY_RESERVE_MIGRATION_BYTES = CONTROL_TRANSITION_RESERVE_BYTES
  + MAX_CONFIGURED_TERMINAL_RESERVE_SLOTS * TERMINAL_TRANSITION_RESERVE_BYTES;

const TaskStoreLockOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  token: z.string().uuid(),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostname: z.string().trim().min(1).max(255),
  acquiredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

type TaskStoreLockOwner = z.infer<typeof TaskStoreLockOwnerSchema>;

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
  terminalReserveSlots?: number;
  automaticPruning?: boolean;
  now?: () => number;
}

export interface ClearAbandonedTaskStoreLockResult {
  cleared: boolean;
  ownerPid?: number;
  ownerHostname?: string;
  ownerMetadataValid?: boolean;
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

export class TaskStoreLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStoreLockedError";
  }
}

export class FileTaskStore implements TaskStorePort {
  readonly filePath: string;
  private readonly directory: string;
  private readonly lockDirectory: string;
  private readonly lockOwnerPath: string;
  private readonly lockToken = randomUUID();
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private readonly maxStoreBytes: number;
  private readonly maximumStoreBytes: number;
  private readonly terminalReserveSlots: number;
  private readonly automaticPruning: boolean;
  private readonly now: () => number;
  private capacityLimitBytes: number;
  private records?: Map<string, TaskRecord>;
  private documentUpdatedAt = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private poisoned?: TaskStoreCorruptionError;
  private lockCleanupFailure?: TaskStoreCorruptionError;
  private lockHeld = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: FileTaskStoreOptions) {
    const resolved = resolveStorePaths(options);
    this.directory = resolved.directory;
    this.filePath = resolved.filePath;
    this.lockDirectory = `${this.filePath}.lock`;
    this.lockOwnerPath = join(this.lockDirectory, LOCK_OWNER_FILENAME);
    this.maxRecords = positiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, "maxRecords");
    this.retentionMs = nonNegativeInteger(options.retentionMs ?? DEFAULT_RETENTION_MS, "retentionMs");
    this.maxStoreBytes = positiveInteger(options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES, "maxStoreBytes");
    if (this.maxStoreBytes > Number.MAX_SAFE_INTEGER - LEGACY_RESERVE_MIGRATION_BYTES) {
      throw new Error("maxStoreBytes leaves no safe room for the bounded legacy migration allowance.");
    }
    this.maximumStoreBytes = this.maxStoreBytes + LEGACY_RESERVE_MIGRATION_BYTES;
    this.terminalReserveSlots = boundedPositiveInteger(
      options.terminalReserveSlots ?? 1,
      "terminalReserveSlots",
      MAX_CONFIGURED_TERMINAL_RESERVE_SLOTS,
    );
    this.automaticPruning = options.automaticPruning !== false;
    this.now = options.now ?? Date.now;
    this.capacityLimitBytes = this.maxStoreBytes;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      const release = () => this.releaseLock();
      this.closePromise = this.operationTail.then(release, release);
      this.operationTail = this.closePromise.then(() => undefined, () => undefined);
    }
    return this.closePromise;
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
      if (this.automaticPruning) {
        this.pruneMap(next, this.now() - this.retentionMs, this.maxRecords - 1);
      }
      if (next.size >= this.maxRecords) {
        throw new TaskStoreCapacityError(
          `Task store reached its ${this.maxRecords}-record capacity and has no operationally closed record eligible for pruning.`,
        );
      }
      next.set(record.taskId, cloneTask(record)!);
      await this.persist(next, {
        protectedTaskIds: new Set([record.taskId]),
        // Existing beta state may be using the migration allowance, but a new
        // task is accepted only when the normal configured budget can still
        // preserve every configured concurrent task's terminal transition.
        capacityLimitBytes: this.maxStoreBytes,
      });
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
      if (
        current.operatorContainedAt !== undefined
        && updated.operatorContainedAt !== current.operatorContainedAt
      ) {
        throw new TaskStoreConflictError("A persisted operator-containment disposition is append-only.");
      }
      if (current.operatorContainedAt === undefined && updated.operatorContainedAt !== undefined) {
        const containmentEvent = updated.events.at(-1);
        if (
          containmentEvent?.type !== "operator_contained"
          || containmentEvent.timestamp !== updated.operatorContainedAt
        ) {
          throw new TaskStoreConflictError("Operator containment requires its exact append-only audit event.");
        }
      }
      if (
        current.upstreamRunMissingAt !== undefined
        && updated.upstreamRunMissingAt !== current.upstreamRunMissingAt
      ) {
        throw new TaskStoreConflictError("A confirmed missing upstream run is append-only.");
      }
      if (current.upstreamRunMissingAt === undefined && updated.upstreamRunMissingAt !== undefined) {
        const missingEvent = updated.events.at(-1);
        if (missingEvent?.type !== "unknown" || missingEvent.timestamp !== updated.upstreamRunMissingAt) {
          throw new TaskStoreConflictError(
            "A confirmed missing upstream run requires its exact append-only unknown event.",
          );
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
      await this.persist(next, {
        protectedTaskIds: new Set([id]),
        // A durable terminal/contained transition consumes the reserve held
        // for this active task. Queued capacity is proven again before the
        // scheduler can move another record into dispatching.
        reserveQueuedCapacity: !isTaskOperationallyClosedForCapacity(updated),
        // Admission holds a shared control reserve. Later transitions consume
        // that reserve while retaining the terminal slots that are still owed.
        reserveControlCapacity: false,
      });
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
    const guarded = async () => {
      if (this.closed) throw new Error("Task store is closed.");
      if (this.poisoned) throw this.poisoned;
      try {
        return await operation();
      } catch (error) {
        if (!this.records && this.lockHeld) {
          try {
            await this.releaseLock();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Task store initialization failed and its writer lock could not be released cleanly.",
            );
          }
        }
        throw error;
      }
    };
    const result = this.operationTail.then(guarded, guarded);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.records) {
      await this.assertLockOwned();
      return;
    }
    await this.ensureDirectory();
    await this.acquireLock();
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
      if (stat.size > this.maximumStoreBytes) {
        throw new TaskStoreCorruptionError(
          `Task store exceeds its ${this.maximumStoreBytes}-byte bounded migration safety limit.`,
        );
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
    let pruned: string[] = [];
    if (this.automaticPruning) {
      pruned = this.pruneMap(
        loaded,
        Math.max(0, this.now() - this.retentionMs),
        this.maxRecords,
      );
      if (loaded.size > this.maxRecords) {
        throw new TaskStoreCorruptionError(
          `Task store has ${loaded.size} non-prunable records, above the configured ${this.maxRecords}-record limit.`,
        );
      }
    }
    const recordsBeforeCapacityPrune = loaded.size;
    let selected = loaded;
    if (this.automaticPruning) {
      const normalCandidate = cloneTaskMap(loaded);
      try {
        this.fitDocumentToByteLimit(
          normalCandidate,
          parsed.data.updatedAt,
          new Set(),
          this.maxStoreBytes,
        );
        selected = normalCandidate;
        this.capacityLimitBytes = this.maxStoreBytes;
      } catch (error) {
        if (!(error instanceof TaskStoreCapacityError)) throw error;
        // Do not delete queued or active beta work merely because the stable
        // release adds a completion reserve. A bounded migration ceiling lets
        // that already-accepted work finish while all new puts remain subject
        // to the normal configured limit.
        const migrationCandidate = cloneTaskMap(loaded);
        this.fitDocumentToByteLimit(
          migrationCandidate,
          parsed.data.updatedAt,
          new Set(),
          this.maximumStoreBytes,
        );
        selected = migrationCandidate;
        this.capacityLimitBytes = this.maximumStoreBytes;
      }
    } else {
      this.capacityLimitBytes = this.maximumStoreBytes;
      this.fitDocumentToByteLimit(
        selected,
        parsed.data.updatedAt,
        new Set(),
        this.maximumStoreBytes,
      );
    }
    this.documentUpdatedAt = parsed.data.updatedAt;
    if (pruned.length > 0 || selected.size < recordsBeforeCapacityPrune) {
      await this.persist(selected);
    }
    this.records = selected;
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

  private async persist(
    records: Map<string, TaskRecord>,
    options: {
      protectedTaskIds?: ReadonlySet<string>;
      capacityLimitBytes?: number;
      reserveQueuedCapacity?: boolean;
      reserveControlCapacity?: boolean;
    } = {},
  ): Promise<void> {
    await this.ensureDirectory();
    await this.assertLockOwned();
    const updatedAt = Math.max(this.documentUpdatedAt, parseTaskTimestamp(this.now(), "Store timestamp"));
    const { document, payload } = this.fitDocumentToByteLimit(
      records,
      updatedAt,
      options.protectedTaskIds ?? new Set(),
      options.capacityLimitBytes ?? this.capacityLimitBytes,
      options.reserveQueuedCapacity !== false,
      options.reserveControlCapacity !== false,
    );
    TaskStoreDocumentSchema.parse(document);

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
      await this.assertLockOwned();
      this.documentUpdatedAt = updatedAt;
      if (this.automaticPruning) {
        const strictNormalReserveBytes = capacityReserveBytes(records, this.terminalReserveSlots, true, true);
        const strictNormalFit = Buffer.byteLength(payload, "utf8") + strictNormalReserveBytes <= this.maxStoreBytes;
        // Only a store that was loaded in bounded migration mode may continue
        // using that allowance. A normal stable write never promotes itself to
        // migration capacity merely because queued work cannot yet be admitted.
        if (strictNormalFit || options.capacityLimitBytes === this.maxStoreBytes) {
          this.capacityLimitBytes = this.maxStoreBytes;
        }
      }
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

  private fitDocumentToByteLimit(
    records: Map<string, TaskRecord>,
    updatedAt: number,
    protectedTaskIds: ReadonlySet<string>,
    capacityLimitBytes = this.capacityLimitBytes,
    reserveQueuedCapacity = true,
    reserveControlCapacity = true,
  ): { document: TaskStoreDocument; payload: string } {
    const limit = positiveInteger(capacityLimitBytes, "task store capacity limit");
    if (limit > this.maximumStoreBytes) {
      throw new Error(`Task store capacity limit cannot exceed ${this.maximumStoreBytes} bytes.`);
    }
    const reserveBytes = this.automaticPruning
      ? capacityReserveBytes(
        records,
        this.terminalReserveSlots,
        reserveQueuedCapacity,
        reserveControlCapacity,
      )
      : 0;
    const payloadLimit = limit - reserveBytes;
    if (payloadLimit <= 0) {
      throw new TaskStoreCapacityError(
        `Task store cannot preserve its ${reserveBytes}-byte transition reserve within the ${limit}-byte limit.`,
      );
    }
    let built = buildTaskStoreDocument(records, updatedAt);
    let payload = `${JSON.stringify(built)}\n`;
    let bytes = Buffer.byteLength(payload, "utf8");
    if (bytes <= payloadLimit) return { document: built, payload };
    if (!this.automaticPruning) {
      throw new TaskStoreCapacityError(
        `Task store write exceeds its ${limit}-byte safety limit; automatic history pruning is disabled.`,
      );
    }

    const candidates = [...records.values()]
      .filter((record) =>
        !protectedTaskIds.has(record.taskId)
        && (
          isTaskTerminal(record.status)
          || record.upstreamRunMissingAt !== undefined
          || record.operatorContainedAt !== undefined
        ))
      .sort(comparePrunableRecords);

    let candidateIndex = 0;
    let estimatedBytes = bytes;
    while (candidateIndex < candidates.length && estimatedBytes > payloadLimit) {
      const candidate = candidates[candidateIndex++]!;
      records.delete(candidate.taskId);
      estimatedBytes -= Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1;
    }
    built = buildTaskStoreDocument(records, updatedAt);
    payload = `${JSON.stringify(built)}\n`;
    bytes = Buffer.byteLength(payload, "utf8");
    while (bytes > payloadLimit && candidateIndex < candidates.length) {
      records.delete(candidates[candidateIndex++]!.taskId);
      built = buildTaskStoreDocument(records, updatedAt);
      payload = `${JSON.stringify(built)}\n`;
      bytes = Buffer.byteLength(payload, "utf8");
    }
    if (bytes <= payloadLimit) return { document: built, payload };

    throw new TaskStoreCapacityError(
      `Task store cannot preserve ${reserveBytes} bytes for durable transitions within its ` +
      `${limit}-byte safety limit after pruning eligible history.`,
    );
  }

  private pruneMap(records: Map<string, TaskRecord>, terminalBefore: number, maxRecords: number): string[] {
    const deleted: string[] = [];
    const terminal = [...records.values()]
      .filter((record) =>
        isTaskTerminal(record.status)
        || record.upstreamRunMissingAt !== undefined
        || record.operatorContainedAt !== undefined)
      .sort(comparePrunableRecords);
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

  private async acquireLock(): Promise<void> {
    if (this.lockHeld) {
      await this.assertLockOwned();
      return;
    }
    try {
      await mkdir(this.lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new TaskStoreLockedError(
          `Task state is already owned by another gateway: ${this.filePath}. ` +
          "Run one gateway per state file. After an unclean exit, inspect the process and use " +
          "`hermes-live tasks unlock --confirm-no-gateway` only when no gateway is running.",
        );
      }
      throw error;
    }

    let handle;
    try {
      const owner: TaskStoreLockOwner = {
        schemaVersion: 1,
        token: this.lockToken,
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: parseTaskTimestamp(this.now(), "Lock timestamp"),
      };
      const payload = `${JSON.stringify(TaskStoreLockOwnerSchema.parse(owner))}\n`;
      handle = await open(
        this.lockOwnerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(this.lockDirectory);
      await syncDirectory(this.directory);
      this.lockHeld = true;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(this.lockOwnerPath).catch((cleanupError) => {
        if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
      });
      await rmdir(this.lockDirectory).catch((cleanupError) => {
        if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
      });
      throw error;
    }
  }

  private async assertLockOwned(): Promise<void> {
    if (this.poisoned) throw this.poisoned;
    if (!this.lockHeld) throw new TaskStoreLockedError("Task store ownership has not been acquired.");
    try {
      const owner = await readLockOwner(this.lockOwnerPath);
      if (!owner || owner.token !== this.lockToken) {
        throw new TaskStoreLockedError("Task store ownership changed while this gateway was running.");
      }
    } catch (error) {
      this.poisoned = error instanceof TaskStoreCorruptionError
        ? error
        : new TaskStoreCorruptionError(
          "Task store ownership could not be verified; restart the gateway before retrying.",
          { cause: error },
        );
      throw this.poisoned;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) {
      if (this.lockCleanupFailure) throw this.lockCleanupFailure;
      return;
    }
    await this.assertLockOwned();
    let ownerRemoved = false;
    try {
      await unlink(this.lockOwnerPath);
      ownerRemoved = true;
      await rmdir(this.lockDirectory);
      await syncDirectory(this.directory);
      this.lockHeld = false;
    } catch (error) {
      if (ownerRemoved) {
        // Once owner.json is gone this process can no longer prove exclusive
        // ownership on a retry. Preserve the dirty-release failure so close()
        // cannot later report success while a partial lock directory remains
        // or its removal was not durably confirmed.
        this.lockHeld = false;
        this.lockCleanupFailure = new TaskStoreCorruptionError(
          "Task store writer lock was only partially released; inspect the lock directory before restarting.",
          { cause: error },
        );
        throw this.lockCleanupFailure;
      }
      throw error;
    }
  }
}

/**
 * Clears a lock left behind by an unclean exit. This is intentionally explicit:
 * automatic stale-lock reclamation can let two processes become writers during
 * an event-loop stall. A same-host live PID is always refused.
 */
export async function clearAbandonedTaskStoreLock(
  options: Pick<FileTaskStoreOptions, "directory" | "filename">,
): Promise<ClearAbandonedTaskStoreLockResult> {
  const { directory, filePath } = resolveStorePaths(options);
  const lockDirectory = `${filePath}.lock`;
  const lockOwnerPath = join(lockDirectory, LOCK_OWNER_FILENAME);
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { cleared: false };
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new TaskStoreCorruptionError("Task store directory is not a regular directory.");
  }
  if (
    process.platform !== "win32"
    && typeof process.getuid === "function"
    && directoryStat.uid !== process.getuid()
  ) {
    throw new TaskStoreCorruptionError("Task store directory must be owned by the gateway process user.");
  }
  let lockStat;
  try {
    lockStat = await lstat(lockDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { cleared: false };
    throw error;
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new TaskStoreCorruptionError("Task store lock path is not a regular directory.");
  }

  let owner: TaskStoreLockOwner | undefined;
  let ownerMetadataValid = true;
  try {
    owner = await readLockOwner(lockOwnerPath, { allowMissing: true });
  } catch (error) {
    if (!(error instanceof TaskStoreCorruptionError)) throw error;
    // A process can die between creating and fsyncing owner.json. The explicit
    // confirmation is the authority to remove that partial metadata; the lock
    // directory still excludes a new writer throughout cleanup.
    ownerMetadataValid = false;
  }
  if (owner?.hostname === hostname() && isProcessAlive(owner.pid)) {
    throw new TaskStoreLockedError(
      `Refusing to clear task state owned by live gateway PID ${owner.pid} on ${owner.hostname}.`,
    );
  }

  await unlink(lockOwnerPath).catch((error) => {
    if (!isNodeError(error, "ENOENT")) throw error;
  });
  try {
    await rmdir(lockDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOTEMPTY") || isNodeError(error, "EEXIST")) {
      throw new TaskStoreCorruptionError(
        `Task store lock contains unexpected files; refusing to remove it: ${lockDirectory}`,
        { cause: error },
      );
    }
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  await syncDirectory(directory);
  return {
    cleared: true,
    ...(owner ? { ownerPid: owner.pid, ownerHostname: owner.hostname } : {}),
    ...(!ownerMetadataValid ? { ownerMetadataValid: false } : {}),
  };
}

function cloneTask(record: TaskRecord | undefined): TaskRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function buildTaskStoreDocument(records: Map<string, TaskRecord>, updatedAt: number): TaskStoreDocument {
  return {
    schemaVersion: TASK_RECORD_SCHEMA_VERSION,
    updatedAt,
    tasks: [...records.values()]
      .map((task) => parseTaskRecord(task))
      .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)),
  };
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

function comparePrunableRecords(left: TaskRecord, right: TaskRecord): number {
  // Preserve unread inbox items ahead of acknowledged history whenever a hard
  // capacity bound forces early eviction. Retention age remains authoritative.
  const unreadOrder = Number(left.notification.unread) - Number(right.notification.unread);
  return unreadOrder || left.updatedAt - right.updatedAt || left.taskId.localeCompare(right.taskId);
}

function capacityReserveBytes(
  records: ReadonlyMap<string, TaskRecord>,
  maximumConcurrentSlots: number,
  reserveQueuedCapacity: boolean,
  reserveControlCapacity: boolean,
): number {
  const maximum = boundedPositiveInteger(
    maximumConcurrentSlots,
    "maximum concurrent terminal reserve slots",
    MAX_CONFIGURED_TERMINAL_RESERVE_SLOTS,
  );
  let active = 0;
  let queued = 0;
  for (const record of records.values()) {
    if (
      isTaskTerminal(record.status)
      || record.upstreamRunMissingAt !== undefined
      || record.operatorContainedAt !== undefined
    ) continue;
    if (record.status === "queued") queued += 1;
    else active += 1;
  }
  // A terminal transition consumes the slot previously held for that active
  // task. Queued tasks reclaim available slots only on writes that can admit
  // work; that write happens before Hermes receives the POST and may prune
  // operationally closed history or fail safely.
  const slots = reserveQueuedCapacity
    ? Math.max(active, Math.min(maximum, active + queued))
    : active;
  const perSlotReserve = reserveControlCapacity
    ? TERMINAL_TRANSITION_RESERVE_BYTES
    : TERMINAL_TRANSITION_RESERVE_BYTES - CONTROL_TRANSITION_ALLOWANCE_BYTES_PER_SLOT;
  return (reserveControlCapacity ? CONTROL_TRANSITION_RESERVE_BYTES : 0)
    + slots * perSlotReserve;
}

function isTaskOperationallyClosedForCapacity(record: TaskRecord): boolean {
  return isTaskTerminal(record.status)
    || record.upstreamRunMissingAt !== undefined
    || record.operatorContainedAt !== undefined;
}

function cloneTaskMap(records: ReadonlyMap<string, TaskRecord>): Map<string, TaskRecord> {
  return new Map([...records].map(([taskId, record]) => [taskId, cloneTask(record)!]));
}

function resolveStorePaths(
  options: Pick<FileTaskStoreOptions, "directory" | "filename">,
): { directory: string; filePath: string } {
  if (!isAbsolute(options.directory) || options.directory.includes("\0")) {
    throw new Error("Task store directory must be an absolute safe path.");
  }
  const filename = options.filename ?? DEFAULT_FILENAME;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(filename)) {
    throw new Error("Task store filename must be a simple .json filename.");
  }
  return { directory: options.directory, filePath: join(options.directory, filename) };
}

async function readLockOwner(
  ownerPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<TaskStoreLockOwner | undefined> {
  let handle;
  try {
    handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (options.allowMissing && isNodeError(error, "ENOENT")) return undefined;
    if (isNodeError(error, "ELOOP")) {
      throw new TaskStoreCorruptionError("Task store lock owner must not be a symbolic link.", { cause: error });
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TaskStoreCorruptionError("Task store lock owner is not a regular file.");
    if (stat.size > MAX_LOCK_OWNER_BYTES) {
      throw new TaskStoreCorruptionError("Task store lock owner exceeds its safety limit.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      throw new TaskStoreCorruptionError("Task store lock owner contains invalid JSON.", { cause: error });
    }
    const owner = TaskStoreLockOwnerSchema.safeParse(parsed);
    if (!owner.success) {
      throw new TaskStoreCorruptionError(
        `Task store lock owner failed validation: ${owner.error.issues[0]?.message ?? "invalid document"}`,
      );
    }
    return owner.data;
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    return true;
  }
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

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
  const parsed = positiveInteger(value, label);
  if (parsed > maximum) throw new Error(`${label} must be at most ${maximum}.`);
  return parsed;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
