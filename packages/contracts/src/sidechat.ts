import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadOrigin } from "./threadOrigin.ts";

export const ThreadForkRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ThreadForkRequestId = typeof ThreadForkRequestId.Type;

export const ThreadForkInput = Schema.Struct({
  sourceThreadId: ThreadId,
  requestId: ThreadForkRequestId,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  targetThreadId: ThreadId,
  origin: ThreadOrigin,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export class ThreadForkSourceNotFoundError extends Schema.TaggedError<ThreadForkSourceNotFoundError>()(
  "ThreadForkSourceNotFoundError",
  { sourceThreadId: ThreadId },
) {
  override get message(): string {
    return `Source thread '${this.sourceThreadId}' was not found.`;
  }
}

export class ThreadForkSourceBusyError extends Schema.TaggedError<ThreadForkSourceBusyError>()(
  "ThreadForkSourceBusyError",
  { sourceThreadId: ThreadId, reason: Schema.String },
) {
  override get message(): string {
    return `Source thread '${this.sourceThreadId}' cannot be forked: ${this.reason}`;
  }
}

export class ThreadForkUnsupportedError extends Schema.TaggedError<ThreadForkUnsupportedError>()(
  "ThreadForkUnsupportedError",
  { provider: Schema.String },
) {
  override get message(): string {
    return `Provider '${this.provider}' does not support native thread forks.`;
  }
}

export class ThreadForkFailedError extends Schema.TaggedError<ThreadForkFailedError>()(
  "ThreadForkFailedError",
  { sourceThreadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not fork source thread '${this.sourceThreadId}'.`;
  }
}

export type ThreadForkError =
  | ThreadForkSourceNotFoundError
  | ThreadForkSourceBusyError
  | ThreadForkUnsupportedError
  | ThreadForkFailedError
  | EnvironmentAuthorizationError;

export const ThreadForkErrorSchema = Schema.Union(
  [
    ThreadForkSourceNotFoundError,
    ThreadForkSourceBusyError,
    ThreadForkUnsupportedError,
    ThreadForkFailedError,
    EnvironmentAuthorizationError,
  ],
);
