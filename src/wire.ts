/**
 * Minimal ZCode Protocol v1 app-server adapter. The protocol is line-delimited
 * JSON shaped like JSON-RPC 2.0 minus the `jsonrpc` envelope member, so this
 * module owns its own line transport instead of the shared SDK one. Product
 * facts owned here: the session create/mode/send/messages lifecycle, the
 * runtime-preferences handshake, unattended answers for every other
 * server-initiated request, and final-answer selection.
 *
 * @module @deepseek-ai/dsh-subagent-zcode/wire
 */

import type { Readable, Writable } from 'node:stream'
import { basename } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ZcodeSessionMode } from './run.ts'

type JsonObject = Record<string, unknown>

/** Product facts owned by the ZCode wire after publication. */
export interface ZcodeWireFailureFacts {
  readonly stage: 'send' | 'turn' | 'messages'
  readonly category:
    | 'service'
    | 'transport'
    | 'product-error'
    | 'invalid-result'
    | 'unknown'
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-zcode: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`subagent-zcode: app-server returned invalid ${label}`)
  }
  return value
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-zcode: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/**
 * The ZCode wire's private line transport: newline-delimited JSON frames
 * without the JSON-RPC 2.0 `jsonrpc` member, numeric client request ids, and
 * opaque server request ids echoed verbatim.
 */
class ZcodeLineTransport {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private buffer = ''
  private started = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onRequest: (id: unknown, method: string, params: JsonObject) => void,
    private readonly onNotification: (method: string, params: JsonObject) => void,
    private readonly onParseError: (error: Error) => void,
  ) {}

  /** Begin consuming input frames; attach nothing before this call. */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.setEncoding('utf8')
    this.input.on('data', this.onData)
  }

  /**
   * Send a request and await its response or error.
   * @param method - product method name.
   * @param params - request parameters.
   * @returns the response's `result` member.
   */
  request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => { resolve(object(value, `${method} response`)) },
        reject,
      })
    })
    this.write({ id, method, params })
    return response
  }

  /** Answer a server-initiated request with a result. */
  respond(id: unknown, result: unknown): void {
    this.write({ id, result })
  }

  /** Answer a server-initiated request by declining it. */
  decline(id: unknown, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }

  /** Detach listeners and reject outstanding requests. Idempotent. */
  close(): void {
    this.input.off('data', this.onData)
    for (const pending of this.pending.values()) {
      pending.reject(new Error('subagent-zcode: app-server protocol stream closed'))
    }
    this.pending.clear()
  }

  private write(frame: JsonObject): void {
    this.output.write(`${JSON.stringify(frame)}\n`)
  }

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch (error: unknown) {
        this.onParseError(thrown(error))
        return
      }
      this.dispatch(object(frame, 'message'))
    }
  }

  private dispatch(frame: JsonObject): void {
    const hasMethod = frame.method !== undefined
    const hasId = frame.id !== undefined
    if (hasMethod && hasId) {
      this.onRequest(
        frame.id,
        string(frame.method, 'server request method'),
        frame.params === undefined ? {} : object(frame.params, 'server request params'),
      )
      return
    }
    if (hasMethod) {
      this.onNotification(
        string(frame.method, 'notification method'),
        frame.params === undefined ? {} : object(frame.params, 'notification params'),
      )
      return
    }
    if (hasId) {
      const pending = this.pending.get(frame.id as number)
      if (pending === undefined) return
      this.pending.delete(frame.id as number)
      const error = frame.error
      if (error !== undefined) {
        const fields = object(error, 'error')
        pending.reject(
          new Error(`subagent-zcode: app-server request failed: ${String(fields.message)}`),
        )
        return
      }
      pending.resolve(frame.result ?? {})
      return
    }
    this.onParseError(new Error('subagent-zcode: app-server frame carried neither method nor id'))
  }
}

/**
 * One ZCode app-server connection and its single one-shot session. The class
 * deliberately exposes no generic request surface: supporting another product
 * method must first become part of the provider contract.
 */
export class ZcodeAppServerWire {
  private readonly transport: ZcodeLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private sessionId: string | undefined
  private readonly turnTerminal = Promise.withResolvers<{
    readonly status: string
    readonly turnId: string | undefined
  }>()
  private lastAssistantText: string | undefined
  private diagnostic: string | undefined
  private failure: ZcodeWireFailureFacts | undefined
  private inputEnded = false
  private terminalObserved = false
  private closed = false

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly mode: ZcodeSessionMode,
  ) {
    this.transport = new ZcodeLineTransport(
      input,
      output,
      (id, method, params) => { this.handleServerRequest(id, method, params) },
      (method, params) => { this.handleNotification(method, params) },
      (error) => { this.fail(error) },
    )
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.input.on('end', this.onInputEnd)
    this.input.on('error', this.onInputError)
    // Pipe errors can race protocol closure and process teardown. Retain the
    // error listener for the lifetime of the per-run stream so no late EPIPE
    // becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Whether protocol output ended before a terminal turn notification.
   * @returns `true` only for an early protocol close without a terminal.
   */
  endedBeforeTerminal(): boolean {
    return this.inputEnded && !this.terminalObserved
  }

  /**
   * Create the run's private session and pin the unattended mode. The
   * app-server gates `session/create` on a runtime-preferences request that
   * this wire answers from construction.
   * @param cwd - parent Session workspace.
   * @param signal - unpublished-start cancellation.
   */
  async createSession(cwd: string, signal: AbortSignal): Promise<void> {
    const response = await this.guarded(
      this.transport.request('session/create', {
        workspace: { workspacePath: cwd, workspaceKey: basename(cwd) },
      }),
      signal,
    )
    const session = object(response.session, 'session/create session')
    this.sessionId = string(session.sessionId, 'session/create session id')
    await this.guarded(
      this.transport.request('session/setMode', {
        sessionId: this.sessionId,
        mode: this.mode,
      }),
      signal,
    )
  }

  /**
   * Submit the one text-only task, await its authoritative terminal telemetry
   * event, and select the final assistant answer from the session transcript.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @returns the shared subagent result.
   */
  async runTask(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const sessionId = this.sessionId as string
    const accepted = await this.guarded(
      this.transport.request('session/send', {
        sessionId,
        content: texts.join('\n\n'),
      }),
      signal,
    )
    if (accepted.accepted !== true) {
      this.recordFailure({ stage: 'send', category: 'unknown' })
      throw new Error('subagent-zcode: app-server did not accept the task')
    }
    const terminal = await this.guarded(this.turnTerminal.promise, signal)
    if (terminal.status !== 'success') {
      this.recordFailure({ stage: 'turn', category: 'unknown' })
      if (terminal.status === 'cancelled') {
        // The transcript pull is best-effort on a cancelled turn: a session
        // already torn down leaves the run with whatever output was observed.
        try {
          await this.collectAnswer(sessionId, terminal.turnId, signal)
        } catch {
          // The cancelled terminal, not the transcript snapshot, settles the run.
        }
        return { output: this.collectOutput(), stopReason: 'aborted' }
      }
      throw new Error(`subagent-zcode: ZCode turn ended with status ${terminal.status}`)
    }
    const output = await this.collectAnswer(sessionId, terminal.turnId, signal)
    if (output.length === 0) {
      this.recordFailure({ stage: 'messages', category: 'invalid-result' })
      throw new Error('subagent-zcode: ZCode completed without a final answer')
    }
    return { output, stopReason: 'completed' }
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.sessionId === undefined || this.closed) return
    void this.transport.request('session/stop', { sessionId: this.sessionId })
      .catch(() => {})
  }

  /**
   * The best assistant answer observed for this run, preserving exact bytes.
   * @returns the selected final text block, when the transcript offered one.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastAssistantText
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /**
   * The latest safe unattended-decision fact observed for this run.
   * @returns provider-authored diagnostic text, when one was observed.
   */
  collectDiagnostic(): string | undefined {
    return this.diagnostic
  }

  /**
   * The structured failure fact observed for this published task.
   * Call only after a non-completed return or rejection from {@link runTask}.
   * @returns the fixed stage/category pair, defaulting to an unobserved turn.
   */
  collectFailure(): ZcodeWireFailureFacts {
    return this.failure ?? { stage: 'turn', category: 'unknown' }
  }

  /** Detach protocol listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async collectAnswer(
    sessionId: string,
    turnId: string | undefined,
    signal: AbortSignal,
  ): Promise<ContentBlock[]> {
    const response = await this.guarded(
      this.transport.request('session/messages', { sessionId }),
      signal,
    )
    const messages = response.messages
    if (!Array.isArray(messages)) {
      throw new Error('subagent-zcode: app-server returned invalid session/messages')
    }
    let fallback: string | undefined
    for (const message of messages) {
      const record = object(message, 'session/messages message')
      const info = object(record.info, 'message info')
      if (info.role !== 'assistant') continue
      const anchorTurnId = info.anchor === undefined
        ? undefined
        : object(info.anchor, 'message anchor').turnId
      if (!Array.isArray(record.parts)) continue
      const text = record.parts
        .map(part => object(part, 'message part'))
        .filter(part => part.type === 'text')
        .map(part => string(part.text, 'message text'))
        .join('\n')
      if (text.trim().length === 0) continue
      if (turnId !== undefined && anchorTurnId === turnId) {
        this.lastAssistantText = text
        return this.collectOutput()
      }
      fallback = text
    }
    this.lastAssistantText = fallback
    return this.collectOutput()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.inputEnded = true
    this.fail(new Error('subagent-zcode: app-server protocol stream closed'))
  }

  private recordFailure(facts: ZcodeWireFailureFacts): void {
    this.failure = facts
  }

  private handleServerRequest(id: unknown, method: string, params: JsonObject): void {
    if (method === 'session/requestRuntimePreferences') {
      const sessionId = params.sessionId
      if (this.sessionId !== undefined && sessionId !== this.sessionId) {
        this.transport.decline(id, 'subagent-zcode: preferences requested for another session')
        return
      }
      this.transport.respond(id, { nativeSearchEnhancementsEnabled: false })
      return
    }
    this.diagnostic = `ZCode unattended decision (mode: ${this.mode}; request: ${method}): the provider does not answer interactive requests`
    this.transport.decline(id, `subagent-zcode: no unattended answer for ${method}`)
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method !== 'v4/telemetry/event') return
    if (params.kind !== 'turn.terminal') return
    const sessionId = params.sessionId
    if (this.sessionId !== undefined && sessionId !== this.sessionId) return
    this.terminalObserved = true
    this.turnTerminal.resolve({
      status: string(params.status, 'turn.terminal status'),
      turnId: params.turnId === undefined
        ? undefined
        : string(params.turnId, 'turn.terminal turn id'),
    })
  }
}
