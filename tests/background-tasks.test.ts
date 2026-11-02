import { describe, expect, it, vi } from "vitest";
import { BackgroundTasks, type TaskInfo } from "../src/tasks/index.js";
import { createBackgroundTaskTool } from "../src/tools/backgroundTask.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const resultText = (result: { content: ({ type: string; text?: string })[] }) => JSON.parse(result.content[0]?.text ?? "");

function setup(limit?: number) {
  const runs = new Map<string, { task: TaskInfo & { prompt: string }; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }>();
  const deliver = vi.fn(async (_origin: string, _text: string) => {});
  const onError = vi.fn();
  const tasks = new BackgroundTasks({
    run: (task, signal) => {
      const result = deferred<string>();
      signal.addEventListener("abort", () => result.reject(new Error("aborted")), { once: true });
      runs.set(task.id, { task, signal, result });
      return result.promise;
    },
    deliver, onError, now: () => 1000, ...(limit ? { limit } : {}),
  });
  return { tasks, runs, deliver, onError };
}

describe("BackgroundTasks", () => {
  it("returns at once and delivers the reply to the starting conversation", async () => {
    const { tasks, runs, deliver } = setup();
    const info = tasks.start({ origin: "wechat", title: "Research", prompt: "find things" });
    expect(info).toMatchObject({ title: "Research", origin: "wechat", startedAt: 1000 });
    expect(tasks.list()).toEqual([info]);
    expect(runs.get(info.id)!.task.prompt).toBe("find things");
    runs.get(info.id)!.result.resolve("found three things");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith("wechat", "[Background task \"Research\" finished]\nfound three things"));
    expect(tasks.list()).toEqual([]);
  });

  it("delivers a failure with its reason", async () => {
    const { tasks, runs, deliver, onError } = setup();
    const info = tasks.start({ origin: "web:a", title: "Build", prompt: "build" });
    runs.get(info.id)!.result.reject(new Error("model unavailable"));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith("web:a", "[Background task \"Build\" failed] model unavailable"));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not deliver a task the owner stopped", async () => {
    const { tasks, runs, deliver } = setup();
    const info = tasks.start({ origin: "wechat", title: "Long", prompt: "wait" });
    expect(tasks.stop(info.id)).toBe(true);
    expect(runs.get(info.id)!.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(tasks.list()).toEqual([]));
    expect(deliver).not.toHaveBeenCalled();
    expect(tasks.stop(info.id)).toBe(false);
  });

  it("refuses a task beyond the limit", () => {
    const { tasks } = setup(1);
    tasks.start({ origin: "wechat", title: "One", prompt: "one" });
    expect(() => tasks.start({ origin: "wechat", title: "Two", prompt: "two" })).toThrow("1 background tasks are already running");
  });

  it("aborts running tasks on close without delivering them and refuses new ones", async () => {
    const { tasks, runs, deliver } = setup();
    const info = tasks.start({ origin: "wechat", title: "Long", prompt: "wait" });
    await tasks.close();
    expect(runs.get(info.id)!.signal.aborted).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(() => tasks.start({ origin: "wechat", title: "Late", prompt: "late" })).toThrow("shutting down");
  });
});

describe("background_task tool", () => {
  it("starts in its own conversation, lists and stops tasks", async () => {
    const { tasks } = setup();
    const tool = createBackgroundTaskTool(tasks, "web:a");
    const started = resultText(await tool.execute("1", { action: "start", title: "Research", task: "find things" }));
    expect(started).toMatchObject({ title: "Research", origin: "web:a" });
    const listed = resultText(await tool.execute("2", { action: "list" }));
    expect(listed).toEqual([expect.objectContaining({ id: started.id })]);
    const stopped = resultText(await tool.execute("3", { action: "stop", id: started.id }));
    expect(stopped).toEqual({ stopped: true });
  });

  it("requires a title and task to start and an id to stop", async () => {
    const { tasks } = setup();
    const tool = createBackgroundTaskTool(tasks, "wechat");
    await expect(tool.execute("1", { action: "start", title: "Only title" })).rejects.toThrow("title and task");
    await expect(tool.execute("2", { action: "stop" })).rejects.toThrow("id");
  });
});
