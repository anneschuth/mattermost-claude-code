import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const log = createLogger('claude');

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
}

export class ClaudeCli extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: ClaudeCliOptions;
  private buffer = '';
  public debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  constructor(options: ClaudeCliOptions) {
    super();
    this.options = options;
  }

  start(): void {
    if (this.process) throw new Error('Already running');

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

    log.debug(`Starting: ${claudePath} ${args.slice(0, 5).join(' ')}...`);

    this.process = spawn(claudePath, args, {
      cwd: this.options.workingDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.parseOutput(chunk.toString());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      log.debug(`stderr: ${chunk.toString().trim()}`);
    });

    this.process.on('error', (err) => {
      log.error(`Claude error: ${err}`);
      this.emit('error', err);
    });

    this.process.on('exit', (code) => {
      log.debug(`Exited ${code}`);
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
    log.debug(`Sending: ${preview}...`);
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
    log.debug(`Sending tool_result for ${toolUseId}`);
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
        log.debug(`Event: ${event.type} ${JSON.stringify(event).substring(0, 200)}`);
        this.emit('event', event);
      } catch {
        log.debug(`Raw: ${trimmed.substring(0, 200)}`);
      }
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  kill(): void {
    this.process?.kill('SIGTERM');
    this.process = null;
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
}
