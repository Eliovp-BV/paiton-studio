export const RECIPE_TARGETS = {
  chat: { label: "Chat", limit: 8000 },
  coding: { label: "Coding", limit: 1200 },
  write: { label: "Writing", limit: 2500 },
  image: { label: "Image", limit: 2500 },
  page: { label: "Build Website", limit: 2500 },
};
export const RECIPE_EXAMPLES = [
  {
    name: "Explain a topic",
    description: "Make a difficult idea approachable for a specific audience.",
    target: "chat",
    template:
      "Explain {{topic}} for {{audience}}. Start with a plain-language overview, give one concrete example, and distinguish established facts from assumptions.",
  },
  {
    name: "Review selected code",
    description: "Ask for focused feedback on code you choose in Coding.",
    target: "coding",
    template:
      "Review the selected code, focusing on {{focus}}. Explain concrete problems and their impact, then suggest the smallest useful changes. State which conclusions would need tests to confirm.",
  },
  {
    name: "Draft a useful article",
    description: "Turn a topic and audience into a clear first draft.",
    target: "write",
    template:
      "Write an article about {{topic}} for {{audience}}. Use a {{tone}} tone, clear examples and practical takeaways. Do not invent facts or quotations.",
  },
  {
    name: "Art direction",
    description: "Reuse a subject, visual style and composition recipe.",
    target: "image",
    template:
      "Create an image of {{subject}}. Visual style: {{style}}. Composition and lighting: {{composition}}.",
  },
  {
    name: "Plan a landing page",
    description: "Prepare a page brief around an offering and a goal.",
    target: "page",
    template:
      "Build a landing page for {{offering}}, aimed at {{audience}}. The main goal is {{goal}}. Organize it with a clear introduction, useful benefits and a concise call to action. Use supplied facts; mark missing details for review.",
  },
];
export const recipeFields = (recipe) => ({
  name: recipe?.name || "",
  description: recipe?.description || "",
  target: recipe?.target || "chat",
  template: recipe?.template || "",
});
export function recipeVariables(template) {
  const expression = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g;
  const remaining = template.replace(expression, "");
  if (remaining.includes("{{") || remaining.includes("}}"))
    return {
      variables: [],
      error:
        "Use inputs such as {{topic}}: start with a letter, then use letters, numbers or underscores (up to 32 characters).",
    };
  const variables = [
    ...new Set([...template.matchAll(expression)].map((match) => match[1])),
  ];
  return {
    variables,
    error:
      variables.length > 8 ? "Use at most 8 different inputs in a recipe." : "",
  };
}
