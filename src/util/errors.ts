export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, "not_found", { entity, id });
  }
}

export class InvalidTransitionError extends AppError {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition ${from} -> ${to}`, "invalid_transition", { entity, from, to });
  }
}

export class PermissionError extends AppError {
  constructor(message = "permission denied") {
    super(message, "permission_denied");
  }
}

export class UnsupportedError extends AppError {
  constructor(feature: string, reason: string) {
    super(`${feature} is not supported: ${reason}`, "unsupported", { feature, reason });
  }
}
