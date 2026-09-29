import React, { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Plus,
  Search,
  Copy,
  Pencil,
  Trash2,
  Save,
  ArrowRight,
  RefreshCw,
  Eye,
  X,
} from "lucide-react";
import {
  RECIPE_TARGETS,
  RECIPE_EXAMPLES,
  recipeFields,
  recipeVariables,
} from "./recipeTemplates";
import "./recipes.css";

// Drafts belong to the local UI session; reusable definitions are saved on the host.
const drafts = new Map(),
  inputs = new Map();
const savingRecipes = new Set();
let lastSelection = "new";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = () => recipeFields(null);
const keyFor = (project, id) => `${project || "none"}:${id}`;

export default function Recipes({ api, onUse, report, project }) {
  const initial = drafts.get(lastSelection);
  const [recipes, setRecipes] = useState([]),
    [selected, setSelected] = useState(lastSelection),
    [draft, setDraft] = useState(initial?.draft || empty),
    [base, setBase] = useState(initial?.base || null),
    [remote, setRemote] = useState(null);
  const [editing, setEditing] = useState(
      Boolean(initial?.dirty) || lastSelection === "new",
    ),
    [values, setValues] = useState({}),
    [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true),
    [opening, setOpening] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [query, setQuery] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false),
    [pendingExample, setPendingExample] = useState(null);
  const mounted = useRef(true),
    sequence = useRef(0),
    listSequence = useRef(0),
    operation = useRef(false),
    identityRef = useRef("");
  const projectId = project?.id || "none",
    selectionRef = useRef(selected),
    projectRef = useRef(projectId);
  selectionRef.current = selected;
  projectRef.current = projectId;
  const dirty = !equal(draft, base ? recipeFields(base) : empty());
  const conflict = Boolean(base && remote && base.revision !== remote.revision);
  const parsed = recipeVariables(draft.template);
  const limit = RECIPE_TARGETS[draft.target].limit;
  const valid = Boolean(
    draft.name.trim() &&
      draft.template.trim() &&
      !parsed.error &&
      [...draft.template].length <= limit,
  );
  const vars = base?.variables || [];
  const useIdentity = JSON.stringify([
    projectId,
    selected,
    base?.revision,
    values,
  ]);
  identityRef.current = useIdentity;
  const readyPreview = preview?.identity === useIdentity ? preview.value : null;
  const missing = vars.some(
    (name) => !Object.hasOwn(values, name) || !values[name].trim(),
  );
  const matching = recipes.filter((recipe) =>
    `${recipe.name} ${recipe.description} ${RECIPE_TARGETS[recipe.target].label}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  function remember(next = draft, version = base, id = selected) {
    drafts.set(id, {
      draft: next,
      base: version,
      dirty: !equal(next, version ? recipeFields(version) : empty()),
    });
    if (drafts.size > 60) drafts.delete(drafts.keys().next().value);
  }
  function fail(failure) {
    if (mounted.current) setError(failure.message || String(failure));
  }
  async function refresh() {
    const attempt = ++listSequence.current;
    setLoading(true);
    setError("");
    try {
      const list = await api("/recipes");
      if (mounted.current && attempt === listSequence.current) {
        setRecipes(list);
        return list;
      }
    } catch (failure) {
      fail(failure);
    } finally {
      if (mounted.current && attempt === listSequence.current)
        setLoading(false);
    }
  }
  async function open(id, { rebase = false, preserveCurrent = true } = {}) {
    if (operation.current) return;
    if (preserveCurrent) remember();
    setSelected(id);
    lastSelection = id;
    selectionRef.current = id;
    setConfirmDelete(false);
    setPreview(null);
    setError("");
    setNotice("");
    if (id === "new") {
      const cached = drafts.get(id);
      setDraft(cached?.draft || empty());
      setBase(null);
      setRemote(null);
      setEditing(true);
      return;
    }
    const attempt = ++sequence.current;
    setOpening(true);
    const cached = drafts.get(id);
    setRemote(null);
    if (cached) {
      setBase(cached.base);
      setDraft(cached.draft);
    }
    try {
      const saved = await api(`/recipes/${id}`);
      if (
        !mounted.current ||
        attempt !== sequence.current ||
        selectionRef.current !== id
      )
        return;
      const retained = cached?.dirty ? cached.draft : recipeFields(saved);
      const original =
        !rebase && cached?.dirty && cached.base ? cached.base : saved;
      setRemote(saved);
      setBase(original);
      setDraft(retained);
      setEditing(Boolean(cached?.dirty));
      drafts.set(id, {
        draft: retained,
        base: original,
        dirty: !equal(retained, recipeFields(original)),
      });
      if (rebase)
        setNotice(
          "Latest saved revision loaded. Your draft is kept; compare it before saving.",
        );
    } catch (failure) {
      if (mounted.current && attempt === sequence.current) {
        if (cached) {
          setBase(cached.base);
          setDraft(cached.draft);
          setEditing(true);
        }
        fail(failure);
      }
    } finally {
      if (mounted.current && attempt === sequence.current) setOpening(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    refresh().then((list) => {
      if (!mounted.current) return;
      if (selected !== "new") return open(selected);
      if (!initial?.dirty && list?.length) return open(list[0].id);
    });
    return () => {
      mounted.current = false;
      ++sequence.current;
      ++listSequence.current;
    };
  }, []);
  useEffect(() => {
    setValues(inputs.get(keyFor(projectId, selected)) || {});
    setPreview(null);
  }, [projectId, selected]);
  function edit(change) {
    const next = { ...draft, ...change };
    setDraft(next);
    remember(next);
    setPreview(null);
    setNotice("");
  }
  function start(example = null, replace = false) {
    if (busy) return;
    remember();
    if (!replace && drafts.get("new")?.dirty) {
      if (example) setPendingExample(example);
      else open("new");
      return;
    }
    setPendingExample(null);
    ++sequence.current;
    setOpening(false);
    setSelected("new");
    selectionRef.current = "new";
    lastSelection = "new";
    const next = example ? recipeFields(example) : empty();
    setDraft(next);
    setBase(null);
    setRemote(null);
    setEditing(true);
    setPreview(null);
    setError("");
    setNotice(
      example ? "Example draft. Save it to add it to your recipe library." : "",
    );
    setConfirmDelete(false);
    drafts.set("new", { draft: next, base: null, dirty: Boolean(example) });
  }
  async function save(asNew = false) {
    if (operation.current || !valid || (!asNew && conflict)) return;
    const id = asNew ? "new" : selected;
    if (savingRecipes.has(id)) {
      setError(
        "A previous save is still finishing. Your draft is kept; wait, then retry.",
      );
      return;
    }
    if (
      !asNew &&
      selected === "new" &&
      !drafts.has("new") &&
      drafts.get(lastSelection)?.base &&
      equal(draft, recipeFields(drafts.get(lastSelection).base))
    ) {
      await open(lastSelection, { preserveCurrent: false });
      return;
    }
    if (id !== "new" && !base) {
      setError(
        "Reload this recipe before saving, or start a new recipe to keep these changes separately.",
      );
      return;
    }
    savingRecipes.add(id);
    operation.current = true;
    setBusy("save");
    setError("");
    setNotice("");
    const submitted = { ...draft };
    try {
      const saved = await api(
        id === "new" ? "/recipes" : `/recipes/${id}`,
        id === "new"
          ? submitted
          : { ...submitted, expected_revision: base.revision },
        id === "new" ? "POST" : "PATCH",
      );
      const currentDraft = drafts.get(selected);
      const unchanged =
        equal(currentDraft?.draft, submitted) &&
        currentDraft?.base?.revision === base?.revision;
      if (id === "new" || unchanged)
        drafts.set(saved.id, {
          draft: recipeFields(saved),
          base: saved,
          dirty: false,
        });
      if (selected === "new" && unchanged) drafts.delete("new");
      if (lastSelection === selected && unchanged) lastSelection = saved.id;
      if (!mounted.current) return;
      setSelected(saved.id);
      selectionRef.current = saved.id;
      setBase(saved);
      setRemote(saved);
      setDraft(recipeFields(saved));
      setEditing(false);
      setPreview(null);
      setNotice("Recipe saved. Fill its inputs and preview the task.");
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      savingRecipes.delete(id);
      operation.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function duplicate() {
    if (operation.current || !base || dirty) return;
    operation.current = true;
    setBusy("duplicate");
    setError("");
    try {
      const saved = await api(`/recipes/${base.id}/duplicate`, {
        expected_revision: base.revision,
      });
      drafts.set(saved.id, {
        draft: recipeFields(saved),
        base: saved,
        dirty: false,
      });
      lastSelection = saved.id;
      if (!mounted.current) return;
      setSelected(saved.id);
      selectionRef.current = saved.id;
      setBase(saved);
      setRemote(saved);
      setDraft(recipeFields(saved));
      setEditing(true);
      setPreview(null);
      setNotice(
        "Recipe copied. Give it a useful name or customize the template.",
      );
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function remove() {
    if (operation.current || !base) return;
    operation.current = true;
    setBusy("delete");
    setError("");
    try {
      await api(
        `/recipes/${base.id}`,
        { expected_revision: base.revision },
        "DELETE",
      );
      drafts.delete(base.id);
      lastSelection = "new";
      if (!mounted.current) return;
      setSelected("new");
      selectionRef.current = "new";
      setBase(null);
      setRemote(null);
      setDraft(drafts.get("new")?.draft || empty());
      setEditing(true);
      setConfirmDelete(false);
      setPreview(null);
      setNotice("Recipe deleted. Existing workspace drafts are unchanged.");
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function render(use = false) {
    if (
      operation.current ||
      !base ||
      dirty ||
      missing ||
      conflict ||
      (!readyPreview && use)
    )
      return;
    operation.current = true;
    setBusy(use ? "use" : "preview");
    setError("");
    setNotice("");
    const identity = useIdentity;
    try {
      const result = await api(`/recipes/${base.id}/render`, {
        expected_revision: base.revision,
        values: Object.fromEntries(vars.map((name) => [name, values[name]])),
      });
      if (!mounted.current || identityRef.current !== identity) return;
      if (use) {
        if (result.prompt !== readyPreview.prompt)
          throw Error(
            "This task changed after previewing. Preview it again before using it.",
          );
        await onUse(result);
        if (mounted.current && identityRef.current === identity)
          setNotice(
            `Draft opened in ${RECIPE_TARGETS[result.target].label}. Review its model and context before sending.`,
          );
      } else setPreview({ identity, value: result });
    } catch (failure) {
      if (identityRef.current === identity) {
        setPreview(null);
        fail(failure);
      }
    } finally {
      operation.current = false;
      if (mounted.current) setBusy("");
    }
  }
  return (
    <section className="recipes-workspace" aria-label="Recipe library">
      <header className="recipes-heading">
        <div>
          <span className="eyebrow">REUSABLE STARTING POINTS</span>
          <h1>
            <BookOpen size={25} />
            Recipes
          </h1>
          <p>
            Save useful task templates. Fill in the details, preview the result
            and open a draft.
          </p>
        </div>
        <button type="button" onClick={() => start()} disabled={Boolean(busy)}>
          <Plus size={15} />
          New recipe
        </button>
      </header>
      {error && (
        <div className="recipes-error" role="alert">
          <span>{error}</span>
          {base && (
            <button
              type="button"
              disabled={Boolean(busy) || opening}
              onClick={() => open(base.id, { rebase: true })}
            >
              Reload saved recipe
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss recipe error"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <p className="recipes-notice" role="status">
          {notice}
        </p>
      )}
      {pendingExample && (
        <div
          className="recipes-delete-confirm"
          role="group"
          aria-label="Replace unsaved recipe draft"
        >
          <p>
            You have an unsaved new recipe. Replace it with the “
            {pendingExample.name}” example?
          </p>
          <button type="button" onClick={() => start(pendingExample, true)}>
            Replace draft with example
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingExample(null);
              open("new");
            }}
          >
            Keep current draft
          </button>
        </div>
      )}
      <div className="recipes-layout">
        <aside className="recipes-list" aria-label="Saved recipes">
          <div className="recipes-list-title">
            <h2>Saved recipes</h2>
            <button
              type="button"
              aria-label="Refresh recipe library"
              disabled={loading || Boolean(busy)}
              onClick={refresh}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <label className="recipes-search">
            <Search size={14} />
            <input
              type="search"
              aria-label="Search recipes"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name or purpose…"
            />
          </label>
          <p className="helper">Available in every local project.</p>
          {loading && !recipes.length ? (
            <p role="status">Loading recipes…</p>
          ) : !matching.length ? (
            <p className="recipes-empty">
              {query
                ? "No matching recipes. Try another search."
                : "No saved recipes yet. Start with an example or create your own."}
            </p>
          ) : (
            matching.map((recipe) => (
              <button
                type="button"
                className={selected === recipe.id ? "selected" : ""}
                key={recipe.id}
                onClick={() => open(recipe.id)}
                disabled={Boolean(busy)}
                aria-current={selected === recipe.id ? "true" : undefined}
              >
                <strong>{recipe.name}</strong>
                <span>
                  {RECIPE_TARGETS[recipe.target].label} ·{" "}
                  {recipe.variables.length} input
                  {recipe.variables.length === 1 ? "" : "s"}
                </span>
                <small>{recipe.description}</small>
              </button>
            ))
          )}
        </aside>
        <div className="recipes-editor">
          {opening ? (
            <p role="status">Opening recipe…</p>
          ) : (
            <>
              <div className="recipes-selection-heading">
                <div>
                  <h2>{base ? base.name : "Create a recipe"}</h2>
                  <p>
                    {base
                      ? `${RECIPE_TARGETS[base.target].label} · saved revision ${base.revision}`
                      : "Give a repeatable task a name and choose where to use it."}
                  </p>
                </div>
                {base && (
                  <div className="recipes-tools">
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setEditing(!editing);
                        setPreview(null);
                      }}
                    >
                      <Pencil size={14} />
                      {editing ? "Use recipe" : "Edit recipe"}
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(busy) || dirty}
                      onClick={duplicate}
                    >
                      <Copy size={14} />
                      Duplicate
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {confirmDelete && (
                <div
                  className="recipes-delete-confirm"
                  role="group"
                  aria-label="Confirm recipe deletion"
                >
                  <p>
                    Delete “{base.name}” from the recipe library? Workspace
                    drafts already opened from it will remain.
                  </p>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={remove}
                  >
                    Delete recipe
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep recipe
                  </button>
                </div>
              )}
              {conflict && (
                <p className="recipes-warning" role="alert">
                  The saved recipe is now revision {remote.revision}; your draft
                  still uses revision {base.revision}. Compare the saved
                  version, then reload before replacing it.
                </p>
              )}
              {(editing || !base) && (
                <div className="recipes-definition">
                  <label>
                    Recipe name
                    <input
                      aria-label="Recipe name"
                      maxLength={100}
                      value={draft.name}
                      disabled={Boolean(busy)}
                      onChange={(event) => edit({ name: event.target.value })}
                    />
                  </label>
                  <label>
                    Purpose
                    <input
                      aria-label="Recipe purpose"
                      maxLength={500}
                      value={draft.description}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        edit({ description: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Destination
                    <select
                      aria-label="Recipe destination"
                      value={draft.target}
                      disabled={Boolean(busy)}
                      onChange={(event) => edit({ target: event.target.value })}
                    >
                      {Object.entries(RECIPE_TARGETS).map(([id, target]) => (
                        <option value={id} key={id}>
                          {target.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Prompt template
                    <textarea
                      aria-label="Prompt template"
                      rows={7}
                      maxLength={8000}
                      value={draft.template}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        edit({ template: event.target.value })
                      }
                      placeholder="Explain {{topic}} for {{audience}}, with one practical example."
                    />
                  </label>
                  <p className="helper">
                    Use {"{{topic}}"} for an input. Up to 8 different inputs;
                    repeats use the same value. Substitution uses plain text.
                  </p>
                  <p
                    className={
                      parsed.error || [...draft.template].length > limit
                        ? "recipes-warning"
                        : "helper"
                    }
                  >
                    {parsed.error ||
                      `${[...draft.template].length.toLocaleString()} / ${limit.toLocaleString()} template characters · ${parsed.variables.length} inputs`}
                  </p>
                  {remote && dirty && (
                    <details className="recipes-compare">
                      <summary>
                        Compare saved revision {remote.revision}
                      </summary>
                      <strong>{remote.name}</strong>
                      <p>
                        {remote.description} ·{" "}
                        {RECIPE_TARGETS[remote.target].label}
                      </p>
                      <pre>{remote.template}</pre>
                    </details>
                  )}
                  <div className="recipes-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        Boolean(busy) ||
                        !valid ||
                        conflict ||
                        (!dirty && Boolean(base))
                      }
                      onClick={() => save()}
                    >
                      <Save size={14} />
                      {busy === "save" ? "Saving…" : "Save recipe"}
                    </button>
                    {base && dirty && (
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          const saved = remote || base;
                          setBase(saved);
                          setDraft(recipeFields(saved));
                          remember(recipeFields(saved), saved);
                          setError("");
                        }}
                      >
                        Discard recipe edits
                      </button>
                    )}
                    {base && (
                      <button
                        type="button"
                        disabled={Boolean(busy) || !valid}
                        onClick={() => save(true)}
                      >
                        Save as new recipe
                      </button>
                    )}
                  </div>
                </div>
              )}
              {base && !editing && (
                <div className="recipes-use">
                  <p>{base.description}</p>
                  {dirty ? (
                    <p className="recipes-warning">
                      Save or discard your template edits before previewing this
                      recipe.
                    </p>
                  ) : (
                    <>
                      {vars.map((name) => (
                        <label key={name}>
                          {name.replaceAll("_", " ")}
                          <textarea
                            rows={2}
                            aria-label={`Recipe input ${name}`}
                            maxLength={8000}
                            value={
                              Object.hasOwn(values, name) ? values[name] : ""
                            }
                            disabled={busy === "use"}
                            onChange={(event) => {
                              const next = {
                                ...values,
                                [name]: event.target.value,
                              };
                              setValues(next);
                              inputs.set(keyFor(projectId, selected), next);
                              if (inputs.size > 100)
                                inputs.delete(inputs.keys().next().value);
                              setPreview(null);
                              setNotice("");
                            }}
                          />
                        </label>
                      ))}
                      {!vars.length && (
                        <p>
                          This recipe has no inputs. Preview its complete task
                          before opening a draft.
                        </p>
                      )}
                      <p className="helper">
                        Draft destination:{" "}
                        {project?.name || "your selected project"}. Model,
                        document and project brief choices stay under the
                        destination workspace’s controls.
                      </p>
                      <button
                        type="button"
                        disabled={Boolean(busy) || missing || conflict}
                        onClick={() => render()}
                      >
                        <Eye size={14} />
                        {busy === "preview"
                          ? "Rendering preview…"
                          : "Preview task"}
                      </button>
                      {readyPreview && (
                        <div className="recipes-preview">
                          <h3>Task preview</h3>
                          <pre aria-label="Rendered recipe task">
                            {readyPreview.prompt}
                          </pre>
                          <p>
                            {[...readyPreview.prompt].length.toLocaleString()} /{" "}
                            {(
                              base.prompt_limit ||
                              RECIPE_TARGETS[base.target].limit
                            ).toLocaleString()}{" "}
                            characters
                          </p>
                          <button
                            type="button"
                            className="primary"
                            disabled={Boolean(busy) || !onUse}
                            onClick={() => render(true)}
                          >
                            <ArrowRight size={14} />
                            {busy === "use"
                              ? "Opening draft…"
                              : `Use in ${RECIPE_TARGETS[base.target].label}`}
                          </button>
                          <small>
                            Opens an unsent draft. Review it before running or
                            generating anything.
                          </small>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <details className="recipe-examples" open={!recipes.length || undefined}>
        <summary>Example templates · customize and save your own</summary>
        <div>
          {RECIPE_EXAMPLES.map((example) => (
            <article key={example.name}>
              <span>{RECIPE_TARGETS[example.target].label}</span>
              <h3>{example.name}</h3>
              <p>{example.description}</p>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => start(example)}
              >
                Customize {example.name}
              </button>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}
