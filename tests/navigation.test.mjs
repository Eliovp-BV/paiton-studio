import test from "node:test";
import assert from "node:assert/strict";
import {
  NAVIGATION,
  NAV_ROUTES,
  MODEL_TABS,
  routeGroup,
  studioRoute,
} from "../web/studioNavigation.js";

test("Studio has exactly the seven agreed primary destinations", () => {
  assert.deepEqual(
    NAVIGATION.map((item) => item.label),
    ["Home", "Chat", "Create", "Projects", "Models", "Connect", "Settings"],
  );
  assert.equal(
    new Set(NAV_ROUTES.map((item) => item.id)).size,
    NAV_ROUTES.length,
  );
  for (const item of NAVIGATION) {
    const destination = item.route || item.id;
    assert.equal(studioRoute(destination), destination);
    if (item.children) assert.equal(routeGroup(destination)?.id, item.id);
  }
});

test("existing tools retain a destination in the collapsed navigation", () => {
  for (const [route, group] of [
    ["chat", "chat"],
    ["agents", "chat"],
    ["image", "create"],
    ["video", "create"],
    ["write", "create"],
    ["page", "create"],
    ["delivery", "create"],
    ["projects", "projects"],
    ["coding", "projects"],
    ["library", "projects"],
    ["tools", "models"],
    ["model-setup", "models"],
    ["model-defaults", "models"],
    ["model-memory", "models"],
    ["runtime-packages", "models"],
    ["model-api", "connect"],
    ["mcp", "connect"],
    ["settings", "settings"],
    ["system", "settings"],
    ["wiki", "settings"],
  ]) {
    assert.equal(studioRoute(route), route);
    assert.equal(routeGroup(route)?.id, group);
  }
  assert.equal(studioRoute("meetings"), "meetings");
  assert.equal(
    NAV_ROUTES.some((item) => item.id === "meetings"),
    false,
  );
  assert.equal(routeGroup("home"), undefined);
});

test("old bookmarks and contextual entry points resolve to their supported routes", () => {
  for (const [alias, route] of Object.entries({
    mail: "mcp",
    gpt: "chat",
    website: "page",
    models: "tools",
    create: "image",
    build: "coding",
    assistants: "agents",
    files: "coding",
    connect: "model-api",
    downloads: "model-setup",
    packages: "runtime-packages",
    preferences: "settings",
  }))
    assert.equal(studioRoute(alias), route);
  for (const invalid of [
    undefined,
    null,
    "",
    "not-a-studio-page",
    "../../private",
  ])
    assert.equal(studioRoute(invalid), "home");
  assert.deepEqual(MODEL_TABS, {
    "model-defaults": "preferences",
    "model-setup": "setup",
    "model-memory": "memory",
    "runtime-packages": "packages",
  });
});
