/**
 * wizardClient.js — the wizard's mouth: everything that talks to the network.
 *
 * Split from wizard.js (which stays pure and unit-tested) so the SDK, the API
 * key and the streaming loop live in exactly one place.
 *
 * KEY HANDLING — read this before changing it. The key is the player's own,
 * pasted into the UI at runtime, held in React state for the session only. It
 * is never written to localStorage, never sent to our server, and never put in
 * a URL. The browser talks to api.anthropic.com directly, which needs
 * `dangerouslyAllowBrowser: true`; the SDK disables browser use by default
 * precisely because the key is then visible to anything running on the page.
 *
 * That is a deliberate trade. The alternative — our key in .env behind an
 * /api/anthropic proxy, like Greptile — would make the deployed site an
 * unauthenticated relay that spends the repo owner's money on arbitrary
 * prompts, since none of the existing proxies authenticate callers. Here the
 * only key at risk is the one its owner pasted in, on their own machine.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { buildSystemPrompt, createWizardTools, trimHistory } from './wizard.js';

/** Sonnet 5 — fast enough to feel like conversation, sharp enough to read code. */
export const WIZARD_MODEL = 'claude-sonnet-5';

/** NPC replies are short by design; this is a cost ceiling, not a target. */
const MAX_TOKENS = 2048;

/** Effort trades latency against depth. 'low' keeps the wizard conversational;
 *  raise to 'medium'/'high' if you want it to reason harder about code. */
const EFFORT = 'low';

/** A single question must not turn into a 30-tool-call research project. */
const MAX_ITERATIONS = 8;

/** Keep the transcript bounded — this is a game chat, not a research session. */
const MAX_HISTORY_MESSAGES = 40;

export class WizardError extends Error {
  constructor(message, { kind = 'unknown', cause = null } = {}) {
    super(message);
    this.name = 'WizardError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** Turn an SDK error into something a wizard can say out loud. */
function describeError(err) {
  if (err?.name === 'AbortError') return new WizardError('Interrupted.', { kind: 'aborted', cause: err });
  if (err instanceof Anthropic.AuthenticationError) {
    return new WizardError('That API key was rejected. Check it and try again.', { kind: 'auth', cause: err });
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new WizardError('That key is not allowed to use this model.', { kind: 'auth', cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new WizardError('Rate limited — wait a moment and ask again.', { kind: 'rate_limit', cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new WizardError('Could not reach Anthropic. Check your connection.', { kind: 'network', cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    if (/anthropic-workspace-id/i.test(err.message || '')) {
      return new WizardError(
        'That key is identity-linked, so it must name a workspace. Add your workspace ID below and try again.',
        { kind: 'workspace', cause: err }
      );
    }
    return new WizardError(`The API returned ${err.status}: ${err.message}`, { kind: 'api', cause: err });
  }
  return new WizardError(err?.message || 'Something went wrong.', { kind: 'unknown', cause: err });
}

/**
 * A conversation with the wizard. Owns the transcript and the SDK client.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey            the player's Anthropic key
 * @param {string} [opts.model]
 * @param {() => Object} opts.getWorld    live WorldData (it is republished during load)
 * @param {() => Object} opts.getChase
 * @param {() => Object} opts.getPlayer
 * @param {(path:string) => Promise<string>} opts.readFile
 * @param {Object} opts.control           wizard body control
 */
export function createWizardSession({
  apiKey,
  workspaceId = null,
  model = WIZARD_MODEL,
  getWorld,
  getChase,
  getPlayer,
  readFile,
  control,
}) {
  if (!apiKey) throw new WizardError('An Anthropic API key is required.', { kind: 'auth' });

  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 1, // a game chat should fail fast, not hang retrying
    // Personal and service-account keys that can see more than one workspace are
    // "identity-linked" and the API rejects them with a 400 unless the request
    // names the workspace it acts in. Plain workspace keys need no such header,
    // so this is only sent when the player supplies one.
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });

  // Tool definitions are pure (wizard.js); betaTool only wraps them so the SDK
  // can validate inputs and run the loop.
  const tools = createWizardTools({ getWorld, getChase, getPlayer, readFile, control }).map((t) =>
    betaTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      run: t.run,
    })
  );

  /** @type {Array} full transcript, rebuilt after every turn from the runner */
  let messages = [];
  let systemPrompt = null;

  return {
    get history() {
      return messages;
    },

    reset() {
      messages = [];
      systemPrompt = null;
    },

    /**
     * Ask the wizard something.
     *
     * @param {string} text
     * @param {Object} handlers
     * @param {(chunk:string) => void} handlers.onText   streamed reply text
     * @param {(name:string) => void} handlers.onToolCall fired as each tool starts
     * @param {AbortSignal} handlers.signal
     * @returns {Promise<string>} the complete reply text
     */
    async send(text, { onText = () => {}, onToolCall = () => {}, signal = null } = {}) {
      // The system prompt is built once per conversation and then held byte-stable
      // so it can be prompt-cached: the world keeps getting republished during
      // load, and rebuilding this every turn would invalidate the cache each time.
      if (systemPrompt == null) systemPrompt = buildSystemPrompt(getWorld?.());

      messages = trimHistory([...messages, { role: 'user', content: String(text) }], MAX_HISTORY_MESSAGES);

      let reply = '';
      try {
        const runner = client.beta.messages.toolRunner(
          {
            model,
            max_tokens: MAX_TOKENS,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            output_config: { effort: EFFORT },
            messages,
            tools,
            max_iterations: MAX_ITERATIONS,
            stream: true,
          },
          signal ? { signal } : undefined
        );

        // Outer loop: one iteration per assistant turn (a tool call starts another).
        for await (const messageStream of runner) {
          for await (const event of messageStream) {
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              onToolCall(event.content_block.name);
            } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              reply += event.delta.text;
              onText(event.delta.text);
            }
          }
        }

        const final = await runner.done();
        if (final?.stop_reason === 'refusal') {
          throw new WizardError('The wizard declined to answer that.', { kind: 'refusal' });
        }
        // Adopt the runner's transcript: it contains the assistant turns and every
        // tool_use/tool_result pair, which must stay paired for the next request.
        const runParams = runner.params;
        if (Array.isArray(runParams?.messages)) messages = [...runParams.messages];
        // The runner may or may not have appended the closing assistant turn
        // (it only needs to when another request follows). Append it only if the
        // transcript does not already end with one — a duplicated assistant turn
        // would be replayed to the model on the next question.
        if (final?.content && messages[messages.length - 1]?.role !== 'assistant') {
          messages = [...messages, { role: 'assistant', content: final.content }];
        }
        return reply;
      } catch (err) {
        if (err instanceof WizardError) throw err;
        throw describeError(err);
      }
    },
  };
}

/** Shape check only — a real check costs a request, so let the first message fail loudly. */
export function looksLikeApiKey(value) {
  return typeof value === 'string' && /^sk-ant-[A-Za-z0-9_-]{10,}$/.test(value.trim());
}
