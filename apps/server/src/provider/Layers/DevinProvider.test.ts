import { describe, expect, it } from "@effect/vitest";

import { buildDevinModelsFromConfigOptions } from "./DevinProvider.ts";

describe("buildDevinModelsFromConfigOptions", () => {
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "swe-2-high",
    options: [
      { value: "adaptive", name: "Adaptive" },
      { value: "swe-2-high", name: "SWE-2 (High)" },
      { value: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning" },
      { value: "adaptive", name: "Adaptive (duplicate)" },
    ],
  };

  it("extracts flat and grouped options into picker models", () => {
    const models = buildDevinModelsFromConfigOptions([modelOption]);
    expect(models.map((model) => model.slug)).toEqual([
      "adaptive",
      "swe-2-high",
      "swe-1-7-lightning-medium",
    ]);
    expect(models.find((model) => model.slug === "swe-2-high")?.name).toBe("SWE-2 (High)");

    const grouped = buildDevinModelsFromConfigOptions([
      {
        ...modelOption,
        options: [
          {
            group: "Cognition",
            name: "Cognition models",
            options: [
              { value: "swe-2-high", name: "SWE-2 (High)" },
              { value: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning" },
            ],
          },
          {
            group: "Other",
            name: "Other models",
            options: [{ value: "adaptive", name: "Adaptive" }],
          },
        ],
      },
    ]);
    expect(grouped.map((model) => model.slug)).toEqual([
      "swe-2-high",
      "swe-1-7-lightning-medium",
      "adaptive",
    ]);
  });

  it("returns an empty list without a model config option", () => {
    expect(buildDevinModelsFromConfigOptions([])).toEqual([]);
    expect(buildDevinModelsFromConfigOptions(undefined)).toEqual([]);
    expect(
      buildDevinModelsFromConfigOptions([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select" as const,
          currentValue: "smart",
          options: [{ value: "smart", name: "Smart" }],
        },
      ]),
    ).toEqual([]);
  });

  it("marks the session's current value as the default", () => {
    const flat = buildDevinModelsFromConfigOptions([
      {
        ...modelOption,
        options: [
          { value: "adaptive", name: "Adaptive" },
          { value: "swe-2-high", name: "SWE-2" },
        ],
      },
    ]);
    expect(flat.find((model) => model.slug === "swe-2-high")?.isDefault).toBe(true);
    expect(flat.find((model) => model.slug === "adaptive")?.isDefault).toBeUndefined();
  });
});
