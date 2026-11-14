import type { Socket } from 'bun';

/**
 * A TCP proxy between the application and a real container (docs/tasks/S12.md, Q1). `cut()` drops
 * every open connection and closes each new one at once, which the driver and the SDK see as a
 * server that went away; `restore()` lets connections through again. The container itself keeps
 * running, so other suites sharing it are not affected.
 */
export interface TcpProxy {
  /** `host:port` of the proxy, to put in a URL instead of the target's. */
  readonly address: string;
  cut(): void;
  restore(): void;
  stop(): void;
}

interface Pipe {
  peer: Socket<Pipe> | undefined;
  /** Bytes for this socket that it could not take yet: before the upstream connects, or under backpressure. */
  pending: Uint8Array[];
}

export function startTcpProxy(targetHost: string, targetPort: number): TcpProxy {
  let down = false;
  const open = new Set<Socket<Pipe>>();

  const flush = (socket: Socket<Pipe>) => {
    while (socket.data.pending.length > 0) {
      const chunk = socket.data.pending[0] as Uint8Array;
      const written = socket.write(chunk);
      if (written < chunk.length) {
        socket.data.pending[0] = chunk.subarray(written);
        return;
      }
      socket.data.pending.shift();
    }
  };
  const send = (socket: Socket<Pipe> | undefined, chunk: Uint8Array, owner: Pipe) => {
    // Until the upstream is connected, client bytes wait on the client's pipe.
    if (socket === undefined) {
      owner.pending.push(new Uint8Array(chunk));
      return;
    }
    socket.data.pending.push(new Uint8Array(chunk));
    flush(socket);
  };
  const close = (socket: Socket<Pipe>) => {
    open.delete(socket);
    socket.data.peer?.end();
  };

  const listener = Bun.listen<Pipe>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = { peer: undefined, pending: [] };
        if (down) {
          client.end();
          return;
        }
        open.add(client);
        void Bun.connect<Pipe>({
          hostname: targetHost,
          port: targetPort,
          socket: {
            open(upstream) {
              upstream.data = { peer: client, pending: client.data.pending };
              client.data.pending = [];
              client.data.peer = upstream;
              open.add(upstream);
              flush(upstream);
            },
            data: (upstream, chunk) => send(upstream.data.peer, chunk, upstream.data),
            drain: flush,
            close,
            error: close,
            connectError: () => {
              client.end();
            },
          },
        }).catch(() => client.end());
      },
      data: (client, chunk) => send(client.data.peer, chunk, client.data),
      drain: flush,
      close,
      error: close,
    },
  });

  return {
    address: `127.0.0.1:${listener.port}`,
    cut() {
      down = true;
      for (const socket of open) socket.end();
      open.clear();
    },
    restore() {
      down = false;
    },
    stop() {
      this.cut();
      listener.stop(true);
    },
  };
}
