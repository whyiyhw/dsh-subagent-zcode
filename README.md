# dsh-subagent-zcode

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin bundle that registers a **ZCode one-shot subagent provider**. Delegating to it starts a real ZCode CLI app-server child (ZCode Protocol v1 over stdio) in the parent session's workspace, runs one self-contained task, and returns the child's final assistant answer.

## Requirements

- Node.js ≥ 22 (or ≥ 24), pnpm ≥ 10, and a working `dsh` installation
- A ZCode installation whose CLI bundle can run headless, e.g. macOS: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`; Windows (ZCode desktop): `D:\soft\zcode\resources\glm\zcode.cjs`
- A model provider reachable from `~/.zcode/cli/config.json`. Without it the app-server exits with "Model config is missing" — see [Login and model config](#login-and-model-config) for the exact file shape.

## Install

```sh
dsh plugin --profile <name> add github:whyiyhw/dsh-subagent-zcode
```

Install into an existing, working profile. `plugin add` against a brand-new profile name creates a profile whose bundles list only `@deepseek-ai/dsh-base` plus this plugin — no app layer — so booting it hangs with no consumer for the prompt. If you must start from a fresh profile, first add an app bundle such as `@deepseek-ai/dsh-headless` to `dsh.profile.bundles` in the profile's `package.json` (or boot the profile once before adding the plugin).

pnpm ≥ 10 blocks a git dependency's `prepare` build script until allowed. The first `add` fails; copy the exact key pnpm printed (for this repo it looks like `dsh-subagent-zcode@https://codeload.github.com/...`) into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-subagent-zcode@https://codeload.github.com/whyiyhw/dsh-subagent-zcode/tar.gz/<sha>: true
```

then re-run the `add`. Allowing the build is permission to execute this package's code on your machine at install time — pin a commit for a reproducible install:

```sh
dsh plugin --profile <name> add github:whyiyhw/dsh-subagent-zcode#<sha>
```

## Configure

The bundle registers a dormant provider. Point it at the ZCode CLI bundle and expose the model-facing tool in the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<name>/cordis.patch.yml`, default `$DSH_HOME` = `~/.dsh`). Later layers replace a row's whole config, so restate every field:

```yaml
- id: subagent-zcode
  name: 'dsh-subagent-zcode'
  config:
    cliPath: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
    # providerName: zcode          # registry name on ctx.subagents (default zcode)
    # mode: yolo                   # build | edit | plan | yolo
    # env: {}                      # explicit child environment overlay
    # disposeGraceMs: 3000

- insert:
    - id: tool-subagent-zcode
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: zcode
        toolName: subagent_zcode
        backgroundMode: one-shot
        maxDepth: provider-managed
```

The provider row overrides the entry the bundle itself inserts, so a plain `- id:` patch is correct for it. The tool row creates a **new** entry and must use `- insert:` — a plain `- id:` patch against an id that does not exist yet is a silent no-op and the model never sees the `subagent_zcode` tool.

Verify the layer, then boot:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-subagent-zcode" layer
dsh --profile <name>
```

## Login and model config

The app-server reads only `~/.zcode/cli/config.json`. `zcode login` writes it in the shape below; on machines where login state lives elsewhere the file must be assembled by hand:

- ZCode desktop 3.x stores its provider table in `~/.zcode/v2/config.json` — the CLI never reads that file.
- The CLI file needs a top-level `provider` map (same entry structure as the v2 table: `name`, `kind`, `options.baseURL`, `options.apiKey`, `models`) plus a `model.main` reference in `"provider-id/model"` string form.
- A provider entry with an empty `apiKey: ""` fails validation for the **whole file** (`config.file.invalid` in `~/.zcode/cli/log/zcode-*.jsonl`), leaving the run with "Model config is missing" even though a valid provider is also present. Copy over only the providers that carry a real key.

Minimal working example (BigModel coding plan):

```json
{
  "provider": {
    "builtin:bigmodel-coding-plan": {
      "name": "BigModel - Coding Plan",
      "kind": "anthropic",
      "options": {
        "apiKey": "<key>",
        "baseURL": "https://open.bigmodel.cn/api/anthropic"
      }
    }
  },
  "model": { "main": "builtin:bigmodel-coding-plan/GLM-5.3" }
}
```

Sanity-check the setup before wiring the plugin — a plain headless prompt exercises the same config path:

```sh
node /path/to/zcode.cjs --prompt "Reply with exactly: ZCODE-OK"
```

## What you get

A foreground delegation returns the child's final assistant answer, or an error with the stop reason and a safe failure diagnostic. ZCode's commentary, reasoning, tool activity, raw stderr, and workspace diffs never enter the parent session; child stderr is mirrored to host stderr only.

The provider speaks ZCode Protocol v1 as probed against ZCode CLI 0.16.5. Server-initiated requests that need a human (permission grants, user input, MCP auth) are declined unattended and recorded as diagnostics — the same never-ask policy as the other dsh product subagent providers.

## License

MIT
