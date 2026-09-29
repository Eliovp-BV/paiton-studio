import test from "node:test";
import assert from "node:assert/strict";
import { modelApiConfig } from "../web/modelApiConfig.js";

const profile = {
  id: "paiton-text-qualified",
  context: 8192,
  max_tokens: 768,
  package: { model: "Local text model" },
};

test("VS Code config targets the actual text protocol with a secret prompt and qualified limits", () => {
  const [provider] = JSON.parse(
    modelApiConfig("https://studio.example:8443", profile),
  );
  assert.equal(provider.vendor, "customendpoint");
  assert.equal(provider.apiType, "chat-completions");
  assert.equal(provider.apiKey, "${input:paitonApiKey}");
  const [model] = provider.models;
  assert.equal(model.id, profile.id);
  assert.equal(model.name, profile.package.model);
  assert.equal(model.url, "https://studio.example:8443/v1/chat/completions");
  assert.equal(model.toolCalling, false);
  assert.equal(model.vision, false);
  assert.equal(model.maxOutputTokens, 768);
  assert.ok(model.maxInputTokens + model.maxOutputTokens <= profile.context);
  assert.ok(model.maxInputTokens <= 4000);
  const [smallProvider] = JSON.parse(
    modelApiConfig("http://localhost:8877", {
      ...profile,
      context: 2048,
      max_tokens: 1024,
    }),
  );
  assert.equal(smallProvider.models[0].maxInputTokens, 1024);
});

test("Continue config uses Chat Completions, local secret substitution and chat-only capabilities", () => {
  const content = modelApiConfig("http://[::1]:8877", profile, "continue");
  assert.match(content, /provider: openai\n/);
  assert.match(content, /apiBase: "http:\/\/\[::1\]:8877\/v1"/);
  assert.ok(content.includes("apiKey: ${{ secrets.PAITON_API_KEY }}"));
  assert.match(content, /useResponsesApi: false\n/);
  assert.match(content, /roles: \[chat\]\n/);
  assert.match(content, /capabilities: \[\]\n/);
  assert.match(content, /maxTokens: 768\n/);
  assert.doesNotMatch(content, /roles:.*(?:edit|apply|autocomplete|embed)/);
});

test("client configs escape model names and normalize away URL paths, queries and fragments", () => {
  const id = 'model"\n  apiKey: accidental-secret\n#',
    name = 'Quoted "model" <script> & Unicode 模型',
    tricky = { ...profile, id, package: { model: name } };
  const origin = "https://studio.example/unused?token=not-a-key#private";
  const vscode = modelApiConfig(origin, tricky);
  const [provider] = JSON.parse(vscode);
  assert.equal(provider.models[0].id, id);
  assert.equal(provider.models[0].name, name);
  assert.equal(
    provider.models[0].url,
    "https://studio.example/v1/chat/completions",
  );
  assert.doesNotMatch(vscode, /not-a-key|#private|\/unused/);
  const yaml = modelApiConfig(origin, tricky, "continue");
  const modelLine = yaml
    .split("\n")
    .find((line) => line.startsWith("    model: "));
  assert.equal(JSON.parse(modelLine.slice("    model: ".length)), id);
  assert.equal(
    yaml.split("\n").filter((line) => /^\s+apiKey:/.test(line)).length,
    1,
  );
  assert.doesNotMatch(yaml, /not-a-key|#private|\/unused/);
});

test("invalid origins, missing model identity and unknown clients fail instead of inventing usable configuration", () => {
  for (const origin of [
    "file:///tmp",
    "javascript:alert(1)",
    "ftp://studio.example",
    "https://username:password@studio.example",
    "not a URL",
  ]) {
    assert.throws(() => modelApiConfig(origin, profile));
  }
  for (const value of [null, {}, { id: "" }])
    assert.throws(
      () => modelApiConfig("http://localhost", value),
      /Choose an installed text model/,
    );
  assert.throws(
    () => modelApiConfig("http://localhost", profile, "unsupported-client"),
    /Choose VS Code or Continue/,
  );
});
