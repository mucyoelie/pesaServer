/** An error that carries the HTTP status and optional field level details. */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, message, details);
export const notFound = (what = 'Resource') => new ApiError(404, `${what} not found`);
export const conflict = (message) => new ApiError(409, message);

/**
 * Translate SQLite constraint failures into readable 4xx responses. Without this a
 * duplicate category name would surface as a 500 and a confusing stack trace.
 */
export function translateSqliteError(error) {
  if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT') {
    return null;
  }
  if (/categories/i.test(error.message)) {
    return conflict('A category with that name already exists under the same parent.');
  }
  if (/budgets/i.test(error.message)) {
    return conflict('A budget for that category and month already exists.');
  }
  return new ApiError(409, 'That record conflicts with an existing one.');
}
