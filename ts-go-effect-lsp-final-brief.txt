> Disclaimer: Speaker accreditation may not be 100% correct. Please confirm references — they are a starting point.

# TypeScript Go with Effect LSP - Setup Guide, Features, and Performance Boost

## SUMMARY

Mattia demonstrates the Effect LSP integrated with TypeScript Go, showing setup, diagnostics, refactoring features, and how it enables faster feedback loops for LLM-assisted development.

## IDEAS

- TypeScript Go cannot load JavaScript plugins, so Effect built a custom fork that recompiles the binary with injected callbacks.
- The Effect TS Go fork is structured like OXCLint's type-aware linting rather than a traditional diverging fork.
- Effect diagnostics require deep type information, making JavaScript-to-Go communication too slow for meaningful analysis.
- The patched binary serves as a drop-in replacement for standard TS Go while adding Effect-specific diagnostics.
- Plugin settings are stored in the same tsconfig plugins key, allowing teams to mix old and new LSP versions seamlessly.
- Diagnostic severity can be tuned per-rule to create back pressure that forces LLMs away from anti-patterns.
- The LSP can point diagnostics to the exact location where a provide happened and suggest which layer would fix it.
- Rules can ban Node built-in imports when Effect native counterparts exist, steering LLMs toward testable patterns.
- LLMs often call tsc or tsgo directly during deep coding sessions, bypassing separate linting tools entirely.
- Baking diagnostics into the TS Go binary means LLMs receive Effect-specific errors without needing additional tool invocations.
- The original TypeScript language server predated LSP protocol and used a custom protocol limiting cross-editor compatibility.
- The new version is fully LSP compliant, meaning quick fixes and diagnostics work reliably across all editors.
- Custom outline entries group Effect code by services, layers, errors, and required types for rapid navigation.
- The effect.fn opportunity rule can infer span names from service names and method names automatically.
- Setting effect.fn opportunity to error forces LLMs to produce properly traced Effect services with correct span names.
- The TS Go version achieves at least seven times faster diagnostic output than the previous TypeScript-based implementation.
- The LSP supports both Effect v3 and v4 with a comparison table showing which rules apply to which version.
- A preset system is planned with three modes: effect-native, strict, and default suggestions.
- CI jobs will automatically update the TypeScript Go submodule pin and rebuild when stable releases arrive.
- The setup CLI auto-generates a custom tsconfig JSON schema that enables autocompletion for LSP rule configuration.
- You can use TS Go just for the LSP while still compiling with the regular TypeScript compiler in CI.
- Go's binary plugin limitations and security concerns mean custom extensibility for the LSP is architecturally impossible.
- The refactor feature can convert async/await/try/promise patterns into Effect.fn with tagged errors automatically.

## INSIGHTS

- Embedding diagnostics directly in the compiler binary is the only viable architecture when plugin systems disappear from language servers.
- Performance budgets from native compilation unlock diagnostic features that were previously too expensive to compute in real time.
- LLM-driven development inverts the traditional linting model: errors become steering mechanisms rather than human-readable warnings.
- Cross-editor compatibility becomes trivial when you conform to LSP protocol rather than maintaining editor-specific adapters.
- Forking via submodule-plus-patches preserves upstream compatibility while enabling deep integration that APIs alone cannot provide.
- The seven-times performance improvement transforms diagnostics from an occasional check into a continuous feedback signal.
- Allowing mixed team setups with identical configuration keys reduces adoption friction for experimental tooling.
- Inferring span names from code structure eliminates the tedious manual tracing that developers and LLMs both skip.
- Banning vanilla APIs at the compiler level is more effective than linting because LLMs treat compiler errors as hard constraints.
- Preset systems convert expert knowledge about rule severity into one-click team-wide coding standards.

## QUOTES

- "The only approach that we had for the TypeScript Go version of the effect language service is basically to write some kind of fork of TypeScript Go." — Speaker 1
- "No one cares about the LSP. Bring the cat back." — Speaker 0
- "The performance is way, way, way, way faster than the previous implementation we had." — Speaker 1
- "LLMs are lazy as hell, so even if you have a check command or whatever in your script, you'll find out that the LLMs when they got into a very deep minded process of coding something, what they'll end up doing is call TSC directly." — Speaker 1
- "We went basically from cutting by hand, like, prehistoric men to having a little—" — Speaker 1
- "We were cavemen last year, everyone." — Speaker 0
- "You can just give your, okay, type whatever you want on your keyboard and run the LSP, and eventually, you'll find a solution." — Speaker 1
- "Allowing to load whatever inside of it, probably not the best, both in terms of performance and both in terms of security." — Speaker 1
- "This is very, very, very valuable information for the LLMs because they can just say, oh, this can fix." — Speaker 1
- "If you're not using TS Go in your project yet, you could just use it for the LSP piece." — Speaker 0
- "The speed of which the TS Go version can output the diagnostic is at least seven times faster than the previous implementation." — Speaker 1
- "That way you can enforce your LLM to provide good span names for your services." — Speaker 1
- "One binary cannot load in Go plugins in a platform agnostic way." — Speaker 1
- "The settings are named the same, so you can basically have one place that configures it and then switch to whatever you want." — Speaker 1
- "If you enable in your ts config the language service plugin, that means that you now start getting the Effect goodies in a TS Go way." — Speaker 1
- "This can help you steer a lot your LLM towards preferring effect driven patterns that are more testable." — Speaker 1

## HABITS

- Mattia uses the editor outline extensively to navigate between services, layers, and errors in Effect codebases.
- He sets diagnostic severity to error for rules that should create hard constraints during LLM-assisted coding sessions.
- He structures forks as submodules with patches rather than traditional diverging forks to preserve upstream sync.
- He builds CLI setup commands with guided walkthroughs that detect existing configuration before making changes.
- He defaults rules to suggestion severity unless the pattern would already be a TypeScript error or clear anti-pattern.
- He backtports features from the TS Go version to the standard version to maintain both implementations.
- He uses CI jobs to automatically test compatibility with new upstream TypeScript Go commits.
- He provides inline examples in CLI tools so users understand rules without consulting external documentation.
- The Effect team uses TS Go for local checks while still running the regular TypeScript compiler in CI.
- He designs settings to be identical across old and new implementations so teams can migrate incrementally.

## CLAIMS

- The TypeScript Go language service is at least seven times faster at producing diagnostics than the TypeScript-based version.
- The original TypeScript language server protocol predated and inspired the LSP standard protocol specification.
- TypeScript Go will likely never support runtime plugins due to Go's platform-agnostic binary plugin limitations.
- TypeScript Go has achieved almost 100% feature parity with standard TypeScript for type checking and compilation.
- LLMs during deep coding sessions will call tsc or tsgo directly rather than using separate linting commands.
- Go binaries cannot load JavaScript plugins without embedding a JavaScript engine, which would negate performance gains.
- The Effect TS Go fork applies only a single callback injection patch to the upstream TypeScript Go source.
- The TypeScript Go project was announced over one year ago and is currently in beta with no stable release.

## REFERENCES

- [TypeScript Go repository (official Microsoft project)](https://github.com/Microsoft/typescript-go)
- [Effect TS Go repository (Effect organization on GitHub)](https://github.com/Effect-TS/tsgo)
- [OXCLint](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [VTSLS](https://github.com/yioneko/vtsls)
- [Effect Schema](https://effect.website/docs/schema/transformations/)
- [Effect v3](https://effect.website/docs/)
- [Effect v4](https://effect.website/blog/releases/effect/40-beta/)
- [JSON Placeholder](https://jsonplaceholder.typicode.com/)

## ONE-SENTENCE TAKEAWAY

Embedding Effect diagnostics directly into the TypeScript Go binary creates compiler-level feedback that steers both humans and LLMs.

## RECOMMENDATIONS

- Set the effect.fn opportunity rule to error severity when using LLM coding assistants to enforce proper tracing automatically.
- Use the TS Go LSP for local development even if your CI still runs the standard TypeScript compiler for compatibility.
- Configure the node-built-in-import rule as an error to prevent LLMs from reaching for untestable Node APIs.

## QUESTIONS

- If LLMs increasingly bypass standalone linting tools by calling the compiler directly, should the broader TypeScript ecosystem reconsider the separation between compilation and code quality analysis?
