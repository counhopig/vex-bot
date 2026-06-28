import { Todo } from "../models.js";
import type { UserData } from "../storage.js";

/** Add a todo dict to data */
export function todosAdd(data: UserData, todoDict: Record<string, unknown>): void {
  const todos = data.todos ?? [];
  todos.push(todoDict);
  data.todos = todos;
}

/** Remove a todo by id. Returns true if found and removed. */
export function todosRemove(data: UserData, todoId: string): boolean {
  const todos = data.todos ?? [];
  const before = todos.length;
  const filtered = todos.filter((t) => (t.id as string | undefined) !== todoId);
  data.todos = filtered;
  return filtered.length < before;
}

/** Mark a todo as done by id. Returns true if found. */
export function todosComplete(data: UserData, todoId: string): boolean {
  const todos = data.todos ?? [];
  for (const t of todos) {
    if ((t.id as string | undefined) === todoId) {
      t.done = true;
      return true;
    }
  }
  return false;
}

/** Get todos filtered by type(s). Returns all if no types specified. */
export function todosGetByType(data: UserData, ...types: string[]): Todo[] {
  const todosData = data.todos ?? [];
  const all = todosData.map((t) => Todo.fromDict(t));
  if (types.length === 0) {
    return all;
  }
  return all.filter((t) => types.includes(t.todoType));
}

/** Get active todos and completed history */
export function todosGetTodolist(data: UserData): { todos: Todo[]; history: Todo[] } {
  const all = todosGetByType(data);
  return {
    todos: all.filter((t) => !t.done),
    history: all.filter((t) => t.done),
  };
}
