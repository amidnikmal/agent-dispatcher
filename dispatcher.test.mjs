import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawnP, runAgent, AGENTS, paramsSchema, buildToolDescription } from "./dispatcher.mjs";

function makeFakeSpawn(stdoutData, stderrData, exitCode) {
  return async (_bin, _args, _opts) => {
    if (exitCode !== 0) {
      const err = new Error(`exit code ${exitCode}`);
      err.stdout = stdoutData;
      err.stderr = stderrData;
      throw err;
    }
    return { stdout: stdoutData, stderr: stderrData };
  };
}

function makeErrorSpawn(message) {
  return async () => {
    throw Object.assign(new Error(message), { stdout: "", stderr: "" });
  };
}

function makeTimeoutSpawn(stdoutData) {
  return async () => {
    const err = new Error("killed");
    err.killed = true;
    err.signal = "SIGTERM";
    err.stdout = stdoutData;
    err.stderr = "";
    throw err;
  };
}

describe("spawnP integration (real)", () => {
  it("rejects with ENOENT for nonexistent binary", async (t) => {
    await assert.rejects(
      () => spawnP("nonexistent-binary-12345", [], {}),
      (err) => err.code === "ENOENT"
    );
  });

  it("resolves with stdout for echo", async (t) => {
    const { stdout } = await spawnP("echo", ["hello-world-test"], {});
    assert.match(stdout, /hello-world-test/);
  });
});

describe("runAgent", () => {
  it("throws on unknown agent key", async (t) => {
    await assert.rejects(
      () => runAgent("nonexistent", "test"),
      /Unknown agent: nonexistent/
    );
  });

  it("returns stdout on success (exit 0)", async (t) => {
    const fake = makeFakeSpawn("function add(a,b) { return a+b; }", "", 0);
    const result = await runAgent("kilo", "write an add function", undefined, fake);
    assert.ok(result.includes("function add(a,b)"));
    assert.ok(!result.includes("[stderr]"));
    assert.ok(!result.includes("[ERROR]"));
  });

  it("appends stderr on success when present", async (t) => {
    const fake = makeFakeSpawn("output", "deprecation warning", 0);
    const result = await runAgent("codex", "do something", undefined, fake);
    assert.match(result, /output/);
    assert.match(result, /\[stderr\]/);
    assert.match(result, /deprecation warning/);
  });

  it('shows "(no output)" when stdout is empty', async (t) => {
    const fake = makeFakeSpawn("", "", 0);
    const result = await runAgent("kilo", "test", undefined, fake);
    assert.strictEqual(result, "(no output)");
  });

  it("returns [ERROR] format on non-zero exit", async (t) => {
    const fake = makeFakeSpawn("partial output", "fatal: something", 1);
    const result = await runAgent("kilo", "test", undefined, fake);
    assert.match(result, /\[ERROR\] Kilo: exit code 1/);
    assert.match(result, /\[stdout\]/);
    assert.match(result, /partial output/);
    assert.match(result, /\[stderr\]/);
    assert.match(result, /fatal: something/);
  });

  it("returns [TIMEOUT] when killed by SIGTERM", async (t) => {
    const fake = makeTimeoutSpawn("started...");
    const result = await runAgent("codex", "long task", undefined, fake);
    assert.match(result, /\[TIMEOUT\] Codex took longer than 5 minutes\./);
  });

  it("uses agent label in error messages, not bin name", async (t) => {
    const fake = makeFakeSpawn("", "broken", 2);
    const result = await runAgent("claude", "test", undefined, fake);
    assert.match(result, /\[ERROR\] Claude Code:/);
    assert.ok(!result.includes("[ERROR] claude:"));
  });

  it("passes cwd and timeout to _spawn", async (t) => {
    let captured = null;
    const fake = async (_bin, _args, opts) => {
      captured = opts;
      return { stdout: "ok", stderr: "" };
    };
    await runAgent("kilo", "test", "/custom/cwd", fake);
    assert.strictEqual(captured.cwd, "/custom/cwd");
    assert.strictEqual(captured.timeout, 300_000);
  });

  it("defaults cwd to process.cwd() when not provided", async (t) => {
    let captured = null;
    const fake = async (_bin, _args, opts) => {
      captured = opts;
      return { stdout: "ok", stderr: "" };
    };
    await runAgent("kilo", "test", undefined, fake);
    assert.strictEqual(captured.cwd, process.cwd());
  });
});

describe("AGENTS registry", () => {
  it("has exactly kilo, codex, claude", () => {
    const keys = Object.keys(AGENTS).sort();
    assert.deepStrictEqual(keys, ["claude", "codex", "kilo"]);
  });

  it("each agent has label, bin, args function", () => {
    for (const [key, agent] of Object.entries(AGENTS)) {
      assert.strictEqual(typeof agent.label, "string", `${key}: label`);
      assert.strictEqual(typeof agent.bin, "string", `${key}: bin`);
      assert.strictEqual(typeof agent.args, "function", `${key}: args`);
      const argv = agent.args("test prompt");
      assert.ok(Array.isArray(argv), `${key}: args returns array`);
      assert.ok(argv.length >= 2, `${key}: at least 2 args`);
      assert.ok(argv.includes("test prompt"), `${key}: prompt passed`);
    }
  });

  it("kilo uses `run` subcommand", () => {
    assert.deepStrictEqual(AGENTS.kilo.args("hello"), ["run", "hello"]);
  });

  it("codex uses `exec` subcommand with --skip-git-repo-check", () => {
    const args = AGENTS.codex.args("hello");
    assert.strictEqual(args[0], "exec");
    assert.ok(args.includes("--skip-git-repo-check"));
  });

  it("claude uses -p with --dangerously-skip-permissions", () => {
    const args = AGENTS.claude.args("hello");
    assert.strictEqual(args[0], "-p");
    assert.ok(args.includes("--dangerously-skip-permissions"));
  });
});

describe("buildToolDescription", () => {
  it("includes label and bin in description", () => {
    const desc = buildToolDescription("MyLabel", "mybin");
    assert.match(desc, /MyLabel/);
    assert.match(desc, /mybin/);
  });
});

describe("paramsSchema", () => {
  it("has prompt and cwd keys", () => {
    const keys = Object.keys(paramsSchema);
    assert.ok(keys.includes("prompt"));
    assert.ok(keys.includes("cwd"));
  });
});

describe("MCP protocol (integration)", () => {
  it("tools/list returns 3 tools via stdio", async (t) => {
    const { spawn } = await import("child_process");
    const child = spawn("node", ["dispatcher.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }) + "\n";

    child.stdin.write(request);
    child.stdin.end();

    let output = "";
    for await (const chunk of child.stdout) {
      output += chunk;
    }

    child.kill();

    const response = JSON.parse(output.trim().split("\n").pop());
    assert.strictEqual(response.jsonrpc, "2.0");
    assert.strictEqual(response.id, 1);
    assert.ok(Array.isArray(response.result.tools));
    assert.strictEqual(response.result.tools.length, 3);
    const names = response.result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      "delegate_claude",
      "delegate_codex",
      "delegate_kilo",
    ]);
  });
});
