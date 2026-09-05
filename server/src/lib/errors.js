export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (m, d) => new AppError(400, m, d);
export const unauthorized = (m = 'Not authenticated') => new AppError(401, m);
export const forbidden = (m = 'Not permitted') => new AppError(403, m);
export const notFound = (m = 'Not found') => new AppError(404, m);
export const conflict = (m, d) => new AppError(409, m, d);

// Wraps async route handlers so rejected promises reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
