/**
 * What happens when reconnection attempts run out (#500, #531).
 *
 * The failure this prevents is "active but deaf": a live process whose socket
 * is dead, which a supervisor sees as healthy and a user sees as a bot that
 * stopped answering. Both policies end that state — `retry` by recovering,
 * `exit` by handing the problem to the supervisor.
 */
import { describe, it, expect, mock } from 'bun:test';
import { BasePlatformClient } from './base-client.js';

// Only the reconnect machinery is under test, so the ~20 platform methods
// are left unimplemented and the class is declared abstract to say so.
abstract class ReconnectHarness extends BasePlatformClient {
  readonly platformId = 'test';
  readonly platformType = 'test';
  readonly displayName = 'Test';
  connectCalls = 0;

  async connect(): Promise<void> { this.connectCalls++; }
  async disconnect(): Promise<void> { /* no socket in this harness */ }
  protected async forceCloseConnection(): Promise<void> { /* no socket in this harness */ }

  /** Drive the private state the way an exhausted reconnect loop would. */
  exhaust(): void {
    (this as unknown as { reconnectAttempts: number }).reconnectAttempts =
      (this as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts;
    (this as unknown as { scheduleReconnect: () => void }).scheduleReconnect();
  }
  get attempts(): number { return (this as unknown as { reconnectAttempts: number }).reconnectAttempts; }
}

const TestClient = ReconnectHarness as unknown as new () => ReconnectHarness;

describe('reconnection exhausted', () => {
  it('exit policy: emits reconnect-exhausted and does not kill the process itself', () => {
    const client = new TestClient();
    client.setReconnectPolicy('exit');
    const onExhausted = mock(() => {});
    client.on('reconnect-exhausted', onExhausted);
    const exitSpy = mock(() => undefined as never);
    const realExit = process.exit;
    (process as unknown as { exit: unknown }).exit = exitSpy;

    try {
      client.exhaust();
    } finally {
      (process as unknown as { exit: unknown }).exit = realExit;
    }

    expect(onExhausted).toHaveBeenCalledTimes(1);
    // One platform's dead socket must not take down sessions on healthy
    // platforms, and a library class must not decide the process's fate.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('retry policy (the default): resets the counter and keeps trying, without exiting or emitting', () => {
    const client = new TestClient();
    const onExhausted = mock(() => {});
    client.on('reconnect-exhausted', onExhausted);
    const exitSpy = mock(() => undefined as never);
    const realExit = process.exit;
    (process as unknown as { exit: unknown }).exit = exitSpy;

    try {
      client.exhaust();
    } finally {
      (process as unknown as { exit: unknown }).exit = realExit;
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    // The counter is back to zero, so the next round starts over rather than
    // falling straight back into exhaustion.
    expect(client.attempts).toBe(0);
    client.clearReconnectTimer();
  });
});
