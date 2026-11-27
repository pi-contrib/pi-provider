# Pi Provider

> Decision models missing from Pi's built-in provider catalogs.

[![CI](https://github.com/pi-contrib/pi-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/pi-contrib/pi-provider/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pi-contrib/pi-provider)](https://github.com/pi-contrib/pi-provider/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What it adds

Pi Provider currently registers three **text-only classifiers** under `opencode-go-classifiers`, using the OpenCode Go subscription's System One endpoint:

| ID | Context window |
| --- | ---: |
| `jev-1.14` | 32,000 |
| `gemini-decision-1` | 262,144 |
| `gpt-6-luna-decision` | 1,050,000 |

These decision models are used by codemode and other consumers of Pi's model registry. They are **not chat models**: they do not appear in `/model`, and this extension does not alter the built-in `opencode-go` provider or its chat models. Future missing-model integrations can live in separate modules; no other providers are included yet. The catalog reports zero cost because subscription pricing per model is not specified; **zero is an accounting placeholder, not a promise of free usage**. Availability and model access depend on your OpenCode Go subscription.

## Requirements and installation

- Pi 1.6.0 or newer with codemode enabled for the examples below; Node.js 22.19+.
- An OpenCode Go subscription and a usable OpenCode API key.

Install directly from GitHub (no npm registry login):

```sh
pi install git:github.com/pi-contrib/pi-provider
```

Or, after configuring npm authentication for `npm.pkg.github.com` and the `@pi-contrib` scope:

```sh
pi install npm:@pi-contrib/pi-provider
```

For reproducible installs, pin a GitHub release tag or package version. Restart Pi or run `/reload`.

### Credentials

The extension checks, in order:

1. A separately stored key from `/login` → `opencode-go-classifiers` (use `/logout` for that provider to remove it).
2. `OPENCODE_API_KEY` from the environment.
3. The key stored for Pi's existing `opencode-go` provider (`/login` → `opencode-go`), resolved via `pi auth print-api-key --provider opencode-go`.

No credential is copied into the extension's package, and inherited keys are not cached. The `pi` executable must be on `PATH` to inherit a stored Go credential. If the provider is unavailable, sign into OpenCode Go or set the environment variable; `/login` for `opencode-go-classifiers` also accepts an explicit key. Treat installed extensions as trusted code because they can access credentials.

### Use with codemode

Enable codemode if it is not already available by adding `"defaultTools": ["+codemode"]` to Pi's settings. In a codemode script:

```js
const candidates = await models.getAvailableOfType("classifier", "opencode-go-classifiers");
const model = candidates.find((item) => item.id === "jev-1.14");
if (!model) throw new Error("OpenCode Go classifier unavailable: check your key and subscription");
const result = await models.classify(model, {
  state: { message: "The fix works, thanks!" },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the fix?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.stopReason === "stop" ? result.answers : result.errorMessage;
```

To see the registered catalog even without credentials, use `models.getModelsOfType("classifier", "opencode-go-classifiers")`. Input images are not supported. The extension translates Pi's boolean question type to System One's `noul` wire type. Errors are returned with `stopReason: "error"` or `"aborted"`, not thrown by the classifier.

## Development

Use Node.js 22 locally or `nix develop`:

```sh
npm ci --ignore-scripts
npm run check
npm run lint
npm test
npm pack --dry-run
pi -e ./src/index.ts
```

Run `npm run format` to apply Biome formatting. For an integration test, provide a valid key, run the codemode example, and verify that `opencode-go` chat selection still works. Automated tests mock HTTP and never need a subscription.

Release Please opens release PRs; merging one tags a release and publishes to GitHub Packages. The repository must permit Actions to create pull requests, and the organization must allow package publishing.

## License

MIT.
