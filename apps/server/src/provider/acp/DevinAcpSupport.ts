import {
  type DevinSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as NodeOS from "node:os";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Devin's only advertised auth method. Without `_meta.api_key` the agent
 * starts a PKCE browser flow; with it, authenticate is non-interactive.
 */
export const DEVIN_ACP_AUTH_METHOD = "devin-browser";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath" | "apiKey">;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "authMeta" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Extra args appended after `acp` (e.g. `--agent-type summarizer`). */
  readonly agentArgs?: ReadonlyArray<string>;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  agentArgs?: ReadonlyArray<string>,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp", ...(agentArgs ?? [])],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Reads the API key the Devin CLI persists in `credentials.toml`. The ACP
 * agent deliberately ignores the file itself ("ACP host is the sole source
 * of credentials"), so the host must forward it via `authenticate._meta`.
 * A bare TOML scan is enough here — the file is a flat `key = "value"` map.
 */
export const readDevinCredentialsApiKey = Effect.fn("readDevinCredentialsApiKey")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentialsPath = path.join(
    NodeOS.homedir(),
    ".local",
    "share",
    "devin",
    "credentials.toml",
  );
  const raw = yield* fs.readFileString(credentialsPath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    return undefined;
  }
  const preferred = raw.value.match(/^windsurf_api_key\s*=\s*"([^"]+)"/m)?.[1]?.trim();
  if (preferred) {
    return preferred;
  }
  for (const line of raw.value.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]*(?:api_key|token))\s*=\s*"([^"]+)"/i);
    if (match?.[2]?.trim()) {
      return match[2].trim();
    }
  }
  return undefined;
});

/** Settings field wins; otherwise the CLI's own saved credential. */
export const resolveDevinApiKey = Effect.fn("resolveDevinApiKey")(function* (
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
) {
  const configured = devinSettings?.apiKey?.trim();
  if (configured) {
    return configured;
  }
  return yield* readDevinCredentialsApiKey();
});

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const apiKey = yield* resolveDevinApiKey(input.devinSettings);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(
          input.devinSettings,
          input.cwd,
          input.environment,
          input.agentArgs,
        ),
        authMethodId: DEVIN_ACP_AUTH_METHOD,
        ...(apiKey ? { authMeta: { api_key: apiKey } } : {}),
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          // Devin's agent manages terminals itself through its
          // `cognition.ai/terminalLifecycle` extension rather than the
          // client-side `terminal/*` capability.
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "adaptive";
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? "adaptive";
}

interface DevinAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.model !== null && input.model !== undefined) {
      yield* input.runtime
        .setModel(resolveDevinAcpBaseModelId(input.model))
        .pipe(Effect.mapError(input.mapError));
    }

    const requestedThoughtLevel = getProviderOptionStringSelectionValue(
      input.selections,
      "reasoning",
    )?.toLowerCase();
    if (!requestedThoughtLevel) {
      return;
    }
    const thoughtLevelOption = (yield* input.runtime.getConfigOptions).find(
      (option) => option.category === "thought_level" && option.type === "select",
    );
    if (!thoughtLevelOption || thoughtLevelOption.type !== "select") {
      return;
    }
    const entries = thoughtLevelOption.options.flatMap((entry) =>
      "value" in entry ? [entry] : entry.options,
    );
    const match = entries.find(
      (entry) =>
        entry.value.trim().toLowerCase() === requestedThoughtLevel ||
        entry.name.trim().toLowerCase() === requestedThoughtLevel,
    );
    if (!match) {
      return;
    }
    yield* input.runtime
      .setConfigOption(thoughtLevelOption.id, match.value)
      .pipe(Effect.mapError(input.mapError));
  });
}
