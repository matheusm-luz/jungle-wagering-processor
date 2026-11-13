import type { Subprocess } from 'bun';

export interface AppProcesses {
  /** Base URL of each process, in spawn order. */
  readonly urls: readonly string[];
  /** Operating-system pid of each process, in the same order. */
  readonly pids: readonly number[];
  /** Sends `SIGTERM` to every process and waits for all of them to exit. */
  stop(): Promise<void>;
}

const READY_TIMEOUT_MS = 20_000;

/**
 * Spawns `count` real application processes (`bun src/main.ts`, as in production) against the
 * suite's PostgreSQL and LocalStack, and waits until each one answers `/health/ready` (ADR-09).
 * Separate processes share nothing but the database and the broker, which is what the
 * multi-instance requirements are about; Nest applications inside one process would share a heap.
 */
export async function startProcesses(
  count: number,
  env: Readonly<Record<string, string>> = {},
): Promise<AppProcesses> {
  const ports = Array.from({ length: count }, freePort);
  // A released probe port can be handed out again; two processes on one port would pass as two.
  if (new Set(ports).size !== count) throw new Error(`duplicate port among ${ports.join(', ')}`);
  const spawned = ports.map((port) => spawn(port, env));
  const stop = async () => {
    for (const { proc } of spawned) proc.kill('SIGTERM');
    await Promise.all(spawned.map(({ proc }) => proc.exited));
  };

  try {
    await Promise.all(spawned.map(waitUntilReady));
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    urls: spawned.map(({ url }) => url),
    pids: spawned.map(({ proc }) => proc.pid),
    stop,
  };
}

interface Spawned {
  url: string;
  proc: Subprocess<'ignore', 'ignore', 'pipe'>;
}

/** `env` overrides single variables of the suite's environment for this process. */
function spawn(port: number, env: Readonly<Record<string, string>>): Spawned {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdin: 'ignore',
    stdout: 'ignore',
    // Kept only to explain a process that dies before it is ready.
    stderr: 'pipe',
  });
  return { url: `http://127.0.0.1:${port}`, proc };
}

/** Binds an ephemeral port and releases it. The test container runs nothing else that could take it. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port as number;
}

async function waitUntilReady({ url, proc }: Spawned): Promise<void> {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `process ${proc.pid} exited before ready (${proc.exitCode ?? proc.signalCode}):\n${stderr}`,
      );
    }
    const status = await fetch(`${url}/health/ready`).then(
      (response) => response.status,
      () => undefined,
    );
    if (status === 200) return;
    if (performance.now() > deadline) {
      throw new Error(`process ${proc.pid} not ready at ${url} within ${READY_TIMEOUT_MS} ms`);
    }
    await Bun.sleep(50);
  }
}
