import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, watchFile, unwatchFile, unlinkSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('claude');

/**
 * Clean up stale Claude browser bridge socket files.
 *
 * Claude CLI creates socket files named `claude-mcp-browser-bridge-{username}` in the temp directory.
 * If these socket files exist when Claude starts, it tries to fs.watch() them which fails with
 * EOPNOTSUPP because you can't watch socket files. This is a Claude CLI bug.
 *
 * Workaround: Remove any stale browser bridge socket files before starting Claude.
 */
function cleanupBrowserBridgeSockets(): void {
  try {
    const tempDir = tmpdir();
    const files = readdirSync(tempDir);

    for (const file of files) {
      if (file.startsWith('claude-mcp-browser-bridge-')) {
        const filePath = join(tempDir, file);
        try {
          const stats = statSync(filePath);
          // Check if it's a socket file (mode & 0xF000 === 0xC000 for sockets)
          if (stats.isSocket()) {
            unlinkSync(filePath);
            log.debug(`Removed stale browser bridge socket: ${file}`);
          }
        } catch {
          // Ignore errors for individual files
        }
      }
    }
  } catch (err) {
    // Don't fail startup if cleanup fails
    log.debug(`Browser bridge cleanup failed: ${err}`);
  }
}

/**
 * Context window usage data from status line
 */
export interface StatusLineData {
  context_window_size: number;
  total_input_tokens: number;
  total_output_tokens: number;
  current_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  model: {
    id: string;
    display_name: string;
  } | null;
  cost: {
    total_cost_usd: number;
  } | null;
  timestamp: number;
}

export interface ClaudeEvent {
  type: string;
  [key: string]: unknown;
}

// Content block types for messages with images
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface PlatformMcpConfig {
  type: string;
  url: string;
  token: string;
  channelId: string;
  allowedUsers: string[];
}

export interface ClaudeCliOptions {
  workingDir: string;
  threadId?: string;  // Thread ID for permission requests
  skipPermissions?: boolean;  // If true, use --dangerously-skip-permissions
  sessionId?: string;  // Claude session ID (UUID) for --session-id or --resume
  resume?: boolean;    // If true, use --resume instead of --session-id
  chrome?: boolean;    // If true, enable Chrome integration with --chrome
  platformConfig?: PlatformMcpConfig;  // Platform-specific config for MCP server
  appendSystemPrompt?: string;  // Additional system prompt to append
  logSessionId?: string;  // Session ID for log routing (platformId:threadId)
}

export class ClaudeCli extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: ClaudeCliOptions;
  private buffer = '';
  public debug = process.env.DEBUG === '1' || process.argv.includes('--debug');
  private statusFilePath: string | null = null;
  private lastStatusData: StatusLineData | null = null;
  private stderrBuffer = '';  // Capture stderr for error detection
  private log: ReturnType<typeof createLogger>;  // Session-scoped logger

  constructor(options: ClaudeCliOptions) {
    super();
    this.options = options;
    // Create session-scoped logger if logSessionId provided
    this.log = options.logSessionId
      ? createLogger('claude').forSession(options.logSessionId)
      : createLogger('claude');
  }

  /**
   * Get the path to the status line data file for this session.
   */
  getStatusFilePath(): string | null {
    return this.statusFilePath;
  }

  /**
   * Get the latest status line data (context usage, model, cost).
   * Returns null if no data has been received yet.
   */
  getStatusData(): StatusLineData | null {
    if (!this.statusFilePath) return null;

    try {
      if (existsSync(this.statusFilePath)) {
        const data = readFileSync(this.statusFilePath, 'utf8');
        this.lastStatusData = JSON.parse(data) as StatusLineData;
      }
    } catch {
      // Ignore read errors
    }

    return this.lastStatusData;
  }

  /**
   * Start watching the status file for changes.
   * Emits 'status' event when new data is available.
   */
  startStatusWatch(): void {
    if (!this.statusFilePath) return;

    const checkStatus = () => {
      const data = this.getStatusData();
      if (data && data.timestamp !== this.lastStatusData?.timestamp) {
        this.lastStatusData = data;
        this.emit('status', data);
      }
    };

    // Watch for file changes
    watchFile(this.statusFilePath, { interval: 1000 }, checkStatus);
  }

  /**
   * Stop watching the status file and clean up.
   */
  stopStatusWatch(): void {
    if (this.statusFilePath) {
      unwatchFile(this.statusFilePath);
      // Clean up temp file
      try {
        if (existsSync(this.statusFilePath)) {
          unlinkSync(this.statusFilePath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  start(): void {
    if (this.process) throw new Error('Already running');

    // Clear stderr buffer from any previous run
    this.stderrBuffer = '';

    // Clean up stale browser bridge sockets (workaround for Claude CLI bug)
    cleanupBrowserBridgeSockets();

    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // Add session ID for persistence/resume support
    if (this.options.sessionId) {
      if (this.options.resume) {
        args.push('--resume', this.options.sessionId);
      } else {
        args.push('--session-id', this.options.sessionId);
      }
    }

    // Either use skip permissions or the MCP-based permission system
    if (this.options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      // Configure the permission MCP server
      const mcpServerPath = this.getMcpServerPath();

      // Platform config is required for MCP permission server
      const platformConfig = this.options.platformConfig;
      if (!platformConfig) {
        throw new Error('platformConfig is required when skipPermissions is false');
      }
      // Platform-agnostic environment variables for MCP permission server
      const mcpEnv = {
        PLATFORM_TYPE: platformConfig.type,
        PLATFORM_URL: platformConfig.url,
        PLATFORM_TOKEN: platformConfig.token,
        PLATFORM_CHANNEL_ID: platformConfig.channelId,
        PLATFORM_THREAD_ID: this.options.threadId || '',
        ALLOWED_USERS: platformConfig.allowedUsers.join(','),
        DEBUG: this.debug ? '1' : '',
      };

      const mcpConfig = {
        mcpServers: {
          'claude-threads-permissions': {
            type: 'stdio',
            command: 'node',
            args: [mcpServerPath],
            env: mcpEnv,
          },
        },
      };
      args.push('--mcp-config', JSON.stringify(mcpConfig));
      args.push('--permission-prompt-tool', 'mcp__claude-threads-permissions__permission_prompt');
    }

    // Chrome integration
    if (this.options.chrome) {
      args.push('--chrome');
    }

    // Append system prompt for context
    if (this.options.appendSystemPrompt) {
      args.push('--append-system-prompt', this.options.appendSystemPrompt);
    }

    // Configure status line to write context data to a temp file
    // This gives us accurate context window usage information
    if (this.options.sessionId) {
      this.statusFilePath = `/tmp/claude-threads-status-${this.options.sessionId}.json`;
      const statusLineWriterPath = this.getStatusLineWriterPath();
      const statusLineSettings = {
        statusLine: {
          type: 'command',
          command: `node ${statusLineWriterPath} ${this.options.sessionId}`,
          padding: 0,
        },
      };
      args.push('--settings', JSON.stringify(statusLineSettings));
    }

    this.log.debug(`Starting: ${claudePath} ${args.slice(0, 5).join(' ')}...`);

    this.process = spawn(claudePath, args, {
      cwd: this.options.workingDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.parseOutput(chunk.toString());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuffer += text;
      // Keep only the last 10KB of stderr to prevent memory issues
      if (this.stderrBuffer.length > 10240) {
        this.stderrBuffer = this.stderrBuffer.slice(-10240);
      }
      this.log.debug(`stderr: ${text.trim()}`);
    });

    this.process.on('error', (err) => {
      this.log.error(`Claude error: ${err}`);
      this.emit('error', err);
    });

    this.process.on('exit', (code) => {
      this.log.debug(`Exited ${code}`);
      this.process = null;
      this.buffer = '';
      this.emit('exit', code);
    });
  }

  // Send a user message via JSON stdin
  // content can be a string or an array of content blocks (for images)
  sendMessage(content: string | ContentBlock[]): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    }) + '\n';
    const preview = typeof content === 'string'
      ? content.substring(0, 50)
      : `[${content.length} blocks]`;
    this.log.debug(`Sending: ${preview}...`);
    this.process.stdin.write(msg);
  }

  // Send a tool result response
  sendToolResult(toolUseId: string, content: unknown): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: typeof content === 'string' ? content : JSON.stringify(content)
        }]
      }
    }) + '\n';
    this.log.debug(`Sending tool_result for ${toolUseId}`);
    this.process.stdin.write(msg);
  }

  private parseOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as ClaudeEvent;
        this.log.debug(`Event: ${event.type} ${JSON.stringify(event).substring(0, 200)}`);
        this.emit('event', event);
      } catch {
        this.log.debug(`Raw: ${trimmed.substring(0, 200)}`);
      }
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Get the last stderr output (up to 10KB).
   */
  getLastStderr(): string {
    return this.stderrBuffer;
  }

  /**
   * Check if the last failure was a permanent error that shouldn't be retried.
   * These are errors in the Claude CLI itself that won't be fixed by retrying.
   */
  isPermanentFailure(): boolean {
    const stderr = this.stderrBuffer;

    // Browser bridge temp file doesn't exist (happens when resuming sessions that had chrome enabled)
    if (stderr.includes('claude-mcp-browser-bridge') &&
        (stderr.includes('EOPNOTSUPP') || stderr.includes('ENOENT'))) {
      return true;
    }

    // Session no longer exists in Claude's conversation history
    // This happens when ~/.claude/projects/* is cleared or session was from a different machine
    if (stderr.includes('No conversation found with session ID')) {
      return true;
    }

    return false;
  }

  /**
   * Get a human-readable description of a permanent failure.
   */
  getPermanentFailureReason(): string | null {
    const stderr = this.stderrBuffer;

    if (stderr.includes('claude-mcp-browser-bridge') &&
        (stderr.includes('EOPNOTSUPP') || stderr.includes('ENOENT'))) {
      return 'Claude browser bridge state from a previous session is no longer accessible. This typically happens when a session with Chrome integration is resumed after a restart.';
    }

    if (stderr.includes('No conversation found with session ID')) {
      return 'The conversation history for this session no longer exists. This can happen if Claude\'s history was cleared or if the session was created on a different machine.';
    }

    return null;
  }

  /**
   * Kill the Claude CLI process.
   * Sends two SIGINTs (like Ctrl+C twice in interactive mode) to allow graceful shutdown,
   * then SIGTERM after a timeout if it doesn't exit.
   * Returns a Promise that resolves when the process has exited.
   */
  kill(): Promise<void> {
    this.stopStatusWatch();
    if (!this.process) return Promise.resolve();

    const proc = this.process;
    this.process = null;

    return new Promise<void>((resolve) => {
      // Send first SIGINT (interrupts current operation)
      proc.kill('SIGINT');

      // Send second SIGINT after brief delay (triggers exit in interactive mode)
      const secondSigint = setTimeout(() => {
        try {
          proc.kill('SIGINT');
        } catch {
          // Process may have already exited
        }
      }, 100);

      // Force kill with SIGTERM if still running after grace period
      const forceKillTimeout = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Process may have already exited
        }
      }, 2000); // 2 second grace period for Claude to save conversation

      // Resolve when process exits
      proc.once('exit', () => {
        clearTimeout(secondSigint);
        clearTimeout(forceKillTimeout);
        resolve();
      });
    });
  }

  /** Interrupt current processing (like Escape in CLI) - keeps process alive */
  interrupt(): boolean {
    if (!this.process) return false;
    this.process.kill('SIGINT');
    return true;
  }

  private getMcpServerPath(): string {
    // Get the path to the MCP permission server
    // When running from source: src/mcp/permission-server.ts -> dist/mcp/permission-server.js
    // When installed globally: the bin entry points to dist/mcp/permission-server.js
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return resolve(__dirname, '..', 'mcp', 'permission-server.js');
  }

  private getStatusLineWriterPath(): string {
    // Get the path to the status line writer script
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return resolve(__dirname, '..', 'statusline', 'writer.js');
  }
}
