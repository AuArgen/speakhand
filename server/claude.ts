// Компьютерде орнотулган Claude Code CLI'ни (`claude -p`) чакыруу — API ачкыч керек эмес,
// колдонуучунун өз аккаунту колдонулат.
import { spawn } from "node:child_process";

export type ClaudeModel = "haiku" | "sonnet" | "opus";
export const CLAUDE_MODELS: ClaudeModel[] = ["sonnet", "haiku", "opus"];

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

interface CliResult {
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  modelUsage?: Record<string, unknown>;
}

export interface ClaudeJsonResponse<T> {
  data: T;
  model: string;
  ms: number;
}

/** Бир жолку суроо: system prompt + колдонуучунун тексти → JSON Schema'га ылайык объект. */
export function askClaudeJson<T>(opts: {
  system: string;
  input: string;
  schema: object;
  model: ClaudeModel;
  timeoutMs?: number;
}): Promise<ClaudeJsonResponse<T>> {
  const started = Date.now();
  const args = [
    "-p",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--tools", "",
    "--model", opts.model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.schema),
    "--system-prompt", opts.system,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI ${opts.timeoutMs ?? 60000} мс ичинде жооп берген жок`));
    }, opts.timeoutMs ?? 60000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI табылган жок (${e.message}). Claude Code орнотулганын текшериңиз.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude CLI ката (код ${code}): ${(err || out).slice(0, 400)}`));
      try {
        const res = JSON.parse(out) as CliResult;
        if (res.is_error) return reject(new Error(`claude: ${res.result ?? "белгисиз ката"}`));
        const data = (res.structured_output ?? JSON.parse(res.result ?? "null")) as T;
        // CLI ичинде кошумча кичине чакыруулар болот — эң көп токен чыгарган моделди алабыз.
        const usage = Object.entries((res.modelUsage ?? {}) as Record<string, { outputTokens?: number }>);
        usage.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0));
        const model = usage[0]?.[0] ?? opts.model;
        resolve({ data, model, ms: Date.now() - started });
      } catch (e) {
        reject(new Error(`claude CLI жообун окуй алган жокпуз: ${(e as Error).message}`));
      }
    });
    child.stdin.end(opts.input);
  });
}

/** CLI бар-жогун текшерет (сервер ишке киргенде бир жолу). */
export function checkClaudeCli(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["--version"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}
