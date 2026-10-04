import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@quorum/shared';
import { RoomSocket, reconnectDelay } from './ws';
import type { SocketFailure } from './ws';

/** A WebSocket that does what the test says: opens, receives, drops. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.drop();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

const hello = { type: 'hello' } as unknown as ServerEvent;
const settle = () => vi.advanceTimersByTimeAsync(0);
const instances = () => FakeSocket.instances;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  fetchMock = vi.fn(async () => ({ status: 200 }));
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'quorum.test' });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Math, 'random').mockReturnValue(1); // full-length delays
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reconnectDelay', () => {
  it('doubles from half a second up to ten, jittered within the upper half of each step', () => {
    const full = [0, 1, 2, 3, 4, 5, 6, 20].map((n) => reconnectDelay(n, () => 1));
    expect(full).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
    const low = [0, 1, 2, 5].map((n) => reconnectDelay(n, () => 0));
    expect(low).toEqual([250, 500, 1000, 5000]);
  });
});

describe('RoomSocket', () => {
  it('connects to the room with the session cookie, and reports open and closed', () => {
    const socket = new RoomSocket('room_1');
    const status: boolean[] = [];
    socket.onStatus((c) => status.push(c));
    socket.connect();
    expect(instances()[0]!.url).toBe('ws://quorum.test/ws?roomId=room_1');
    instances()[0]!.open();
    instances()[0]!.drop();
    expect(status).toEqual([true, false]);
    socket.close();
  });

  it('only resets the backoff once the server has said hello', async () => {
    const socket = new RoomSocket('room_1');
    socket.connect();
    // accepted, then dropped with no hello: the delays keep growing instead of retrying every half second
    instances()[0]!.open();
    instances()[0]!.drop();
    await vi.advanceTimersByTimeAsync(499);
    expect(instances()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances()).toHaveLength(2);
    instances()[1]!.open();
    instances()[1]!.drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(instances()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances()).toHaveLength(3);
    // this one is greeted: the next wait is back to the first step
    instances()[2]!.open();
    instances()[2]!.receive(hello);
    instances()[2]!.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(instances()).toHaveLength(4);
    socket.close();
  });

  it('spreads reconnects with jitter', async () => {
    vi.mocked(Math.random).mockReturnValue(0);
    const socket = new RoomSocket('room_1');
    socket.connect();
    instances()[0]!.open();
    instances()[0]!.drop();
    await vi.advanceTimersByTimeAsync(250);
    expect(instances()).toHaveLength(2);
    socket.close();
  });

  it('drops frames that are not events and passes on every other type (the reducer ignores unknown ones)', () => {
    const socket = new RoomSocket('room_1');
    const seen: unknown[] = [];
    socket.onEvent((ev) => seen.push(ev));
    socket.connect();
    const ws = instances()[0]!;
    ws.open();
    for (const junk of ['not json', 'null', '42', '"hello"', '[]', '{"type":7}', '{}'])
      ws.receive(junk);
    ws.receive({ type: 'quorum.future.thing', x: 1 });
    expect(seen).toEqual([{ type: 'quorum.future.thing', x: 1 }]);
    socket.close();
  });

  it('refuses to send while it is not open', () => {
    const socket = new RoomSocket('room_1');
    socket.connect();
    expect(socket.send({ type: 'chat.send', body: 'hi' })).toBe(false);
    instances()[0]!.open();
    expect(socket.send({ type: 'chat.send', body: 'hi' })).toBe(true);
    expect(instances()[0]!.sent).toEqual(['{"type":"chat.send","body":"hi"}']);
    socket.close();
  });

  async function refused(status: number | Error): Promise<{ failures: SocketFailure[] }> {
    fetchMock.mockImplementation(async () => {
      if (status instanceof Error) throw status;
      return { status };
    });
    const socket = new RoomSocket('room_1');
    const failures: SocketFailure[] = [];
    socket.onFailure((f) => failures.push(f));
    socket.connect();
    instances()[0]!.drop(); // never opened
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room_1/usage', { credentials: 'include' });
    return { failures };
  }

  it('reports a revoked session instead of retrying forever', async () => {
    const { failures } = await refused(401);
    expect(failures).toEqual(['unauthorized']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances()).toHaveLength(1);
  });

  it('reports an unknown room instead of retrying forever', async () => {
    const { failures } = await refused(404);
    expect(failures).toEqual(['not_found']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances()).toHaveLength(1);
  });

  it('stops when the server says the room is archived (it accepts the socket, says so, and closes)', async () => {
    const socket = new RoomSocket('room_1');
    const failures: SocketFailure[] = [];
    const seen: unknown[] = [];
    socket.onFailure((f) => failures.push(f));
    socket.onEvent((ev) => seen.push(ev));
    socket.connect();
    const ws = instances()[0]!;
    ws.open();
    ws.receive({ type: 'error', code: 'room_archived', message: 'This room is archived.' });
    ws.drop();
    expect(failures).toEqual(['archived']);
    expect(seen).toEqual([]); // not an error for the banner: the failure says it
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps retrying when the refusal is just an unreachable or unwell server', async () => {
    for (const outcome of [200, 502, new TypeError('network down')]) {
      FakeSocket.instances = [];
      const { failures } = await refused(outcome);
      expect(failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(instances()).toHaveLength(2);
    }
  });

  it('stops for good when closed, even with a retry pending or a probe in flight', async () => {
    const socket = new RoomSocket('room_1');
    socket.connect();
    instances()[0]!.open();
    instances()[0]!.drop();
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances()).toHaveLength(1);

    FakeSocket.instances = [];
    let release: (r: { status: number }) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const probing = new RoomSocket('room_1');
    const failures: SocketFailure[] = [];
    probing.onFailure((f) => failures.push(f));
    probing.connect();
    instances()[0]!.drop();
    probing.close();
    release({ status: 404 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failures).toEqual([]);
    expect(instances()).toHaveLength(1);
  });
});
