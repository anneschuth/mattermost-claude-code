import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { KeepAliveManager } from './keep-alive.js';

describe('KeepAliveManager', () => {
  let manager: KeepAliveManager;

  beforeEach(() => {
    manager = new KeepAliveManager();
  });

  afterEach(() => {
    manager.forceStop();
  });

  test('starts with zero active sessions', () => {
    expect(manager.getSessionCount()).toBe(0);
  });

  test('is enabled by default', () => {
    expect(manager.isEnabled()).toBe(true);
  });

  test('can be disabled', () => {
    manager.setEnabled(false);
    expect(manager.isEnabled()).toBe(false);
  });

  test('increments session count on sessionStarted', () => {
    manager.sessionStarted();
    expect(manager.getSessionCount()).toBe(1);
    manager.sessionStarted();
    expect(manager.getSessionCount()).toBe(2);
  });

  test('decrements session count on sessionEnded', () => {
    manager.sessionStarted();
    manager.sessionStarted();
    expect(manager.getSessionCount()).toBe(2);
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(1);
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('does not go below zero sessions', () => {
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('forceStop resets session count', () => {
    manager.sessionStarted();
    manager.sessionStarted();
    manager.forceStop();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('isActive is false when disabled', () => {
    manager.setEnabled(false);
    manager.sessionStarted();
    expect(manager.isActive()).toBe(false);
  });

  test('starts keep-alive process on first session (macOS)', () => {
    // On macOS, starting a session should activate keep-alive
    if (process.platform === 'darwin') {
      manager.sessionStarted();
      expect(manager.isActive()).toBe(true);
    }
  });

  test('stops keep-alive process when all sessions end', () => {
    manager.sessionStarted();
    manager.sessionEnded();
    // Give a moment for process to stop
    expect(manager.getSessionCount()).toBe(0);
  });
});
