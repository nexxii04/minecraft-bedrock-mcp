import { pino, destination as pinoDestination, type Logger as PinoLogger } from 'pino';
import type { LOG_LEVELS } from './config.js';

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A tiny structural subset of pino's logger, so the rest of the codebase depends
 * on the shape it uses rather than on pino itself.
 */
export interface Logger {
  fatal: LogMethod;
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  debug: LogMethod;
  trace: LogMethod;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Accepts pino's two calling conventions: `log(obj, msg)` and `log(msg)`. The
 * first parameter is deliberately `unknown`, which covers both a binding object
 * and a bare message string.
 */
type LogMethod = (obj: unknown, msg?: string, ...args: unknown[]) => void;

export interface CreateLoggerOptions {
  level: LogLevel;
  /**
   * Where log records go. Defaults to **stderr**: over stdio, stdout carries the
   * JSON-RPC stream and any stray write there corrupts the protocol.
   */
  destinationFd?: number;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const logger = pino(
    {
      level: options.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pinoDestination({ dest: options.destinationFd ?? 2, sync: true }),
  ) as PinoLogger;

  return logger;
}

/** Builds a logger that discards everything; used by tests and silent callers. */
export function createNoopLogger(): Logger {
  const noop: LogMethod = () => {};
  const logger: Logger = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => logger,
  };
  return logger;
}
