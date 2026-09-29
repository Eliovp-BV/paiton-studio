import React from "react";
import { imageRecipe, imageStyle } from "./imageRecipe";
import "./image-recipe.css";

export default function ImageRecipe({ asset }) {
  const recipe = imageRecipe(asset);
  if (!recipe) return null;
  const rows = [
    ["Style", imageStyle(recipe.style)?.label],
    ["Model", recipe.model],
    ["Operation", recipe.mode === "edit" ? "Image edit" : "Image creation"],
    ["Checkpoint", recipe.checkpointVariant],
    ["Original image", recipe.sourceName],
    ["Profile", recipe.label || recipe.profile],
    [
      "Resolution",
      recipe.width && recipe.height
        ? `${recipe.width} × ${recipe.height}`
        : null,
    ],
    ["Seed", String(recipe.seed)],
    ["Steps", recipe.steps ? String(recipe.steps) : null],
    ["Precision", recipe.precision],
    ["Runtime package", recipe.runtimeRef],
    ["Runtime image", recipe.runtimeImage],
  ].filter(([, value]) => value);
  return (
    <details className="image-recipe">
      <summary>Generation details</summary>
      <dl>
        <dt>Prompt</dt>
        <dd className="image-recipe-prompt">{recipe.prompt}</dd>
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {!recipe.runtimeImage && (
        <p className="helper">
          This older result has no saved runtime image identity.
        </p>
      )}
      <p className="helper">
        Reuse restores the prompt, {recipe.style ? "style, " : ""}profile and
        seed
        {recipe.mode === "edit"
          ? ", together with the original image,"
          : ""}{" "}
        for your next draft. The currently selected package will run it;
        changing packages may change the result.
      </p>
    </details>
  );
}
