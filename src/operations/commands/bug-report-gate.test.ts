/**
 * `bugReports: false` has to remove the whole path, not just the command.
 *
 * `!bug` uploads attached screenshots to a public anonymous file host and
 * files session context plus recent daemon log lines as an issue on a public
 * repository. `claudeCanExecute: true` means the agent can trigger it with no
 * human typing anything, and a report card can already be pending from before
 * the switch was thrown. An operator who turns this off in a regulated
 * environment needs all of those closed.
 */
import { describe, it, expect, mock } from 'bun:test';
import * as commands from './handler.js';
import { createMockSessionContext } from '../../test-utils/mock-session-context.js';
import type { Session } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';
import { configureBugReports, postError } from '../post-helpers/index.js';

function sessionWith() {
  const createPost = mock(async (content: string) => ({
    id: 'p1', platformId: 'test', channelId: 'c', message: content, createAt: 0, userId: 'bot',
  }));
  const setPendingBugReport = mock(() => {});
  // The upload path calls this before anything reaches catbox.moe, so it is
  // the earliest observable sign that data started leaving the host.
  const downloadFile = mock(async () => Buffer.from('not-a-real-image'));
  const session = {
    sessionId: 'test-platform:thread-1',
    platformId: 'test-platform',
    threadId: 'thread-1',
    workingDir: process.cwd(),
    startedBy: 'alice',
    claudeSessionId: 'claude-session-1',
    startedAt: new Date(),
    platform: {
      createPost,
      createInteractivePost: mock(async (content: string) => ({
        id: 'preview-1', platformId: 'test', channelId: 'c', message: content, createAt: 0, userId: 'bot',
      })),
      downloadFile,
      getFormatter: () => createMockFormatter(),
    } as unknown as PlatformClient,
    messageManager: { setPendingBugReport, getPendingBugReport: () => null } as never,
  } as unknown as Session;
  return { session, createPost, setPendingBugReport, downloadFile };
}

function ctxWithBugReports(enabled: boolean) {
  const ctx = createMockSessionContext(() => ({ getFormatter: () => createMockFormatter() }) as unknown as PlatformClient);
  (ctx.config as { bugReportsEnabled: boolean }).bugReportsEnabled = enabled;
  return ctx;
}

describe('bugReports: false', () => {
  it('refuses !bug and never builds a report', async () => {
    const { session, createPost, setPendingBugReport } = sessionWith();

    await commands.reportBug(session, 'something broke', 'alice', ctxWithBugReports(false));

    // Nothing is uploaded and no approval card is left for someone to press.
    expect(setPendingBugReport).not.toHaveBeenCalled();
    const posted = createPost.mock.calls.map((c) => String(c[0])).join('\n');
    expect(posted.toLowerCase()).toContain('disabled');
  });

  it('refuses a report triggered by an error reaction, not just the typed command', async () => {
    // The 🐛 reaction path reaches the same function with an errorContext and
    // no description — it must not slip past a gate placed on the argument.
    const { session, setPendingBugReport } = sessionWith();

    await commands.reportBug(session, undefined, 'alice', ctxWithBugReports(false), {
      postId: 'err-post-1', message: 'boom', timestamp: new Date(),
    });

    expect(setPendingBugReport).not.toHaveBeenCalled();
  });

  it('does not download or upload an attachment — the gate sits ABOVE the upload', async () => {
    // The whole value of this switch is being in front of the egress, not
    // merely refusing at the end. Without this assertion the gate could be
    // moved below the catbox upload and every other test here stays green.
    const { session, downloadFile, setPendingBugReport } = sessionWith();
    const screenshot = { id: 'f1', name: 'screenshot.png', size: 10 } as never;

    await commands.reportBug(session, 'look at this', 'alice', ctxWithBugReports(false), undefined, [screenshot]);

    expect(downloadFile).not.toHaveBeenCalled();
    expect(setPendingBugReport).not.toHaveBeenCalled();
  });

  it('refuses to file a report card that is already pending', async () => {
    // The approval callback is the ONLY caller of createGitHubIssue and does
    // not pass through reportBug, so the gate there does not cover it.
    // Unreachable today — reportBug refuses before a card is ever created,
    // and serialize() does not persist one — which is precisely why it needs
    // a test, or the next reader removes it as dead code (maintainer review).
    const { session } = sessionWith();
    const clearPendingBugReport = mock(() => {});
    const updatePost = mock(async () => {});
    (session.messageManager as unknown as Record<string, unknown>).getPendingBugReport = () => ({
      postId: 'card-1', title: 'T', body: 'B', description: 'd', imageUrls: [],
    });
    (session.messageManager as unknown as Record<string, unknown>).clearPendingBugReport = clearPendingBugReport;
    (session.platform as unknown as Record<string, unknown>).updatePost = updatePost;

    await commands.handleBugReportApproval(session, true, 'alice', ctxWithBugReports(false));

    // Nothing filed: the only route to createGitHubIssue reports success by
    // editing the card with an issue URL, so an edit carrying one would mean
    // the report went out.
    const edits = updatePost.mock.calls.map((c) => String((c as unknown[])[1])).join('\n');
    expect(edits).not.toContain('github.com');
    expect(edits.toLowerCase()).not.toContain('submitted');
    expect(clearPendingBugReport).toHaveBeenCalled();
  });

  it('does not offer the 🐛 quick-report reaction on error posts', async () => {
    // The reaction is an invitation to a path that will refuse. In the
    // deployments this switch exists for, the button should not be on the
    // wall at all (maintainer review called this optional; it was cheap via
    // the same module-level configure pattern as the audit log).
    const addReaction = mock(async () => {});
    const errSession = {
      sessionId: 'test-platform:thread-1', platformId: 'test-platform', threadId: 'thread-1',
      platform: {
        createPost: mock(async (content: string) => ({
          id: 'e1', platformId: 'test', channelId: 'c', message: content, createAt: 0, userId: 'bot',
        })),
        addReaction,
        getFormatter: () => createMockFormatter(),
      },
    } as unknown as Session;

    configureBugReports(false);
    try {
      await postError(errSession, 'something failed');
      expect(addReaction).not.toHaveBeenCalled();

      configureBugReports(true);
      await postError(errSession, 'something failed');
      expect(addReaction).toHaveBeenCalled();
    } finally {
      configureBugReports(true);
    }
  });

  it('leaves the feature working when enabled, so the gate is what stops it', async () => {
    // The same call with the flag on reaches the end of the preview flow and
    // registers an approval card. Nothing is sent anywhere yet — the GitHub
    // issue is only created once a human approves that card.
    // Deliberately NOT asserting that the report completes: past the gate the
    // flow needs a working `gh` CLI, which is an environment fact rather than
    // anything this switch controls. What matters is that the refusal is
    // absent — whatever stops it here, it is not the gate.
    const { session, createPost } = sessionWith();

    await commands.reportBug(session, 'something broke', 'alice', ctxWithBugReports(true));

    const posted = createPost.mock.calls.map((c) => String(c[0])).join('\n');
    expect(posted).not.toContain('Bug reporting is disabled');
  });
});
