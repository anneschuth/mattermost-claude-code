import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
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

// Save original fetch to restore after tests
const originalFetch = globalThis.fetch;

// Helper to create a mock fetch that satisfies TypeScript
const createMockFetch = (impl: () => Promise<Partial<Response>>) => {
  return mock(impl) as unknown as typeof fetch;
};

describe('mattermostApi', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('adds authorization header', async () => {
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: '123' }),
    }));
    globalThis.fetch = mockFetch;

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
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    globalThis.fetch = mockFetch;

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
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    globalThis.fetch = mockFetch;

    await mattermostApi(mockConfig, 'POST', '/posts', { message: 'hello' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ message: 'hello' }),
      })
    );
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = createMockFetch(() => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    }));

    await expect(mattermostApi(mockConfig, 'GET', '/users/me')).rejects.toThrow(
      'Mattermost API error 401'
    );
  });

  it('includes error details in thrown error', async () => {
    globalThis.fetch = createMockFetch(() => Promise.resolve({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Access denied'),
    }));

    await expect(mattermostApi(mockConfig, 'GET', '/users/me')).rejects.toThrow(
      'Access denied'
    );
  });
});

describe('getMe', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the current user', async () => {
    const mockUser = { id: 'bot123', username: 'bot' };
    globalThis.fetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockUser),
    }));

    const result = await getMe(mockConfig);

    expect(result).toEqual(mockUser);
  });
});

describe('getUser', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns user when found', async () => {
    const mockUser = { id: 'user123', username: 'testuser' };
    globalThis.fetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockUser),
    }));

    const result = await getUser(mockConfig, 'user123');

    expect(result).toEqual(mockUser);
  });

  it('returns null when user not found', async () => {
    globalThis.fetch = createMockFetch(() => Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not found'),
    }));

    const result = await getUser(mockConfig, 'nonexistent');

    expect(result).toBeNull();
  });
});

describe('createPost', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates a post with correct parameters', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockPost),
    }));
    globalThis.fetch = mockFetch;

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
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    globalThis.fetch = mockFetch;

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
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('updates a post with correct parameters', async () => {
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 'post123', message: 'Updated' }),
    }));
    globalThis.fetch = mockFetch;

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
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('adds a reaction with correct parameters', async () => {
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    globalThis.fetch = mockFetch;

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
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleSpy.mockRestore();
  });

  it('creates a post and adds reactions', async () => {
    const mockPost = { id: 'post123', channel_id: 'channel1', message: 'Hello' };
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockPost),
    }));
    globalThis.fetch = mockFetch;

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
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockPost),
    }));
    globalThis.fetch = mockFetch;

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
    const mockFetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        // createPost succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockPost),
        } as Response);
      } else if (callCount === 2) {
        // First reaction fails
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Server error'),
        } as Response);
      } else {
        // Second reaction succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response);
      }
    }) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

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
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockPost),
    }));
    globalThis.fetch = mockFetch;

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
    const mockFetch = createMockFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockPost),
    }));
    globalThis.fetch = mockFetch;

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
