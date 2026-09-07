/**
 * Which lifecycle posts a platform wants to see.
 *
 * `sessionHeader` and `stickyMessage` already let an operator turn down the
 * session table and the pinned status. Neither touches the lifecycle posts —
 * the idle warning, the timeout notice, the pause notice — which in
 * channel-as-task use are the bulk of what a quiet channel contains. This adds
 * the third knob, with the same `full` / `minimal` / `hidden` shape.
 */

import type { OverheadVisibility } from '../config/types.js';

export type LifecyclePost =
  /** "Session idle - will timeout in ~N minutes without activity" */
  | 'idle-warning'
  /** "Session timed out after N minutes" */
  | 'timed-out'
  /** "Session paused. Send a new message to continue." */
  | 'paused'
  /**
   * "Session resumed after bot restart" — the NEW post resume makes when
   * there is no pause/timeout post to edit. Editing an existing one is not
   * this kind: it neither adds a post nor notifies.
   */
  | 'resumed'
  /** "[Exited: <code>]", posted only for a non-zero exit. */
  | 'abnormal-exit';

/**
 * Whether a lifecycle post should be made.
 *
 * - `full` — everything, exactly as today.
 * - `minimal` — drops the idle warning. It predicts something that has not
 *   happened and usually never does: the timeout is resumable, so the next
 *   message brings the session straight back. The other notices report a state
 *   change that already occurred.
 * - `hidden` — no status posts.
 *
 * `resumed` matters most at `hidden`: with the pause post suppressed no
 * `lifecyclePostId` is ever stored, so resume fell through to its "create a
 * new post" branch and announced a bot restart that had not happened. A
 * hidden thread posted MORE over a pause/resume cycle than a full one, and
 * wrongly (Anne's review on #529).
 *
 * ⚠️ `abnormal-exit` survives every level, `hidden` included. It fires only on
 * a non-zero exit code, so it is a failure report rather than overhead.
 * Silencing it would make a session that died indistinguishable from one that
 * finished, which is the one case where quiet is worse than noisy.
 */
export function shouldPostLifecycle(
  visibility: OverheadVisibility,
  kind: LifecyclePost
): boolean {
  if (kind === 'abnormal-exit') return true;

  switch (visibility) {
    case 'full':
      return true;
    case 'minimal':
      return kind !== 'idle-warning';
    case 'hidden':
      return false;
  }
}
