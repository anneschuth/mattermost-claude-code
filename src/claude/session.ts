import { ClaudeCli, ClaudeEvent } from './cli.js';
import { MattermostClient } from '../mattermost/client.js';

interface SessionState {
  threadId: string;
  postId: string | null;
  content: string;
}

interface QuestionOption {
  label: string;
  description: string;
}

interface PendingQuestionSet {
  toolUseId: string;  // The tool_use_id to respond to
  currentIndex: number;  // which question we're on
  currentPostId: string | null;  // post ID of current question
  questions: Array<{
    header: string;
    question: string;
    options: QuestionOption[];
    answer: string | null;  // null until answered
  }>;
}

interface PendingApproval {
  postId: string;
  type: 'plan' | 'action';
}

const REACTION_EMOJIS = ['one', 'two', 'three', 'four'];
const EMOJI_TO_INDEX: Record<string, number> = {
  'one': 0, '1️⃣': 0,
  'two': 1, '2️⃣': 1,
  'three': 2, '3️⃣': 2,
  'four': 3, '4️⃣': 3,
};

export class SessionManager {
  private claude: ClaudeCli;
  private mattermost: MattermostClient;
  private workingDir: string;
  private session: SessionState | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private pendingQuestionSet: PendingQuestionSet | null = null;
  private pendingApproval: PendingApproval | null = null;
  private planApproved = false; // Track if we already approved this session
  private tasksPostId: string | null = null; // Track the tasks display post
  private activeSubagents: Map<string, string> = new Map(); // taskId -> postId for subagent status
  private debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  constructor(mattermost: MattermostClient, workingDir: string) {
    this.mattermost = mattermost;
    this.workingDir = workingDir;
    this.claude = new ClaudeCli(workingDir);

    this.claude.on('event', (e: ClaudeEvent) => this.handleEvent(e));
    this.claude.on('exit', (code: number) => this.handleExit(code));

    // Listen for reactions to answer questions
    this.mattermost.on('reaction', (reaction, user) => {
      this.handleReaction(reaction.post_id, reaction.emoji_name, user?.username || 'unknown');
    });
  }

  async startSession(
    options: { prompt: string },
    username: string,
    replyToPostId?: string
  ): Promise<void> {
    // Start Claude if not running
    if (!this.claude.isRunning()) {
      const msg = `🚀 **Session started**\n> Working directory: \`${this.workingDir}\``;
      const post = await this.mattermost.createPost(msg, replyToPostId);
      const threadId = replyToPostId || post.id;
      this.session = { threadId, postId: null, content: '' };
      this.planApproved = false; // Reset for new session
      this.tasksPostId = null; // Reset tasks display
      this.activeSubagents.clear(); // Clear subagent tracking

      try {
        this.claude.start();
      } catch (err) {
        console.error('[Session] Start error:', err);
        await this.mattermost.createPost(`❌ ${err}`, threadId);
        this.session = null;
        return;
      }
    }

    // Send the message and start typing indicator
    this.claude.sendMessage(options.prompt);
    this.startTyping();
  }

  private handleEvent(event: ClaudeEvent): void {
    // Check for special tool uses that need custom handling
    if (event.type === 'assistant') {
      const msg = event.message as { content?: Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }> };
      let hasSpecialTool = false;
      for (const block of msg?.content || []) {
        if (block.type === 'tool_use') {
          if (block.name === 'ExitPlanMode') {
            this.handleExitPlanMode();
            hasSpecialTool = true;
          } else if (block.name === 'TodoWrite') {
            this.handleTodoWrite(block.input as Record<string, unknown>);
            // Don't set hasSpecialTool - let other content through
          } else if (block.name === 'Task') {
            this.handleTaskStart(block.id as string, block.input as Record<string, unknown>);
            // Don't set hasSpecialTool - let other content through
          } else if (block.name === 'AskUserQuestion') {
            this.handleAskUserQuestion(block.id as string, block.input as Record<string, unknown>);
            hasSpecialTool = true;
          }
        }
      }
      // Skip normal output if we handled a special tool (we post it ourselves)
      if (hasSpecialTool) return;
    }

    // Check for tool_result to update subagent status
    if (event.type === 'user') {
      const msg = event.message as { content?: Array<{ type: string; tool_use_id?: string; content?: string }> };
      for (const block of msg?.content || []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const postId = this.activeSubagents.get(block.tool_use_id);
          if (postId) {
            this.handleTaskComplete(block.tool_use_id, postId);
          }
        }
      }
    }

    const formatted = this.formatEvent(event);
    if (this.debug) {
      console.log(`[DEBUG] handleEvent: ${event.type} -> ${formatted ? formatted.substring(0, 100) : '(null)'}`);
    }
    if (formatted) this.appendContent(formatted);
  }

  private async handleTaskComplete(toolUseId: string, postId: string): Promise<void> {
    try {
      await this.mattermost.updatePost(postId,
        this.activeSubagents.has(toolUseId)
          ? `🤖 **Subagent** ✅ *completed*`
          : `🤖 **Subagent** ✅`
      );
      this.activeSubagents.delete(toolUseId);
    } catch (err) {
      console.error('[Session] Failed to update subagent completion:', err);
    }
  }

  private async handleExitPlanMode(): Promise<void> {
    if (!this.session) return;

    // If already approved in this session, auto-continue
    if (this.planApproved) {
      console.log('[Session] Plan already approved, auto-continuing...');
      if (this.claude.isRunning()) {
        this.claude.sendMessage('Continue with the implementation.');
        this.startTyping();
      }
      return;
    }

    // If we already have a pending approval, don't post another one
    if (this.pendingApproval && this.pendingApproval.type === 'plan') {
      console.log('[Session] Plan approval already pending, waiting...');
      return;
    }

    // Flush any pending content first
    await this.flush();
    this.session.postId = null;
    this.session.content = '';

    // Post approval message with reactions
    const message = `✅ **Plan ready for approval**\n\n` +
      `👍 Approve and start building\n` +
      `👎 Request changes\n\n` +
      `*React to respond*`;

    const post = await this.mattermost.createPost(message, this.session.threadId);

    // Add approval reactions
    try {
      await this.mattermost.addReaction(post.id, '+1');
      await this.mattermost.addReaction(post.id, '-1');
    } catch (err) {
      console.error('[Session] Failed to add approval reactions:', err);
    }

    // Track this for reaction handling
    this.pendingApproval = { postId: post.id, type: 'plan' };

    // Stop typing while waiting
    this.stopTyping();
  }

  private async handleTodoWrite(input: Record<string, unknown>): Promise<void> {
    if (!this.session) return;

    const todos = input.todos as Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm: string;
    }>;

    if (!todos || todos.length === 0) {
      // Clear tasks display if empty
      if (this.tasksPostId) {
        try {
          await this.mattermost.updatePost(this.tasksPostId, '📋 ~~Tasks~~ *(completed)*');
        } catch (err) {
          console.error('[Session] Failed to update tasks:', err);
        }
      }
      return;
    }

    // Format tasks nicely
    let message = '📋 **Tasks**\n\n';
    for (const todo of todos) {
      let icon: string;
      let text: string;
      switch (todo.status) {
        case 'completed':
          icon = '✅';
          text = `~~${todo.content}~~`;
          break;
        case 'in_progress':
          icon = '🔄';
          text = `**${todo.activeForm}**`;
          break;
        default: // pending
          icon = '⬜';
          text = todo.content;
      }
      message += `${icon} ${text}\n`;
    }

    // Update or create tasks post
    try {
      if (this.tasksPostId) {
        await this.mattermost.updatePost(this.tasksPostId, message);
      } else {
        const post = await this.mattermost.createPost(message, this.session.threadId);
        this.tasksPostId = post.id;
      }
    } catch (err) {
      console.error('[Session] Failed to update tasks:', err);
    }
  }

  private async handleTaskStart(toolUseId: string, input: Record<string, unknown>): Promise<void> {
    if (!this.session) return;

    const description = input.description as string || 'Working...';
    const subagentType = input.subagent_type as string || 'general';

    // Post subagent status
    const message = `🤖 **Subagent** *(${subagentType})*\n` +
      `> ${description}\n` +
      `⏳ Running...`;

    try {
      const post = await this.mattermost.createPost(message, this.session.threadId);
      this.activeSubagents.set(toolUseId, post.id);
    } catch (err) {
      console.error('[Session] Failed to post subagent status:', err);
    }
  }

  private async handleAskUserQuestion(toolUseId: string, input: Record<string, unknown>): Promise<void> {
    if (!this.session) return;

    // If we already have pending questions, don't start another set
    if (this.pendingQuestionSet) {
      console.log('[Session] Questions already pending, waiting...');
      return;
    }

    // Flush any pending content first
    await this.flush();
    this.session.postId = null;
    this.session.content = '';

    const questions = input.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;

    if (!questions || questions.length === 0) return;

    // Create a new question set - we'll ask one at a time
    this.pendingQuestionSet = {
      toolUseId,
      currentIndex: 0,
      currentPostId: null,
      questions: questions.map(q => ({
        header: q.header,
        question: q.question,
        options: q.options,
        answer: null,
      })),
    };

    // Post the first question
    await this.postCurrentQuestion();

    // Stop typing while waiting for answer
    this.stopTyping();
  }

  private async postCurrentQuestion(): Promise<void> {
    if (!this.session || !this.pendingQuestionSet) return;

    const { currentIndex, questions } = this.pendingQuestionSet;
    if (currentIndex >= questions.length) return;

    const q = questions[currentIndex];
    const total = questions.length;

    // Format the question message - show "Question (1/3)" not the header
    let message = `❓ **Question** *(${currentIndex + 1}/${total})*\n`;
    message += `**${q.header}:** ${q.question}\n\n`;
    for (let i = 0; i < q.options.length && i < 4; i++) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
      message += `${emoji} **${q.options[i].label}**`;
      if (q.options[i].description) {
        message += ` - ${q.options[i].description}`;
      }
      message += '\n';
    }

    // Post the question
    const post = await this.mattermost.createPost(message, this.session.threadId);
    this.pendingQuestionSet.currentPostId = post.id;

    // Add reaction emojis
    for (let i = 0; i < q.options.length && i < 4; i++) {
      try {
        await this.mattermost.addReaction(post.id, REACTION_EMOJIS[i]);
      } catch (err) {
        console.error(`[Session] Failed to add reaction ${REACTION_EMOJIS[i]}:`, err);
      }
    }
  }

  private async handleReaction(postId: string, emojiName: string, username: string): Promise<void> {
    // Check if user is allowed
    if (!this.mattermost.isUserAllowed(username)) return;

    // Handle approval reactions
    if (this.pendingApproval && this.pendingApproval.postId === postId) {
      await this.handleApprovalReaction(emojiName, username);
      return;
    }

    // Handle question reactions - must be for current question
    if (!this.pendingQuestionSet || this.pendingQuestionSet.currentPostId !== postId) return;

    const { currentIndex, questions } = this.pendingQuestionSet;
    const question = questions[currentIndex];
    if (!question) return;

    const optionIndex = EMOJI_TO_INDEX[emojiName];
    if (optionIndex === undefined || optionIndex >= question.options.length) return;

    const selectedOption = question.options[optionIndex];
    question.answer = selectedOption.label;
    console.log(`[Session] User ${username} answered "${question.header}": ${selectedOption.label}`);

    // Update the post to show answer
    try {
      await this.mattermost.updatePost(postId, `✅ **${question.header}**: ${selectedOption.label}`);
    } catch (err) {
      console.error('[Session] Failed to update answered question:', err);
    }

    // Move to next question or finish
    this.pendingQuestionSet.currentIndex++;

    if (this.pendingQuestionSet.currentIndex < questions.length) {
      // Post next question
      await this.postCurrentQuestion();
    } else {
      // All questions answered - send as follow-up message
      // (CLI auto-responds with error to AskUserQuestion, so tool_result won't work)
      let answersText = 'Here are my answers:\n';
      for (const q of questions) {
        answersText += `- **${q.header}**: ${q.answer}\n`;
      }

      console.log(`[Session] All questions answered, sending as message:`, answersText);

      // Clear and send as regular message
      this.pendingQuestionSet = null;

      if (this.claude.isRunning()) {
        this.claude.sendMessage(answersText);
        this.startTyping();
      }
    }
  }

  private async handleApprovalReaction(emojiName: string, username: string): Promise<void> {
    if (!this.pendingApproval) return;

    const isApprove = emojiName === '+1' || emojiName === 'thumbsup';
    const isReject = emojiName === '-1' || emojiName === 'thumbsdown';

    if (!isApprove && !isReject) return;

    const postId = this.pendingApproval.postId;
    console.log(`[Session] User ${username} ${isApprove ? 'approved' : 'rejected'} the plan`);

    // Update the post to show the decision
    try {
      const statusMessage = isApprove
        ? `✅ **Plan approved** by @${username} - starting implementation...`
        : `❌ **Changes requested** by @${username}`;
      await this.mattermost.updatePost(postId, statusMessage);
    } catch (err) {
      console.error('[Session] Failed to update approval post:', err);
    }

    // Clear pending approval and mark as approved
    this.pendingApproval = null;
    if (isApprove) {
      this.planApproved = true;
    }

    // Send response to Claude
    if (this.claude.isRunning()) {
      const response = isApprove
        ? 'Approved. Please proceed with the implementation.'
        : 'Please revise the plan. I would like some changes.';
      this.claude.sendMessage(response);
      this.startTyping();
    }
  }

  private formatEvent(e: ClaudeEvent): string | null {
    switch (e.type) {
      case 'assistant': {
        const msg = e.message as { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown> }> };
        const parts: string[] = [];
        for (const block of msg?.content || []) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            const formatted = this.formatToolUse(block.name, block.input || {});
            if (formatted) parts.push(formatted);
          } else if (block.type === 'thinking' && block.thinking) {
            // Extended thinking - show abbreviated version
            const thinking = block.thinking as string;
            const preview = thinking.length > 100 ? thinking.substring(0, 100) + '...' : thinking;
            parts.push(`💭 *Thinking: ${preview}*`);
          } else if (block.type === 'server_tool_use' && block.name) {
            // Server-managed tools like web search
            parts.push(`🌐 **${block.name}** ${block.input ? JSON.stringify(block.input).substring(0, 50) : ''}`);
          }
        }
        return parts.length > 0 ? parts.join('\n') : null;
      }
      case 'tool_use': {
        const tool = e.tool_use as { name: string; input?: Record<string, unknown> };
        return this.formatToolUse(tool.name, tool.input || {}) || null;
      }
      case 'tool_result': {
        const result = e.tool_result as { is_error?: boolean };
        if (result.is_error) return `  ↳ ❌ Error`;
        return null;
      }
      case 'result': {
        // Response complete - stop typing and start new post for next message
        this.stopTyping();
        if (this.session) {
          this.flush();
          this.session.postId = null;
          this.session.content = '';
        }
        return null;
      }
      case 'system':
        if (e.subtype === 'error') return `❌ ${e.error}`;
        return null;
      default:
        return null;
    }
  }

  private formatToolUse(name: string, input: Record<string, unknown>): string | null {
    const short = (p: string) => {
      const home = process.env.HOME || '';
      return p?.startsWith(home) ? '~' + p.slice(home.length) : p;
    };
    switch (name) {
      case 'Read': return `📄 **Read** \`${short(input.file_path as string)}\``;
      case 'Edit': {
        const filePath = short(input.file_path as string);
        const oldStr = (input.old_string as string || '').trim();
        const newStr = (input.new_string as string || '').trim();

        // Show diff if we have old/new strings
        if (oldStr || newStr) {
          const maxLines = 8;
          const oldLines = oldStr.split('\n').slice(0, maxLines);
          const newLines = newStr.split('\n').slice(0, maxLines);

          let diff = `✏️ **Edit** \`${filePath}\`\n\`\`\`diff\n`;
          for (const line of oldLines) {
            diff += `- ${line}\n`;
          }
          if (oldStr.split('\n').length > maxLines) diff += `- ... (${oldStr.split('\n').length - maxLines} more lines)\n`;
          for (const line of newLines) {
            diff += `+ ${line}\n`;
          }
          if (newStr.split('\n').length > maxLines) diff += `+ ... (${newStr.split('\n').length - maxLines} more lines)\n`;
          diff += '```';
          return diff;
        }
        return `✏️ **Edit** \`${filePath}\``;
      }
      case 'Write': {
        const filePath = short(input.file_path as string);
        const content = input.content as string || '';
        const lineCount = content.split('\n').length;
        return `📝 **Write** \`${filePath}\` *(${lineCount} lines)*`;
      }
      case 'Bash': {
        const cmd = (input.command as string || '').substring(0, 50);
        return `💻 **Bash** \`${cmd}${cmd.length >= 50 ? '...' : ''}\``;
      }
      case 'Glob': return `🔍 **Glob** \`${input.pattern}\``;
      case 'Grep': return `🔎 **Grep** \`${input.pattern}\``;
      case 'Task': return null; // Handled specially with subagent display
      case 'EnterPlanMode': return `📋 **Planning...**`;
      case 'ExitPlanMode': return null; // Handled specially with approval buttons
      case 'AskUserQuestion': return null; // Don't show, the question text follows
      case 'TodoWrite': return null; // Handled specially with task list display
      case 'WebFetch': return `🌐 **Fetching** \`${(input.url as string || '').substring(0, 40)}\``;
      case 'WebSearch': return `🔍 **Searching** \`${input.query}\``;
      default: {
        // Handle MCP tools: mcp__server__tool -> 🔌 tool (server)
        if (name.startsWith('mcp__')) {
          const parts = name.split('__');
          if (parts.length >= 3) {
            const server = parts[1];
            const tool = parts.slice(2).join('__');
            return `🔌 **${tool}** *(${server})*`;
          }
        }
        return `● **${name}**`;
      }
    }
  }

  private appendContent(text: string): void {
    if (!this.session || !text) return;
    this.session.content += text + '\n';
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.flush();
    }, 500);
  }

  private startTyping(): void {
    if (this.typingTimer) return;
    // Send typing immediately, then every 3 seconds
    this.mattermost.sendTyping(this.session?.threadId);
    this.typingTimer = setInterval(() => {
      this.mattermost.sendTyping(this.session?.threadId);
    }, 3000);
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  private async flush(): Promise<void> {
    if (!this.session || !this.session.content.trim()) return;

    const content = this.session.content.replace(/\n{3,}/g, '\n\n').trim();

    if (this.session.postId) {
      await this.mattermost.updatePost(this.session.postId, content);
    } else {
      const post = await this.mattermost.createPost(content, this.session.threadId);
      this.session.postId = post.id;
    }
  }

  private async handleExit(code: number): Promise<void> {
    this.stopTyping();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    await this.flush();

    if (code !== 0 && this.session) {
      await this.mattermost.createPost(`**[Exited: ${code}]**`, this.session.threadId);
    }

    this.session = null;
  }

  isSessionActive(): boolean {
    return this.session !== null;
  }

  isInCurrentSessionThread(threadRoot: string): boolean {
    return this.session?.threadId === threadRoot;
  }

  async sendFollowUp(message: string): Promise<void> {
    if (!this.claude.isRunning() || !this.session) return;
    this.claude.sendMessage(message);
    this.startTyping();
  }

  killSession(): void {
    this.stopTyping();
    this.claude.kill();
    this.session = null;
  }
}
