import { fauxAssistantMessage, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { cleanTitle, createTitleGenerator } from "../src/core/title.js";
import { createFaux, fauxModels, lastUserText } from "./helpers/faux.js";

let faux: FauxProviderHandle;

describe("cleanTitle", () => {
  it("keeps the first line without quotes or a label", () => {
    expect(cleanTitle("「周末去爬山」\n多余")).toBe("周末去爬山");
    expect(cleanTitle("标题：“咖啡推荐”")).toBe("咖啡推荐");
    expect(cleanTitle("一".repeat(30))).toBe("一".repeat(20));
  });
});

describe("createTitleGenerator", () => {
  it("asks the model with both sides of the exchange", async () => {
    faux = createFaux();
    let seen = "";
    faux.setResponses([(ctx) => { seen = lastUserText(ctx); return fauxAssistantMessage("《咖啡推荐》"); }]);
    const models = fauxModels(faux);
    const generate = createTitleGenerator({
      model: faux.getModel(),
      complete: (model, context, options) => models.completeSimple(model, context, options),
      getApiKey: () => "k",
    });
    await expect(generate("推荐咖啡", "试试耶加雪菲")).resolves.toBe("咖啡推荐");
    expect(seen).toBe("Owner: 推荐咖啡\nAssistant: 试试耶加雪菲");
  });

  it("fails on a model error or an empty title", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }), fauxAssistantMessage("  ")]);
    const models = fauxModels(faux);
    const generate = createTitleGenerator({
      model: faux.getModel(),
      complete: (model, context, options) => models.completeSimple(model, context, options),
      getApiKey: () => "k",
    });
    await expect(generate("a", "b")).rejects.toThrow(/boom/);
    await expect(generate("a", "b")).rejects.toThrow(/returned nothing/);
  });
});
