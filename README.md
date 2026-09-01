# dsh-subagent-zcode

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin bundle that registers a **ZCode one-shot subagent provider**. Delegating to it starts a real ZCode CLI app-server child (ZCode Protocol v1 over stdio) in the parent session's workspace, runs one self-contained task, and returns the child's final assistant answer.

## Requirements

- Node.js ≥ 22 (or ≥ 24), pnpm ≥ 10, and a working `dsh` installation
- A ZCode installation whose CLI bundle can run headless, e.g. macOS: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
- ZCode login completed on the machine: `~/.zcode/cli/config.json` must declare an explicit model provider (the shape `zcode login` writes). Without it the app-server exits with "Model config is missing".

## Install

```sh
dsh plugin --profile <name> add github:whyiyhw/dsh-subagent-zcode
```

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

- id: tool-subagent-zcode
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: zcode
    toolName: subagent_zcode
    backgroundMode: one-shot
    maxDepth: provider-managed
```

Verify the layer, then boot:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-subagent-zcode" layer
dsh --profile <name>
```

## What you get

A foreground delegation returns the child's final assistant answer, or an error with the stop reason and a safe failure diagnostic. ZCode's commentary, reasoning, tool activity, raw stderr, and workspace diffs never enter the parent session; child stderr is mirrored to host stderr only.

The provider speaks ZCode Protocol v1 as probed against ZCode CLI 0.16.5. Server-initiated requests that need a human (permission grants, user input, MCP auth) are declined unattended and recorded as diagnostics — the same never-ask policy as the other dsh product subagent providers.

## License

MIT
