/**
 * Error hierarchy for ArangoDB connection layer.
 * Schema-driven from config/arango-connection.json definitions.
 * Ported from arangojs errors.ts — simplified for ES modules.
 */

export class ArangoError extends Error {
  name = 'ArangoError';
  isArangoError = true;

  constructor({ errorNum, errorMessage, code } = {}, options = {}) {
    super(errorMessage, options);
    this.errorNum = errorNum;
    this.errorMessage = errorMessage;
    this.code = code;
    if (options.isSafeToRetry !== undefined) {
      this.isSafeToRetry = options.isSafeToRetry;
    } else if (errorNum === 503) { // ERROR_ARANGO_MAINTENANCE_MODE
      this.isSafeToRetry = true;
    } else {
      this.isSafeToRetry = null;
    }
  }

  toJSON() {
    return {
      error: true, errorNum: this.errorNum,
      errorMessage: this.errorMessage, code: this.code,
    };
  }

  toString() {
    return `${this.name} ${this.errorNum}: ${this.errorMessage}`;
  }
}

export class HttpError extends Error {
  name = 'HttpError';

  constructor(message, code, options = {}) {
    super(message, options);
    this.code = code;
    this.isSafeToRetry = options.isSafeToRetry ?? null;
  }

  toJSON() {
    return { error: true, errorMessage: this.message, code: this.code };
  }

  toString() {
    return `${this.name} ${this.code}: ${this.message}`;
  }
}

export class NetworkError extends Error {
  name = 'NetworkError';
  isSafeToRetry = true;

  constructor(message, options = {}) {
    super(message, options);
    if (options.isSafeToRetry !== undefined) this.isSafeToRetry = options.isSafeToRetry;
  }
}

export class ResponseTimeoutError extends NetworkError {
  name = 'ResponseTimeoutError';
  isSafeToRetry = true;

  constructor(message, options = {}) {
    super(message ?? 'Timed out while waiting for server response', options);
  }
}

export class FetchFailedError extends NetworkError {
  name = 'FetchFailedError';
  isSafeToRetry = null;

  constructor(message, options = {}) {
    super(message ?? 'Fetch failed', options);
    if (options.isSafeToRetry !== undefined) this.isSafeToRetry = options.isSafeToRetry;
  }
}

/** Check if data matches ArangoErrorResponse shape. */
export function isArangoErrorResponse(data) {
  return (
    data != null &&
    data.error === true &&
    typeof data.errorNum === 'number' &&
    typeof data.errorMessage === 'string'
  );
}

/** Returns boolean|null indicating retry safety based on error type. */
export function isSafeToRetry(error) {
  if (error && typeof error.isSafeToRetry !== 'undefined') return error.isSafeToRetry;
  return null;
}
