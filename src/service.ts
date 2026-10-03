import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "./config.ts";

export function systemdUnitPath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "systemd", "user", "nwp.service");
}

export function createSystemdUnit(config: Config, command = currentCommand()): string {
  const executable = command.map(systemdQuote).join(" ");
  const args = ["serve", "--with-worker", "--config", config.configPath, "--data-dir", config.dataDir].map(systemdQuote).join(" ");
  return `[Unit]
Description=nwp local Markdown wiki
After=network.target

[Service]
Type=simple
ExecStart=${executable} ${args}
Restart=on-failure
RestartSec=3
Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${systemdQuote(config.dataDir)}

[Install]
WantedBy=default.target
`;
}

export async function installSystemdService(config: Config): Promise<{ path: string; enabled: boolean }> {
  const path = systemdUnitPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, createSystemdUnit(config), { mode: 0o644 });
  await chmod(path, 0o644);
  await systemctl(["daemon-reload"]);
  await systemctl(["enable", "--now", "nwp.service"]);
  return { path, enabled: true };
}

export async function uninstallSystemdService(): Promise<{ path: string; removed: boolean }> {
  const path = systemdUnitPath();
  await systemctl(["disable", "--now", "nwp.service"], true);
  await rm(path, { force: true });
  await systemctl(["daemon-reload"]);
  return { path, removed: true };
}

export async function systemdServiceStatus(): Promise<number> {
  const child = Bun.spawn(["systemctl", "--user", "status", "nwp.service", "--no-pager"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

function currentCommand(): string[] {
  if (basename(process.execPath).startsWith("bun") && process.argv[1]) return [process.execPath, resolve(process.argv[1])];
  return [resolve(process.execPath)];
}

function systemdQuote(value: string): string {
  if (/[\x00\r\n]/.test(value)) throw new Error("systemd arguments must not contain control characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function systemctl(args: string[], tolerateFailure = false): Promise<void> {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && !tolerateFailure) throw new Error(`systemctl --user ${args.join(" ")} failed: ${(stderr || stdout).trim()}`);
}
