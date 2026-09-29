import test from "node:test";
import assert from "node:assert/strict";
import { filterLibraryAssets, isPageMedia } from "../web/librarySearch.js";

const assets = [
  {
    id: "image-a",
    project: "project-a",
    kind: "image",
    name: "Lake at dusk",
    favorite: true,
    metadata: {
      request: {
        prompt: "A cabin beside a quiet lake",
        profile: {
          model: "Qwen Image 2.1",
          label: "Square",
          id: "qwen-square",
        },
        source: { path: "/private/unsearchable-location" },
      },
    },
  },
  {
    id: "video-a",
    project: "project-a",
    kind: "video",
    name: "Ocean motion",
    metadata: { prompt: "Waves under moonlight", model: "Wan" },
  },
  {
    id: "document-a",
    project: "project-a",
    kind: "document",
    name: "Project brief.pdf",
    favorite: true,
  },
  {
    id: "text-a",
    project: "project-a",
    kind: "text",
    name: "Ｃａｂｉｎ notes",
    metadata: { request: { profile: { package: "writing-package" } } },
  },
  {
    id: "image-b",
    project: "project-b",
    kind: "image",
    name: "Lake at dusk",
    favorite: true,
  },
];
const find = (options = {}) =>
  filterLibraryAssets(assets, { projectId: "project-a", ...options }).map(
    (asset) => asset.id,
  );

test("search matches terms across names, prompts and model fields", () => {
  assert.deepEqual(find({ query: "  QWEN cabin DUSK  " }), ["image-a"]);
  assert.deepEqual(find({ query: "square" }), ["image-a"]);
  assert.deepEqual(find({ query: "wan moonlight" }), ["video-a"]);
  assert.deepEqual(find({ query: "writing-package" }), ["text-a"]);
  assert.deepEqual(find({ query: "Cabin" }), ["image-a", "text-a"]);
  assert.deepEqual(find({ query: "unsearchable-location" }), []);
});

test("search stays in the explicitly selected project and preserves source order", () => {
  const before = structuredClone(assets);
  assert.deepEqual(find(), ["image-a", "video-a", "document-a", "text-a"]);
  assert.deepEqual(find({ projectId: "project-b", query: "lake" }), [
    "image-b",
  ]);
  assert.deepEqual(find({ projectId: "unknown" }), []);
  assert.deepEqual(filterLibraryAssets(assets), []);
  assert.deepEqual(assets, before);
});

test("type, favorite and search filters combine and clear independently", () => {
  assert.deepEqual(find({ favorites: true }), ["image-a", "document-a"]);
  assert.deepEqual(
    find({ favorites: true, kind: "document", query: "brief" }),
    ["document-a"],
  );
  assert.deepEqual(find({ favorites: true, kind: "video" }), []);
  assert.deepEqual(find({ kind: "image", query: "no match" }), []);
  assert.deepEqual(find({ query: "   " }), find());
});

test("documents and writing are never offered as page media", () => {
  assert.deepEqual(
    assets.filter(isPageMedia).map((asset) => asset.id),
    ["image-a", "video-a", "image-b"],
  );
  for (const asset of [undefined, null, {}, { kind: "audio" }])
    assert.equal(isPageMedia(asset), false);
});

test("missing metadata and non-string fields do not break imported-asset search", () => {
  const imported = [
    { project: "project-a", name: "Imported photo", metadata: null },
    {
      project: "project-a",
      name: null,
      metadata: { model: { name: "hidden" } },
    },
  ];
  assert.deepEqual(
    filterLibraryAssets(imported, { projectId: "project-a", query: "photo" }),
    [imported[0]],
  );
  assert.deepEqual(
    filterLibraryAssets(imported, { projectId: "project-a", query: "hidden" }),
    [],
  );
});
