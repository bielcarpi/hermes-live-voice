import { basename, dirname } from "node:path";
import {
  FileTaskStore,
  TaskStoreLockedError,
  clearAbandonedTaskStoreLock,
} from "../adapters/outbound/task-store/file-task-store.js";
import type { AppConfig } from "../config.js";
import {
  TaskIdSchema,
  containIndeterminateTask,
  type TaskRecord,
} from "../domain/tasks/index.js";

export async function runOfflineTaskCommand(
  args: readonly string[],
  config: AppConfig,
  write: (value: string) => void = console.log,
): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    write(taskCommandHelp());
    return;
  }

  const storeOptions = {
    directory: dirname(config.tasks.stateFile),
    filename: basename(config.tasks.stateFile),
  };
  if (command === "unlock") {
    if (args.length !== 2 || args[1] !== "--confirm-no-gateway") {
      throw new Error(
        "Usage: hermes-live tasks unlock --confirm-no-gateway. " +
        "Use this only after confirming no Hermes Live gateway uses this state file.",
      );
    }
    try {
      const result = await clearAbandonedTaskStoreLock(storeOptions);
      write(JSON.stringify({ object: "hermes_live.task_store_unlock", ...result }, null, 2));
      return;
    } catch (error) {
      if (error instanceof TaskStoreLockedError) {
        throw new Error(error.message, { cause: error });
      }
      throw error;
    }
  }

  const store = new FileTaskStore({
    ...storeOptions,
    // Offline inspection and containment must preserve the document exactly as
    // it was left. Gateway retention settings may have changed since that
    // document was written and must not turn a read command into maintenance.
    maxRecords: Number.MAX_SAFE_INTEGER,
    automaticPruning: false,
  });
  let commandFailed = false;
  let commandFailure: unknown;
  try {
    if (command === "unresolved") {
      if (args.length !== 1) throw new Error("Usage: hermes-live tasks unresolved");
      const tasks = (await store.list()).filter(isOperationallyUnresolved).map(operatorTaskSummary);
      write(JSON.stringify({ object: "hermes_live.unresolved_tasks", tasks }, null, 2));
      return;
    }

    if (command === "contain") {
      if (args.length !== 3 || args[2] !== "--confirm-contained") {
        throw new Error(
          "Usage: hermes-live tasks contain <taskId> --confirm-contained. " +
          "Use this only after auditing or stopping any Hermes work that may still be running.",
        );
      }
      const taskId = TaskIdSchema.parse(args[1]);
      const current = await store.load(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      if (!isOperationallyUnresolved(current)) {
        throw new Error(`Task is not an unresolved unknown outcome: ${taskId}`);
      }
      const contained = await store.update(
        taskId,
        (record) => containIndeterminateTask(record),
        { expectedRevision: current.revision },
      );
      write(JSON.stringify({
        object: "hermes_live.task_containment",
        task: operatorTaskSummary(contained),
        contained: true,
        containedAt: contained.operatorContainedAt,
      }, null, 2));
      return;
    }

    throw new Error(`Unknown tasks command: ${command}\n${taskCommandHelp()}`);
  } catch (error) {
    commandFailed = true;
    commandFailure = error instanceof TaskStoreLockedError
      ? new Error(
        "The task state is in use. Stop the running Hermes Live gateway before using offline task recovery.",
        { cause: error },
      )
      : error;
    throw commandFailure;
  } finally {
    try {
      await store.close();
    } catch (cleanupError) {
      if (commandFailed) {
        throw new AggregateError(
          [commandFailure, cleanupError],
          "The offline task command failed and task-state cleanup also failed.",
        );
      }
      throw cleanupError;
    }
  }
}

export function taskCommandHelp(): string {
  return [
    "Offline task recovery:",
    "  hermes-live tasks unresolved",
    "  hermes-live tasks contain <taskId> --confirm-contained",
    "  hermes-live tasks unlock --confirm-no-gateway",
    "",
    "Stop Hermes Live first. Contain a task only after you have audited or stopped",
    "any Hermes work that may still be running. Containment preserves the unknown",
    "outcome and adds an audit event; it never retries the task. Unlock only",
    "clears a crash-left lock and refuses to clear a live same-host process.",
  ].join("\n");
}

function isOperationallyUnresolved(record: TaskRecord): boolean {
  return (record.status === "unknown" || record.status === "dispatch_unknown")
    && record.upstreamRunMissingAt === undefined
    && record.operatorContainedAt === undefined;
}

function operatorTaskSummary(record: TaskRecord): Record<string, unknown> {
  return {
    taskId: record.taskId,
    status: record.status === "dispatch_unknown" ? "unknown" : record.status,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.runId ? { runId: record.runId } : {}),
  };
}
