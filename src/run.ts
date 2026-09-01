/**
 * One-shot ZCode child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after session creation and mode selection,
 * flatten post-publication failures, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-zcode/run
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { ZcodeAppServerWire, type ZcodeWireFailureFacts } from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** ZCode CLI session modes the provider may pin for unattended runs. */
export type ZcodeSessionMode = 'build' | 'edit' | 'plan' | 'yolo'

/** Every accepted {@link ZcodeSessionMode}, for config validation. */
export const ZCODE_SESSION_MODES = [
  'build',
  'edit',
  'plan',
  'yolo',
] as const satisfies readonly ZcodeSessionMode[]

/** Unattended default mirroring the ZCode CLI's own headless `--prompt` default. */
export const DEFAULT_ZCODE_SESSION_MODE: ZcodeSessionMode = 'yolo'

type ZcodeFailureStage =
  | 'create'
  | ZcodeWireFailureFacts['stage']
  | 'process'
  | 'teardown'

type ZcodeFailureCategory = ZcodeWireFailureFacts['category'] | 'process'

interface ZcodeFailureFacts {
  readonly stage: ZcodeFailureStage
  readonly category: ZcodeFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: ZcodeFailureFacts): string {
  const fields = [
    'product: ZCode',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class ZcodeRunFailure extends Error {
  constructor(
    readonly facts: ZcodeFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-zcode: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ZcodeRunFailure'
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function zcodeStartupFailure(cause: unknown): Error {
  return new ZcodeRunFailure({
    stage: 'create',
    category: 'unknown',
  }, cause)
}

/**
 * The fixed app-server command for a configured ZCode CLI bundle.
 * @param cliPath - absolute or resolvable path to the ZCode `zcode.cjs` bundle.
 * @returns Node, the bundle, and the fixed app-server arguments.
 */
export function zcodeAppServerArgv(cliPath: string): string[] {
  return [process.execPath, cliPath, 'app-server', '--stdio']
}

/** Fully resolved inputs for one ZCode app-server run. */
export interface ZcodeRunSpec {
  /** Parent Session workspace, also supplied to `session/create`. */
  readonly cwd: string
  /** Absolute path to the ZCode CLI bundle the deployment wants driven. */
  readonly cliPath: string
  /** Profile-selected unattended session mode. */
  readonly mode: ZcodeSessionMode
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-zcode: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-zcode: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-zcode: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed process tree, and wait for the
 * subprocess owner to prove it is gone.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeZcodeChild(
  wire: ZcodeAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()

  if (child.pid > 0) {
    let outcome: SubprocessOutcome | undefined
    void child.done.then(
      (value) => { outcome = value },
      /* v8 ignore next -- a positive pid excludes spawn-level done rejection. */
      () => {},
    )
    try {
      child.stdin?.end()
    } catch {
      // A concurrently closed stdin does not change tree ownership below.
    }
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      throw new ZcodeRunFailure({
        stage: 'teardown',
        category: 'unknown',
        outcome,
      }, thrown(error))
    }
    await child.done
  } else {
    await child.done.catch(() => {})
  }
}

/**
 * Start the real `zcode app-server --stdio` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, CLI bundle, mode, process service, and diagnostic policy.
 * @returns the published run after session creation and mode selection.
 */
export async function startZcodeRun(
  request: SubagentStartRequest,
  spec: ZcodeRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-zcode: request was aborted before app-server startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: zcodeAppServerArgv(spec.cliPath),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new ZcodeRunFailure({
      stage: 'create',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new ZcodeAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    spec.mode,
  )
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    try {
      await disposeZcodeChild(wire, child)
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts: ZcodeFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new ZcodeRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new ZcodeRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-zcode: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    wire.start()
    await Promise.race([wire.createSession(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof ZcodeRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    const failure = new ZcodeRunFailure({
      stage: 'create',
      category: 'unknown',
      outcome: error instanceof ZcodeRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-zcode: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-zcode: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: ZcodeFailureFacts): string => {
    const failure = failureDiagnostic(facts)
    const unattended = wire.collectDiagnostic()
    diagnostic = unattended === undefined
      ? failure
      : `${failure}\n${unattended}`
    return diagnostic
  }
  const withProcessOutcome = (facts: ZcodeFailureFacts): ZcodeFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // Frames already queued by the exiting app-server remain authoritative.
      // One I/O turn lets them settle before process exit ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTask(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // Let stderr already queued with the terminal frame reach the Host
        // before the non-completed result settles.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // The wire failure remains authoritative when exit observation fails.
          }
        }
        const facts = error instanceof ZcodeRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof ZcodeRunFailure
          ? error
          : new ZcodeRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
