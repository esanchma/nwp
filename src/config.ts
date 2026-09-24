import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  configPath: string;
  attachmentMaxBytes: number | null;
}

export interface ConfigOverrides {
  host?: string;
  port?: number;
  dataDir?: string;
  configPath?: string;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function defaultConfigPath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "nwp", "config.toml");
}

function defaultDataDir(): string {
  const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(root, "nwp");
}

export async function loadConfig(overrides: ConfigOverrides = {}): Promise<Config> {
  const configPath = expandHome(overrides.configPath || defaultConfigPath());
  let file: Record<string, unknown> = {};

  try {
    file = Bun.TOML.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const host = overrides.host ?? stringValue(file.host, "host", "127.0.0.1");
  const port = overrides.port ?? numberValue(file.port, "port", 3000);
  const dataDir = expandHome(overrides.dataDir ?? stringValue(file.data_dir, "data_dir", defaultDataDir()));
  const configuredMax = numberValue(file.max_attachment_bytes, "max_attachment_bytes", 0);
  const attachmentMaxBytes = configuredMax === 0 ? null : configuredMax;

  if (attachmentMaxBytes !== null && (!Number.isSafeInteger(attachmentMaxBytes) || attachmentMaxBytes < 1)) {
    throw new Error("max_attachment_bytes must be zero (unlimited) or a positive integer");
  }
  if (port < 1 || port > 65535 || !Number.isInteger(port)) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  return {
    host,
    port,
    dataDir,
    dbPath: join(dataDir, "nwp.db"),
    tokenPath: join(dataDir, "api-token"),
    configPath,
    attachmentMaxBytes,
  };
}

function stringValue(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function numberValue(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new Error(`${name} must be a number`);
  return value;
}

export async function ensureRuntimeFiles(config: Config): Promise<string> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(config.configPath), { recursive: true, mode: 0o700 });

  try {
    const token = (await readFile(config.tokenPath, "utf8")).trim();
    if (token.length < 32) throw new Error(`API token in ${config.tokenPath} is invalid`);
    await chmod(config.tokenPath, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await writeFile(config.tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  await chmod(config.tokenPath, 0o600);
  return token;
}

export async function readApiToken(config: Config): Promise<string> {
  const token = (await readFile(config.tokenPath, "utf8")).trim();
  if (!token) throw new Error(`No API token found at ${config.tokenPath}. Start nwp serve first.`);
  return token;
}
