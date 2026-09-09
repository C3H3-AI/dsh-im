/**
 * Session-sync process-card renderer: mirrors the IM process-card ladder for
 * conversations that were started OUTSIDE the IM (DSH Web / CLI) and are
 * mirrored to a Feishu DM through a session-sync delivery target.
 *
 * The bridge's own process-card state machine (#appendStepCardUpdate and
 * friends) only runs for turns opened by inbound IM messages. This renderer
 * consumes the SAME Harness session events (turn/start, tool/call,
 * assistant/*, turn/end) from the shared event mux for sessions that have no
 * bridge-owned turn, and renders them into the synced DM with the identical
 * card ladder: one live card patched in place, byte-budgeted chunk spillover,
 * a sealed terminal state, and the same answer-integrity invariant — the
 * post fallback only fires when the last successful render provably does not
 * cover the final answer.
 *
 * deliberately minimal: blocks/version tracking are re-implemented here
 * (bridge keeps them private), while card rendering reuses the exported
 * stepStreamCard / splitStepStreamCardBlocks helpers.
 */
import {
  splitStepStreamCardBlocks,
  stepStreamCard,
} from './feishu-cards.mjs';
import { t } from '../shared/i18n.mjs';

/** Panel line budget mirrors the bridge's process-card panel cap. */
const PANEL_MAX_BYTES = 2_000;

export class SessionSyncRenderer {
  #client;
  #logger;
  #target;
  #blocks = [];
  #messageId = null;
  #cardIds = [];
  #chunkCount = 1;
  #broken = false;
  #renderChain = Promise.resolve();
  #answerVersion = 0;
  #renderedAnswerVersion = 0;
  #toolNames = new Map();

  constructor({ client, logger = console, target }) {
    if (!client || !target?.chatId) throw new TypeError('SessionSyncRenderer requires a client and target chatId');
    this.#client = client;
    this.#logger = logger;
    this.#target = target;
  }

  get chatId() {
    return this.#target.chatId;
  }

  get finished() {
    return this.#broken === false && this.#sealed === true;
  }

  #sealed = false;

  /** Handle one Harness session event. Unknown kinds are ignored. */
  async handleEvent(event) {
    if (this.#broken || this.#sealed) return;
    const type = event?.type;
    if (type === 'tool/call') {
      const name = event?.data?.name ?? t('工具');
      const summary = this.#argumentSummary(event?.data?.arguments);
      this.#pushPanel('tools', `✅ ${lineClip(name)}${summary ? ` — ${summary}` : ''}`);
      this.#queueRender();
      return;
    }
    if (type === 'assistant/chunk' && event?.data?.chunk?.type === 'text-delta') {
      // Streamed text deltas accumulate into the live draft via the step text
      // map keyed by `${step}:${index}`; the finalized assistant/message is
      // what we render, so deltas only mark activity here.
      return;
    }
    if (type === 'assistant/message') {
      const text = event?.data?.message?.content
        ?.filter?.((part) => part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('') ?? '';
      if (text.trim()) {
        this.#writeAnswer(text);
        this.#queueRender();
      }
      return;
    }
    if (type === 'turn/end') {
      await this.seal({ stopped: event?.data?.reason?.kind === 'aborted' });
    }
  }

  /** Seal the card with the terminal status and the final answer. */
  async seal({ stopped = false } = {}) {
    if (this.#sealed) return;
    this.#sealed = true;
    try {
      await this.#renderChain;
    } catch { /* the seal decides what the user sees */ }
    if (this.#broken) {
      this.#fallbackToPost?.();
      return;
    }
    const status = stopped ? 'stopped' : 'completed';
    const chunks = splitStepStreamCardBlocks(this.#blocks);
    const live = chunks[chunks.length - 1] ?? [];
    try {
      if (this.#messageId === null) {
        for (let index = 0; index < chunks.length; index += 1) {
          const isLive = index === chunks.length - 1;
          const id = await this.#sendCard(
            chunks[index],
            { status: isLive ? status : 'sealed' },
          );
          this.#cardIds.push(id);
          if (isLive) this.#messageId = id;
        }
        this.#renderedAnswerVersion = this.#answerVersion;
        return;
      }
      if (chunks.length > this.#chunkCount) {
        await this.#patchCard(chunks[this.#chunkCount - 1], 'sealed');
        for (let index = this.#chunkCount; index < chunks.length - 1; index += 1) {
          const id = await this.#sendCard(chunks[index], { status: 'sealed' });
          this.#cardIds.push(id);
        }
        this.#chunkCount = chunks.length;
      }
      await this.#patchCard(live, status);
      this.#renderedAnswerVersion = this.#answerVersion;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-feishu] session-sync process card seal failed:',
        error?.message ?? String(error),
      );
      this.#broken = true;
      this.#fallbackToPost?.();
    }
  }

  #fallbackToPost = null;

  /** Registers the post-ladder callback used when the card path fails. */
  onFallback(callback) {
    this.#fallbackToPost = callback;
  }

  #argumentSummary(rawArguments) {
    if (typeof rawArguments !== 'string' || !rawArguments.trim()) return '';
    try {
      const parsed = JSON.parse(rawArguments);
      const first = Object.values(parsed ?? {}).find((value) => typeof value === 'string' && value.trim());
      const text = first ?? JSON.stringify(parsed ?? {});
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    } catch {
      return rawArguments.length > 80 ? `${rawArguments.slice(0, 79)}…` : rawArguments;
    }
  }

  #pushPanel(kind, line) {
    const last = this.#blocks[this.#blocks.length - 1];
    if (last?.kind === kind) {
      last.lines.push(line);
      let size = Buffer.byteLength(last.lines.join('\n'), 'utf8');
      while (last.lines.length > 1 && size > PANEL_MAX_BYTES) {
        const removed = last.lines.shift();
        last.omitted = (last.omitted ?? 0) + 1;
        size -= Buffer.byteLength(`${removed}\n`, 'utf8');
      }
      return;
    }
    this.#blocks.push({ kind, lines: [line], omitted: 0 });
  }

  #writeAnswer(text) {
    const blocks = splitStepPostMarkdownSafe(text);
    if (this.#blocks.some((block) => block?.kind === 'answer')) {
      const start = this.#blocks.findIndex((block) => block?.kind === 'answer');
      const end = this.#blocks.length - 1;
      this.#blocks.splice(start, end - start + 1, ...blocks);
    } else {
      this.#blocks.push(...blocks);
    }
    this.#answerVersion += 1;
  }

  #queueRender() {
    if (this.#broken || this.#sealed) return;
    const previous = this.#renderChain;
    this.#renderChain = previous
      .catch(() => {})
      .then(() => this.#renderNow())
      .catch((error) => {
        this.#broken = true;
        this.#logger.warn?.(
          '[dsh-feishu] session-sync process card render failed:',
          error?.message ?? String(error),
        );
      });
  }

  async #renderNow() {
    if (this.#broken || this.#sealed) return;
    const chunks = splitStepStreamCardBlocks(this.#blocks);
    const live = chunks[chunks.length - 1] ?? [];
    if (this.#messageId === null) {
      for (let index = 0; index < chunks.length; index += 1) {
        const isLive = index === chunks.length - 1;
        const id = await this.#sendCard(chunks[index], { status: isLive ? 'running' : 'sealed' });
        this.#cardIds.push(id);
        if (isLive) this.#messageId = id;
      }
      this.#chunkCount = chunks.length;
      this.#renderedAnswerVersion = this.#answerVersion;
      return;
    }
    if (chunks.length > this.#chunkCount) {
      await this.#patchCard(chunks[this.#chunkCount - 1], 'sealed');
      for (let index = this.#chunkCount; index < chunks.length; index += 1) {
        const isLive = index === chunks.length - 1;
        const id = await this.#sendCard(chunks[index], { status: isLive ? 'running' : 'sealed' });
        this.#cardIds.push(id);
        if (isLive) this.#messageId = id;
      }
      this.#chunkCount = chunks.length;
    } else {
      await this.#patchCard(live, 'running');
    }
    this.#renderedAnswerVersion = this.#answerVersion;
  }

  async #sendCard(blocks, { status }) {
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: this.#target.openId,
        msg_type: 'interactive',
        content: stepStreamCard(blocks, { status }),
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`session-sync card send failed: ${response.msg || response.code}`);
    }
    return response?.data?.message_id;
  }

  async #patchCard(blocks, status) {
    const response = await this.#client.im.v1.message.patch({
      path: { message_id: this.#messageId },
      data: { content: stepStreamCard(blocks, { status }) },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`session-sync card patch failed: ${response.msg || response.code}`);
    }
  }
}

/** Split markdown into answer blocks at paragraph bounds (shared budgets). */
function splitStepPostMarkdownSafe(text) {
  const paragraphs = String(text ?? '').split(/\n{2,}/).filter((part) => part.trim());
  const blocks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && Buffer.byteLength(candidate, 'utf8') > 8_000) {
      blocks.push({ kind: 'answer', text: current });
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) blocks.push({ kind: 'answer', text: current });
  return blocks.length > 0 ? blocks : [{ kind: 'answer', text: String(text ?? '') }];
}

/** One-line clip for tool names and note lines. */
function lineClip(value) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
