export function modelApiConfig(origin, profile, client = "vscode") {
  const root = new URL(origin);
  if (
    !["http:", "https:"].includes(root.protocol) ||
    root.username ||
    root.password
  )
    throw Error("Use the Studio host’s HTTP or HTTPS address.");
  if (!profile?.id) throw Error("Choose an installed text model first.");
  const base = `${root.origin}/v1`;
  if (client === "vscode")
    return JSON.stringify(
      [
        {
          name: "Paiton Studio",
          vendor: "customendpoint",
          apiType: "chat-completions",
          apiKey: "${input:paitonApiKey}",
          models: [
            {
              id: profile.id,
              name: profile.package?.model || profile.label || profile.id,
              url: `${base}/chat/completions`,
              toolCalling: false,
              vision: false,
              maxInputTokens: Math.min(
                4000,
                Math.max(
                  1,
                  (profile.context || 8192) - (profile.max_tokens || 1024),
                ),
              ),
              maxOutputTokens: profile.max_tokens || 1024,
            },
          ],
        },
      ],
      null,
      2,
    );
  if (client === "continue")
    return `name: Paiton Studio\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: Paiton local chat\n    provider: openai\n    model: ${JSON.stringify(profile.id)}\n    apiBase: ${JSON.stringify(base)}\n    apiKey: \${{ secrets.PAITON_API_KEY }}\n    useResponsesApi: false\n    roles: [chat]\n    capabilities: []\n    defaultCompletionOptions:\n      contextLength: ${Math.min(4000, profile.context || 8192)}\n      maxTokens: ${profile.max_tokens || 1024}\n`;
  throw Error("Choose VS Code or Continue.");
}
