import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mattermostApi,
  getMe,
  getUser,
  createPost,
  updatePost,
  addReaction,
  isUserAllowed,
  createInteractivePost,
  MattermostApiConfig,
} from './api.js';

const mockConfig: MattermostApiConfig = {
  url: 'https://mattermost.example.com',
  token: 'test-token',
};

describe('mattermostApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await mattermostApi(mockConfig, 'GET', '/users/me');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://mattermost.example.com/api/v4/users/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('includes Content-Type header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await mattermostApi(mockConfig, 'POST', '/posts', { message: 'test' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('stringifies body for POST requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await mattermostApi(mockConfig, 'POST', '/posts', { message: 'hello' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ message: 'hello' }),
      })
    );
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      })
    );

    await expect(mattermostApi(mockConfig, 'GET', '/users/me')).rejects.toThrow(
      'Mattermost API error 401'
    );
  });

  it('includes error details in thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Access denied'),
      })
    );

    await expect(mattermostApi(mockConfig, 'GET', '/users/me')).rejects.toThrow(
      'Access denied'
    );
  });
});

describe('getMe', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the current user', async () => {
    const mockUser = { id: 'bot123', username: 'bot' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockUser),
      })
    );

    const result = await getMe(mockConfig);

    expect(result).toEqual(mockUser);
  });
});

describe('getUser', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns user when found', async () => {
    const mockUser = { id: 'user123', username: 'testuser' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockUser),
      })
    );

    const result = await getUser(mockConfig, 'user123');

    expect(result).toEqual(mockUser);
  });

  it('returns null when user not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      })
    );

    const result = await getUser(mockConfig, 'nonexistent');

    expect(result).toBeNull();
  });
});

describe('createPost', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a post with correct parameters', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPost),
    });
    vi.stubGlobal('fetch', mockFetch);

    await createPost(mockConfig, 'channel1', 'Hello');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://mattermost.example.com/api/v4/posts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel_id: 'channel1',
          message: 'Hello',
          root_id: undefined,
        }),
      })
    );
  });

  it('includes root_id for thread replies', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await createPost(mockConfig, 'channel1', 'Reply', 'thread123');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          channel_id: 'channel1',
          message: 'Reply',
          root_id: 'thread123',
        }),
      })
    );
  });
});

describe('updatePost', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates a post with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'post123', message: 'Updated' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await updatePost(mockConfig, 'post123', 'Updated');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://mattermost.example.com/api/v4/posts/post123',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          id: 'post123',
          message: 'Updated',
        }),
      })
    );
  });
});

describe('addReaction', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a reaction with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await addReaction(mockConfig, 'post123', 'bot123', '+1');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://mattermost.example.com/api/v4/reactions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          user_id: 'bot123',
          post_id: 'post123',
          emoji_name: '+1',
        }),
      })
    );
  });
});

describe('isUserAllowed', () => {
  it('returns true when allowlist is empty', () => {
    expect(isUserAllowed('anyone', [])).toBe(true);
  });

  it('returns true when user is in allowlist', () => {
    expect(isUserAllowed('alice', ['alice', 'bob'])).toBe(true);
  });

  it('returns false when user is not in allowlist', () => {
    expect(isUserAllowed('eve', ['alice', 'bob'])).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isUserAllowed('Alice', ['alice'])).toBe(false);
  });
});

describe('createInteractivePost', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleSpy.mockRestore();
  });

  it('creates a post and adds reactions', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPost),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await createInteractivePost(
      mockConfig,
      'channel1',
      'Hello',
      ['+1', '-1'],
      undefined,
      'bot123'
    );

    expect(result).toEqual(mockPost);
    // First call: createPost, second+third: addReaction
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('creates post in a thread when rootId is provided', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Reply' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPost),
    });
    vi.stubGlobal('fetch', mockFetch);

    await createInteractivePost(
      mockConfig,
      'channel1',
      'Reply',
      ['+1'],
      'thread123',
      'bot123'
    );

    // Check the first call (createPost) includes root_id
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://mattermost.example.com/api/v4/posts',
      expect.objectContaining({
        body: JSON.stringify({
          channel_id: 'channel1',
          message: 'Reply',
          root_id: 'thread123',
        }),
      })
    );
  });

  it('continues adding reactions even if one fails', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // createPost succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockPost),
        });
      } else if (callCount === 2) {
        // First reaction fails
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Server error'),
        });
      } else {
        // Second reaction succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      }
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await createInteractivePost(
      mockConfig,
      'channel1',
      'Hello',
      ['+1', '-1'],
      undefined,
      'bot123'
    );

    // Should still return the post
    expect(result).toEqual(mockPost);
    // All three calls should have been made
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Error should have been logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to add reaction'),
      expect.any(Error)
    );
  });

  it('returns the post even with no reactions', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPost),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await createInteractivePost(
      mockConfig,
      'channel1',
      'Hello',
      [],
      undefined,
      'bot123'
    );

    expect(result).toEqual(mockPost);
    // Only createPost call, no reactions
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('adds reactions in the correct order', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPost),
    });
    vi.stubGlobal('fetch', mockFetch);

    await createInteractivePost(
      mockConfig,
      'channel1',
      'Hello',
      ['+1', 'white_check_mark', '-1'],
      undefined,
      'bot123'
    );

    // Check reaction calls are in order
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://mattermost.example.com/api/v4/reactions',
      expect.objectContaining({
        body: expect.stringContaining('+1'),
      })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'https://mattermost.example.com/api/v4/reactions',
      expect.objectContaining({
        body: expect.stringContaining('white_check_mark'),
      })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      'https://mattermost.example.com/api/v4/reactions',
      expect.objectContaining({
        body: expect.stringContaining('-1'),
      })
    );
  });
});
