import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { createLogger, mcpLogger, wsLogger } from './logger.js';

describe('createLogger', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    } else {
      delete process.env.DEBUG;
    }
  });

  describe('debug', () => {
    it('does not log when DEBUG is not set', () => {
      const logger = createLogger('[test]');
      logger.debug('test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('logs to stdout when DEBUG=1 and useStderr=false', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('[test]');
      logger.debug('test message');
      expect(consoleLogSpy).toHaveBeenCalledWith('[test] test message');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('logs to stderr when DEBUG=1 and useStderr=true', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('[test]', true);
      logger.debug('test message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('does not log when DEBUG is set to something other than 1', () => {
      process.env.DEBUG = 'true';
      const logger = createLogger('[test]');
      logger.debug('test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('info', () => {
    it('always logs to stdout when useStderr=false', () => {
      const logger = createLogger('[test]');
      logger.info('info message');
      expect(consoleLogSpy).toHaveBeenCalledWith('[test] info message');
    });

    it('logs to stderr when useStderr=true', () => {
      const logger = createLogger('[test]', true);
      logger.info('info message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] info message');
    });

    it('logs even when DEBUG is not set', () => {
      const logger = createLogger('[test]');
      logger.info('info message');
      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('always logs to stderr', () => {
      const logger = createLogger('[test]');
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] error message');
    });

    it('logs to stderr even when useStderr=false', () => {
      const logger = createLogger('[test]', false);
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] error message');
    });

    it('logs even when DEBUG is not set', () => {
      const logger = createLogger('[test]');
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('prefix formatting', () => {
    it('includes prefix in debug messages', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('[MyPrefix]');
      logger.debug('my message');
      expect(consoleLogSpy).toHaveBeenCalledWith('[MyPrefix] my message');
    });

    it('includes prefix in info messages', () => {
      const logger = createLogger('[MyPrefix]');
      logger.info('my message');
      expect(consoleLogSpy).toHaveBeenCalledWith('[MyPrefix] my message');
    });

    it('includes prefix in error messages', () => {
      const logger = createLogger('[MyPrefix]');
      logger.error('my message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[MyPrefix] my message');
    });
  });
});

describe('pre-configured loggers', () => {
  // Note: mcpLogger and wsLogger are module-level singletons created at import time.
  // Since they capture console.log/error at creation, we test their behavior by
  // verifying they have the expected interface and configuration.

  describe('mcpLogger', () => {
    it('has debug, info, and error methods', () => {
      expect(typeof mcpLogger.debug).toBe('function');
      expect(typeof mcpLogger.info).toBe('function');
      expect(typeof mcpLogger.error).toBe('function');
    });
  });

  describe('wsLogger', () => {
    it('has debug, info, and error methods', () => {
      expect(typeof wsLogger.debug).toBe('function');
      expect(typeof wsLogger.info).toBe('function');
      expect(typeof wsLogger.error).toBe('function');
    });
  });
});
