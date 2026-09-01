/**
 * Profile-named ZCode one-shot subagent provider. Every accepted run starts a
 * fresh ZCode CLI app-server in the delegating Session's workspace and
 * publishes only after the private session exists and its mode is pinned.
 *
 * @module @deepseek-ai/dsh-subagent-zcode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_ZCODE_SESSION_MODE,
  ZCODE_SESSION_MODES,
  startZcodeRun,
  zcodeAppServerArgv,
  zcodeStartupFailure,
  type ZcodeRunSpec,
  type ZcodeSessionMode,
} from './run.ts'

export const name = 'subagent-zcode'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'zcode'

/** Deployment-owned CLI bundle, mode, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `zcode`). */
  providerName?: string
  /**
   * Absolute path to the ZCode CLI bundle driven as the app-server child
   * (macOS example: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`).
   * Omitted leaves the provider registered but failing every delegation with
   * an actionable startup diagnostic, so the bundle stays installable dormant.
   */
  cliPath?: string
  /** ZCode session mode fixed for this instance (default `yolo`). */
  mode?: ZcodeSessionMode
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  cliPath: z.string().min(1),
  mode: z.union([...ZCODE_SESSION_MODES]).default(DEFAULT_ZCODE_SESSION_MODE),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'cliPath'> & Pick<Config, 'cliPath'>

class ZcodeProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-zcode: no working directory for the child — delegate from a parent session that has one',
      )
    }
    if (this.config.cliPath === undefined) {
      // Provider-authored guidance stays visible; zcodeStartupFailure hides
      // only uncontrolled Host facts.
      throw new Error(
        `subagent-zcode: cliPath is not configured — point it at the ZCode CLI bundle, e.g. ${zcodeAppServerArgv('<zcode.cjs>').join(' ')}`,
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-zcode',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-zcode: request was aborted before app-server startup',
        )
      }
      throw zcodeStartupFailure(error)
    }
    const spec: ZcodeRunSpec = {
      cwd,
      cliPath: this.config.cliPath,
      mode: this.config.mode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-zcode "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startZcodeRun(request, spec)
  }
}

/**
 * Register one Profile-named ZCode provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, CLI bundle path, session mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.cliPath === undefined ? {} : { cliPath: config.cliPath },
    mode: config.mode ?? DEFAULT_ZCODE_SESSION_MODE,
    env: config.env as Record<string, string>,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertPositiveFinite(
    'subagent-zcode',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-zcode: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new ZcodeProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
