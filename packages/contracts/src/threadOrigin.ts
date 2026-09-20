import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";

/** Native provider context retained by a sidechat without copying history. */
export const ThreadOrigin = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});
export type ThreadOrigin = typeof ThreadOrigin.Type;
