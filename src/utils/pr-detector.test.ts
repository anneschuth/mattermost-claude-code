import { describe, expect, test } from 'bun:test';
import {
  detectPullRequests,
  extractPullRequestUrl,
  formatPullRequestLink,
  getPlatformIcon,
} from './pr-detector.js';

describe('detectPullRequests', () => {
  test('detects GitHub PR URLs', () => {
    const text = 'Created PR: https://github.com/owner/repo/pull/123';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      url: 'https://github.com/owner/repo/pull/123',
      platform: 'github',
      repo: 'owner/repo',
      number: '123',
    });
  });

  test('detects GitLab MR URLs', () => {
    const text = 'See https://gitlab.com/group/project/-/merge_requests/456';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      url: 'https://gitlab.com/group/project/-/merge_requests/456',
      platform: 'gitlab',
      repo: 'group/project',
      number: '456',
    });
  });

  test('detects self-hosted GitLab MR URLs', () => {
    const text = 'PR at https://gitlab.company.com/team/app/-/merge_requests/789';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0].platform).toBe('gitlab');
    expect(prs[0].number).toBe('789');
  });

  test('detects Bitbucket PR URLs', () => {
    const text = 'https://bitbucket.org/workspace/repo/pull-requests/42';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      url: 'https://bitbucket.org/workspace/repo/pull-requests/42',
      platform: 'bitbucket',
      repo: 'workspace/repo',
      number: '42',
    });
  });

  test('detects Azure DevOps PR URLs', () => {
    const text = 'https://dev.azure.com/org/project/_git/repo/pullrequest/99';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/99',
      platform: 'azure',
      repo: 'org/project/_git/repo',
      number: '99',
    });
  });

  test('detects Azure DevOps (visualstudio.com) PR URLs', () => {
    const text = 'https://myorg.visualstudio.com/project/_git/repo/pullrequest/77';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0].platform).toBe('azure');
    expect(prs[0].number).toBe('77');
  });

  test('detects multiple PRs in text', () => {
    const text = `
      First: https://github.com/owner/repo/pull/1
      Second: https://gitlab.com/group/proj/-/merge_requests/2
    `;
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(2);
    expect(prs[0].platform).toBe('github');
    expect(prs[1].platform).toBe('gitlab');
  });

  test('deduplicates same URL appearing multiple times', () => {
    const text = `
      Created https://github.com/owner/repo/pull/123
      Link: https://github.com/owner/repo/pull/123
    `;
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
  });

  test('returns empty array when no PRs found', () => {
    const text = 'No pull requests here, just regular text.';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(0);
  });

  test('handles http URLs', () => {
    const text = 'http://github.com/owner/repo/pull/123';
    const prs = detectPullRequests(text);

    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe('http://github.com/owner/repo/pull/123');
  });
});

describe('extractPullRequestUrl', () => {
  test('returns first PR URL from text', () => {
    const text = 'Created PR https://github.com/owner/repo/pull/123';
    const url = extractPullRequestUrl(text);

    expect(url).toBe('https://github.com/owner/repo/pull/123');
  });

  test('returns null when no PR found', () => {
    const text = 'No PR here';
    const url = extractPullRequestUrl(text);

    expect(url).toBeNull();
  });
});

describe('formatPullRequestLink', () => {
  test('formats GitHub PR as markdown link', () => {
    const url = 'https://github.com/owner/repo/pull/123';
    const formatted = formatPullRequestLink(url);

    expect(formatted).toBe('[🔗 PR #123](https://github.com/owner/repo/pull/123)');
  });

  test('formats GitLab MR with ! prefix', () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/456';
    const formatted = formatPullRequestLink(url);

    expect(formatted).toBe('[🔗 MR !456](https://gitlab.com/group/project/-/merge_requests/456)');
  });

  test('formats Bitbucket PR', () => {
    const url = 'https://bitbucket.org/workspace/repo/pull-requests/42';
    const formatted = formatPullRequestLink(url);

    expect(formatted).toBe('[🔗 PR #42](https://bitbucket.org/workspace/repo/pull-requests/42)');
  });

  test('returns URL as-is if not recognized', () => {
    const url = 'https://example.com/some/path';
    const formatted = formatPullRequestLink(url);

    expect(formatted).toBe(url);
  });
});

describe('getPlatformIcon', () => {
  test('returns octocat for GitHub', () => {
    expect(getPlatformIcon('https://github.com/owner/repo/pull/1')).toBe('🐙');
  });

  test('returns fox for GitLab', () => {
    expect(getPlatformIcon('https://gitlab.com/group/project/-/merge_requests/1')).toBe('🦊');
  });

  test('returns bucket for Bitbucket', () => {
    expect(getPlatformIcon('https://bitbucket.org/workspace/repo/pull-requests/1')).toBe('🪣');
  });

  test('returns diamond for Azure', () => {
    expect(getPlatformIcon('https://dev.azure.com/org/project/_git/repo/pullrequest/1')).toBe('🔷');
  });

  test('returns link for unknown platforms', () => {
    expect(getPlatformIcon('https://example.com/pr/1')).toBe('🔗');
  });
});
