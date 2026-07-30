import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { publish } from "../events.ts";
import type { TodoItem } from "@piclaw-cloud/store";

export type TodoAction = "list" | "add" | "toggle" | "clear";

export interface TodoToolArgs {
  action: TodoAction;
  text?: string;
  id?: number;
}

function todosToMarkdown(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos yet.";
  const done = todos.filter((todo) => todo.done).length;
  const lines = [`## Tasks (${done}/${todos.length} completed)`, ""];
  for (const todo of todos) {
    lines.push(`${todo.done ? "- [x]" : "- [ ]"} ${todo.text} (id: ${todo.id})`);
  }
  return lines.join("\n");
}

export async function runTodoTool(
  sessionId: string,
  args: TodoToolArgs,
): Promise<{ output: string; isError: boolean }> {
  const action = String(args.action ?? "") as TodoAction;
  const state = await store.getSessionTodos(sessionId);

  switch (action) {
    case "list": {
      const markdown = todosToMarkdown(state.todos);
      await publishTodoUpdate(sessionId, markdown);
      return { output: markdown, isError: false };
    }
    case "add": {
      const text = String(args.text ?? "").trim();
      if (!text) return { output: "text is required for add", isError: true };
      const todo: TodoItem = { id: state.nextId, text, done: false };
      state.todos.push(todo);
      state.nextId += 1;
      await store.setSessionTodos(sessionId, state);
      const markdown = todosToMarkdown(state.todos);
      await publishTodoUpdate(sessionId, markdown);
      return { output: `Added todo #${todo.id}: ${text}`, isError: false };
    }
    case "toggle": {
      const id = Number(args.id);
      if (!Number.isFinite(id)) return { output: "id is required for toggle", isError: true };
      const todo = state.todos.find((item) => item.id === id);
      if (!todo) return { output: `todo #${id} not found`, isError: true };
      todo.done = !todo.done;
      await store.setSessionTodos(sessionId, state);
      const markdown = todosToMarkdown(state.todos);
      await publishTodoUpdate(sessionId, markdown);
      return { output: `Toggled todo #${id} → ${todo.done ? "done" : "open"}`, isError: false };
    }
    case "clear": {
      state.todos = [];
      await store.setSessionTodos(sessionId, state);
      const markdown = todosToMarkdown(state.todos);
      await publishTodoUpdate(sessionId, markdown);
      return { output: "Cleared all todos.", isError: false };
    }
    default:
      return { output: `Unknown todo action: ${action}`, isError: true };
  }
}

async function publishTodoUpdate(sessionId: string, markdown: string): Promise<void> {
  await publish(sessionId, {
    type: "todo_update",
    markdown,
    replica: config.replicaId,
  });
}

export function todosMarkdownFromState(todos: TodoItem[]): string {
  return todosToMarkdown(todos);
}
