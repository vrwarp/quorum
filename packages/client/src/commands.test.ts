import { describe, expect, it, vi } from 'vitest';
import { CommandTracker } from './commands';

describe('CommandTracker', () => {
  it('gives every command its own cid', () => {
    const t = new CommandTracker();
    const ids = new Set([t.track(), t.track(), t.track()]);
    expect(ids.size).toBe(3);
  });

  it('hands a rejection to the command it answers, once', () => {
    const t = new CommandTracker();
    const a = vi.fn();
    const b = vi.fn();
    const cidA = t.track(a);
    t.track(b);
    expect(t.fail({ code: 'invalid', message: 'too long', inReplyTo: cidA })).toBe(true);
    expect(a).toHaveBeenCalledWith({ code: 'invalid', message: 'too long' });
    expect(b).not.toHaveBeenCalled();
    // a second identical rejection for the same cid has nobody left to tell
    expect(t.fail({ code: 'invalid', message: 'too long', inReplyTo: cidA })).toBe(false);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('leaves errors it cannot place for the room banner', () => {
    const t = new CommandTracker();
    expect(t.fail({ code: 'bad_request', message: 'invalid JSON' })).toBe(false);
    expect(t.fail({ code: 'x', message: 'y', inReplyTo: 'never-sent' })).toBe(false);
    // a tracked command without a handler is also the banner's
    const cid = t.track();
    expect(t.fail({ code: 'x', message: 'y', inReplyTo: cid })).toBe(false);
    expect(t.size).toBe(0);
  });

  it('forgets a command that never left, and everything on a disconnect', () => {
    const t = new CommandTracker();
    const onError = vi.fn();
    const cid = t.track(onError);
    t.forget(cid);
    expect(t.fail({ code: 'x', message: 'y', inReplyTo: cid })).toBe(false);
    const other = t.track(onError);
    t.clear();
    expect(t.fail({ code: 'x', message: 'y', inReplyTo: other })).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('lets old entries age out so successes do not pile up', () => {
    let now = 1_000;
    const t = new CommandTracker(60_000, () => now);
    t.track();
    t.track();
    expect(t.size).toBe(2);
    now += 61_000;
    t.track();
    expect(t.size).toBe(1);
  });
});
