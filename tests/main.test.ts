import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

test("web list flushes JSON larger than a pipe buffer", async () => {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "main-test-"));
  const captures = Array.from({ length: 1_000 }, (_, id) => ({
    id,
    url: `https://example.com/${id}`,
    title: "x".repeat(100),
  }));
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ captures }),
  });

  try {
    const child = Bun.spawn([
      process.execPath,
      "src/main.ts",
      "web",
      "list",
      "--endpoint",
      server.url.toString(),
      "--token",
      "a".repeat(43),
      "--config",
      join(dir, "config.toml"),
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.length).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(stdout)).toEqual({ captures });
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
