import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";

/** V1 sidechat ancestry; legacy turns are not V2 runs. */
export const ThreadOrigin = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});
export type ThreadOrigin = typeof ThreadOrigin.Type;
