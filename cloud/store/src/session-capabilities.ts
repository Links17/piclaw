import { counted, sql, type RoundtripCounter } from "./db.ts";

export type SessionMode = "plan" | "execute";

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export interface TodoState {
  todos: TodoItem[];
  nextId: number;
}

function defaultTodoState(): TodoState {
  return { todos: [], nextId: 1 };
}

function parseTodoState(value: unknown): TodoState {
  if (!value || typeof value !== "object") return defaultTodoState();
  const raw = value as { todos?: unknown; nextId?: unknown };
  const todos = Array.isArray(raw.todos)
    ? raw.todos.map((item, index) => {
        const row = item as { id?: unknown; text?: unknown; done?: unknown };
        return {
          id: Number(row.id ?? index + 1),
          text: String(row.text ?? ""),
          done: Boolean(row.done),
        };
      })
    : [];
  const nextId = Number.isFinite(Number(raw.nextId)) ? Number(raw.nextId) : todos.length + 1;
  return { todos, nextId };
}

export async function getSessionMode(sessionId: string): Promise<SessionMode> {
  const rows = await sql`SELECT mode FROM sessions WHERE id = ${sessionId}`;
  const mode = String(rows[0]?.mode ?? "execute");
  return mode === "plan" ? "plan" : "execute";
}

export async function setSessionMode(sessionId: string, mode: SessionMode): Promise<void> {
  await sql`UPDATE sessions SET mode = ${mode}, updated_at = now() WHERE id = ${sessionId}`;
}

export async function getSessionPlanText(sessionId: string): Promise<string> {
  const rows = await sql`SELECT plan_text FROM sessions WHERE id = ${sessionId}`;
  return String(rows[0]?.plan_text ?? "");
}

export async function setSessionPlanText(sessionId: string, planText: string): Promise<void> {
  await sql`UPDATE sessions SET plan_text = ${planText}, updated_at = now() WHERE id = ${sessionId}`;
}

export async function getSessionTodos(sessionId: string, counter?: RoundtripCounter): Promise<TodoState> {
  const rows = await counted(counter)`SELECT todos FROM sessions WHERE id = ${sessionId}`;
  return parseTodoState(rows[0]?.todos);
}

export async function setSessionTodos(
  sessionId: string,
  state: TodoState,
  counter?: RoundtripCounter,
): Promise<void> {
  await counted(counter)`
    UPDATE sessions SET todos = ${JSON.stringify(state)}::jsonb, updated_at = now()
    WHERE id = ${sessionId}`;
}
