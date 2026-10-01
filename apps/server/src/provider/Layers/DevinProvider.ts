import {
  type CustomModelSetting,
  type DevinSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeDevinAcpRuntime, resolveDevinApiKey } from "../acp/DevinAcpSupport.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip; `session/new` additionally
// authenticates and boots the session, which can take a few seconds.
const DEVIN_ACP_PROBE_TIMEOUT_MS = 20_000;

/**
 * Fallback catalog shown before an authenticated ACP probe can run. These are
 * Devin's own models; the session's `model` config option carries the full
 * list (including Claude/GPT/Gemini relays) once a session starts.
 */
const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "adaptive",
    name: "Adaptive",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "swe-2-high",
    name: "SWE-2",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "swe-1-7-lightning-medium",
    name: "SWE-1.7 Lightning",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Commands every Devin ACP session advertises through
 * `available_commands_update`. Mirrored statically so the picker works before
 * a session exists; live updates replace this list at runtime.
 */
const DEVIN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "status", description: "Check authentication status" },
  { name: "workspace", description: "List workspace directories" },
  { name: "ask", description: "Switch to Ask mode (read-only)", input: { hint: "[question]" } },
  {
    name: "plan",
    description: "Switch to Plan mode, or plan with a prompt",
    input: { hint: "[prompt]" },
  },
  {
    name: "code",
    description: "Switch to Code mode, or run a prompt in it",
    input: { hint: "[prompt]" },
  },
  {
    name: "smart",
    description: "Switch to Smart mode, or run a prompt under it",
    input: { hint: "[prompt]" },
  },
  {
    name: "bypass",
    description: "Switch to Bypass Permissions mode, or run a prompt under it",
    input: { hint: "[prompt]" },
  },
  { name: "compact", description: "Force conversation compaction" },
  { name: "context", description: "Show context window usage" },
  {
    name: "fast",
    description: "Switch to the fastest model available to you, or run a prompt with it",
    input: { hint: "[prompt]" },
  },
  {
    name: "loop",
    description: "Run a prompt then auto-review the diff in a loop",
    input: { hint: "<prompt>" },
  },
  { name: "recap", description: "Recap the session so far with a short summary" },
  { name: "session-stats", description: "Show session statistics" },
  { name: "rename", description: "Rename this session", input: { hint: "<new title>" } },
  { name: "share", description: "Share this conversation with your team on Devin" },
  { name: "mcp", description: "List configured MCP servers and their status" },
  { name: "help", description: "Show available commands" },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Devin exposes a session-level `thought_level` select (e.g. medium/high/max)
 * alongside the model picker. Surface it as a per-model `reasoning` option so
 * the composer renders the same effort dropdown other providers use.
 */
export function buildDevinModelCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const thoughtLevelOption = configOptions?.find(
    (option) => option.category === "thought_level" && option.type === "select",
  );
  if (!thoughtLevelOption || thoughtLevelOption.type !== "select") {
    return EMPTY_CAPABILITIES;
  }
  const options = thoughtLevelOption.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: thoughtLevelOption.name?.trim() || "Thinking",
        options: options.flatMap((entry) => {
          const value = entry.value.trim();
          if (!value) {
            return [];
          }
          return [
            {
              value,
              label: entry.name.trim() || value,
              ...(value === thoughtLevelOption.currentValue ? { isDefault: true } : {}),
            },
          ];
        }),
      }),
    ],
  });
}

/**
 * Models advertised by the session's `model` config option. Devin does not
 * expose a catalog in `initialize`, so the list only appears after
 * `session/new`.
 */
export function buildDevinModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const currentValue = modelOption.currentValue?.trim();
  const capabilities = buildDevinModelCapabilities(configOptions);
  const seen = new Set<string>();
  // ACP select options can be flat entries or `{ group, options }` sections.
  const entries = modelOption.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );
  return entries.flatMap((entry): ServerProviderModel[] => {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name.trim() || slug,
        isCustom: false,
        ...(slug === currentValue ? { isDefault: true } : {}),
        capabilities,
      },
    ];
  });
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Authenticated probe: initialize, sign in with the resolved API key, open a
 * scratch session, read its `model` config option, then delete the session.
 * Never runs without an API key — the `devin-browser` auth method would open
 * a browser tab on every health refresh.
 */
const discoverDevinMetadataViaAcp = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const configOptions = started.sessionSetupResult.configOptions ?? [];
    yield* acp
      .request("session/delete", { sessionId: started.sessionId })
      .pipe(Effect.ignore, Effect.forkChild);
    return {
      models: buildDevinModelsFromConfigOptions(configOptions),
    };
  }).pipe(Effect.scoped);

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  // ACP ignores the Devin CLI's own login state entirely — the host supplies
  // credentials per process. With a resolvable API key, authenticate is
  // non-interactive so a full session probe is safe; without one the only
  // auth path opens a browser, which must never run in a background check.
  const hasApiKey = (yield* resolveDevinApiKey(devinSettings)) !== undefined;
  let models = fallbackModels;
  let acpFailed = false;
  if (hasApiKey) {
    const acpExit = yield* discoverDevinMetadataViaAcp(devinSettings, environment).pipe(
      Effect.timeoutOption(DEVIN_ACP_PROBE_TIMEOUT_MS),
      Effect.exit,
    );
    if (Exit.isFailure(acpExit) || Option.isNone(acpExit.value)) {
      acpFailed = true;
      yield* Effect.logWarning("Devin ACP probe failed or timed out.", {
        errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
      });
    } else if (acpExit.value.value.models.length > 0) {
      models = providerModelsFromSettings(
        acpExit.value.value.models,
        devinSettings.customModels ?? [],
        EMPTY_CAPABILITIES,
      );
    }
  }

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    slashCommands: DEVIN_SLASH_COMMANDS,
    probe: {
      installed: true,
      version,
      status: acpFailed ? "warning" : "ready",
      auth: hasApiKey
        ? { status: "authenticated", type: "api_key", label: "Devin API key" }
        : { status: "unknown" },
      ...(acpFailed
        ? {
            message:
              "Devin CLI is installed but the ACP session probe failed. Model options may be incomplete.",
          }
        : hasApiKey
          ? {}
          : {
              message:
                "Devin sessions sign in with a browser prompt, or set an API key in provider settings to skip it.",
            }),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
