import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { z } from "zod";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

export function spawnP(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`exit code ${code}`);
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      }
    });
    child.on("error", reject);
  });
}

export const paramsSchema = {
  prompt: z.string().describe("The task for the agent to execute, e.g. 'write unit tests for src/auth.ts'"),
  cwd: z.string().optional().describe("Working directory for the agent. Pass the absolute path."),
};

export const AGENTS = {
  kilo: {
    label: "Kilo",
    bin: "kilocode",
    args: (prompt) => ["run", prompt],
  },
  codex: {
    label: "Codex",
    bin: "codex",
    args: (prompt) => ["exec", prompt, "--skip-git-repo-check"],
  },
  claude: {
    label: "Claude Code",
    bin: "claude",
    args: (prompt) => ["-p", prompt, "--dangerously-skip-permissions"],
  },
};

export function buildToolDescription(label, bin) {
  return `Delegate a task to ${label} (${bin}). Returns the agent's output. Use this for code generation, testing, refactoring, or review.`;
}

export async function runAgent(agentKey, prompt, cwd, _spawn = spawnP) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  try {
    const { stdout, stderr } = await _spawn(agent.bin, agent.args(prompt), {
      cwd: cwd || process.cwd(),
      timeout: 300_000,
    });

    const output = stdout || "(no output)";
    const errOut = stderr ? `\n[stderr]\n${stderr}` : "";
    return output + errOut;
  } catch (err) {
    if (err.killed && err.signal === "SIGTERM") {
      return `[TIMEOUT] ${agent.label} took longer than 5 minutes.`;
    }
    const parts = [`[ERROR] ${agent.label}: ${err.message}`];
    if (err.stdout) parts.push(`[stdout]\n${err.stdout}`);
    if (err.stderr) parts.push(`[stderr]\n${err.stderr}`);
    return parts.join("\n");
  }
}

const server = new McpServer({
  name: "agent-dispatcher",
  version: "1.0.0",
});

for (const [key, agent] of Object.entries(AGENTS)) {
  server.tool(
    `delegate_${key}`,
    buildToolDescription(agent.label, agent.bin),
    paramsSchema,
    async ({ prompt, cwd }) => {
      const result = await runAgent(key, prompt, cwd);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );
}

if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
