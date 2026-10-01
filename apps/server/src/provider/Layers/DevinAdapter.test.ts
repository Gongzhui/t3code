// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DevinSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

it.layer(devinAdapterTestLayer)("DevinAdapter", (it) => {
  it.effect(
    "spawns `devin acp`, forwards the API key via authenticate meta, and applies model/mode config options",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-")),
        );
        const requestLogPath = NodePath.join(dir, "requests.ndjson");
        const argvLogPath = NodePath.join(dir, "argv.log");
        const instanceId = ProviderInstanceId.make("devin");
        const wrapperPath = writeFakeCli({
          directory: dir,
          name: "fake-devin",
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
          source: execScriptSource({
            scriptPath: mockAgentPath,
            expectedArgs: ["acp"],
            argvLogPath,
          }),
        });

        const adapter = yield* makeDevinAdapter(
          decodeDevinSettings({ binaryPath: wrapperPath, apiKey: "cog_test_key" }),
          { instanceId },
        ).pipe(Effect.orDie);

        const threadId = ThreadId.make("devin-session-smoke");
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        assert.equal(session.provider, "devin");
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        });

        // The mock agent only accepts its own model ids; the slug itself is
        // forwarded verbatim, which is what this asserts.
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          modelSelection: { instanceId, model: "composer-2" },
        });
        assert.isString(turn.turnId);

        const argvLog = yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8"));
        assert.equal(argvLog.trim(), "acp");

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const authenticate = requests.find((line) => line.method === "authenticate");
        assert.deepInclude(authenticate, { method: "authenticate" });
        assert.deepInclude(authenticate?.params, {
          methodId: "devin-browser",
          _meta: { api_key: "cog_test_key" },
        });

        const configWrites = requests.filter((line) => line.method === "session/set_config_option");
        const writes = configWrites.map(
          (line) => (line.params as { configId: string; value: unknown }) ?? {},
        );
        assert.isTrue(
          writes.some((w) => w.configId === "model" && w.value === "composer-2"),
          "expected a model config write for composer-2",
        );
        assert.isTrue(
          writes.some((w) => w.configId === "mode" && w.value === "accept-edits"),
          "expected a mode config write for accept-edits",
        );

        const prompt = requests.find((line) => line.method === "session/prompt");
        assert.isDefined(prompt);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("plan interaction mode maps to Devin's plan mode", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-")),
      );
      const requestLogPath = NodePath.join(dir, "requests.ndjson");
      const wrapperPath = writeFakeCli({
        directory: dir,
        name: "fake-devin",
        env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        source: execScriptSource({ scriptPath: mockAgentPath }),
      });

      const adapter = yield* makeDevinAdapter(
        decodeDevinSettings({ binaryPath: wrapperPath, apiKey: "cog_test_key" }),
      ).pipe(Effect.orDie);

      const threadId = ThreadId.make("devin-plan-mode");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "auto" });
      yield* adapter.sendTurn({ threadId, input: "make a plan", interactionMode: "plan" });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeWrites = requests
        .filter((line) => line.method === "session/set_config_option")
        .map((line) => line.params as { configId?: string; value?: string })
        .filter((params) => params.configId === "mode");
      const lastModeWrite = modeWrites.at(-1);
      assert.equal(lastModeWrite?.value, "plan");

      yield* adapter.stopSession(threadId);
    }),
  );
});
