import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  buildDevinAcpSpawnInput,
  readDevinCredentialsApiKey,
  resolveDevinAcpBaseModelId,
  resolveDevinApiKey,
} from "./DevinAcpSupport.ts";

describe("resolveDevinAcpBaseModelId", () => {
  it("defaults to adaptive when no model is requested", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("adaptive");
  });

  it("keeps Devin's own model slugs verbatim", () => {
    expect(resolveDevinAcpBaseModelId("swe-2-high")).toBe("swe-2-high");
    expect(resolveDevinAcpBaseModelId("  swe-1-7-lightning-medium  ")).toBe(
      "swe-1-7-lightning-medium",
    );
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("spawns `devin acp` from the configured binary path", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/opt/devin/bin/devin", apiKey: "" }, "/tmp/project"),
    ).toEqual({
      command: "/opt/devin/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("falls back to `devin` on PATH and appends agent args", () => {
    const spawn = buildDevinAcpSpawnInput(undefined, "/tmp/project", undefined, [
      "--agent-type",
      "summarizer",
    ]);
    expect(spawn.command).toBe("devin");
    expect(spawn.args).toEqual(["acp", "--agent-type", "summarizer"]);
  });
});

describe("resolveDevinApiKey", () => {
  const emptySettings = { binaryPath: "devin", apiKey: "" };

  it.effect("prefers the configured apiKey over the credentials file", () =>
    Effect.gen(function* () {
      const key = yield* resolveDevinApiKey({ ...emptySettings, apiKey: "  cog_configured  " });
      expect(key).toBe("cog_configured");
    }).pipe(Effect.provide(Layer.merge(FileSystem.layerNoop({}), Path.layer))),
  );

  it.effect("reads windsurf_api_key from credentials.toml when unset", () =>
    Effect.gen(function* () {
      const key = yield* resolveDevinApiKey(emptySettings);
      expect(key).toBe("cog_from_disk");
    }).pipe(
      Effect.provide(
        Layer.merge(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.succeed(
                'api_server_url = "https://example.invalid"\nwindsurf_api_key = "cog_from_disk"\n',
              ),
          }),
          Path.layer,
        ),
      ),
    ),
  );

  it.effect("returns undefined when no credential exists", () =>
    Effect.gen(function* () {
      const key = yield* resolveDevinApiKey(emptySettings);
      expect(key).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.merge(
          FileSystem.layerNoop({
            readFileString: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              ),
          }),
          Path.layer,
        ),
      ),
    ),
  );

  it.effect("reads the real credentials.toml layout", () =>
    Effect.gen(function* () {
      const key = yield* readDevinCredentialsApiKey();
      expect(key).toBe("cog_nested");
    }).pipe(
      Effect.provide(
        Layer.merge(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.succeed(
                [
                  'api_server_url = "https://api.example.invalid"',
                  'devin_webapp_host = "app.example.invalid"',
                  'windsurf_api_key = "cog_nested"',
                ].join("\n"),
              ),
          }),
          Path.layer,
        ),
      ),
    ),
  );
});
