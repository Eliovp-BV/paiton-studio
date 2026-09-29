const child = (id, label, icon, description) => ({
  id,
  label,
  icon,
  description,
});
export const NAVIGATION = [
  { id: "home", label: "Home", icon: "Home" },
  {
    id: "chat",
    label: "Chat",
    icon: "MessageSquare",
    route: "chat",
    children: [
      child(
        "chat",
        "Conversations",
        "MessageSquare",
        "Talk with your local models",
      ),
      child("agents", "Assistants", "Bot", "Create reusable local assistants"),
    ],
  },
  {
    id: "create",
    label: "Create",
    icon: "Palette",
    route: "image",
    children: [
      child("image", "Image", "Image", "Generate or edit images"),
      child("video", "Video", "Film", "Animate images and create video"),
      child(
        "write",
        "Writing",
        "PenLine",
        "Draft articles, scripts and captions",
      ),
      child("page", "Website", "PanelsTopLeft", "Design and preview a website"),
      child(
        "delivery",
        "Reels & shorts",
        "Smartphone",
        "Prepare media for sharing",
      ),
    ],
  },
  {
    id: "projects",
    label: "Projects",
    icon: "Folder",
    route: "projects",
    children: [
      child(
        "projects",
        "Project overview",
        "Folder",
        "Your project, sources and saved work",
      ),
      child(
        "coding",
        "Files",
        "Code2",
        "Edit project files with your local assistant",
      ),
      child(
        "library",
        "All creations",
        "Library",
        "Browse saved project creations",
      ),
    ],
  },
  {
    id: "models",
    label: "Models",
    icon: "Boxes",
    route: "tools",
    children: [
      child(
        "tools",
        "Installed models",
        "Boxes",
        "Review compatible models and packages",
      ),
      child(
        "model-setup",
        "Setup & downloads",
        "Download",
        "Install or connect local models",
      ),
      child(
        "model-defaults",
        "Default choices",
        "Settings2",
        "Choose models for new requests",
      ),
      child(
        "model-memory",
        "Keep ready",
        "Cpu",
        "Manage loaded models and memory",
      ),
      child(
        "runtime-packages",
        "Runtime packages",
        "Package",
        "Verify pinned runtime images",
      ),
    ],
  },
  {
    id: "connect",
    label: "Connect",
    icon: "Plug",
    route: "model-api",
    children: [
      child(
        "model-api",
        "Model API",
        "Plug",
        "Use local models from an IDE or app",
      ),
      child("mcp", "MCP Servers", "Plug", "Connect assistants to other apps"),
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "Settings2",
    route: "settings",
    children: [
      child("settings", "Workspace", "Settings2", "Personalize your workspace"),
      child("system", "System & drivers", "Cpu", "Review the Studio host"),
      child("wiki", "Studio wiki", "BookOpen", "Read the built-in guide"),
    ],
  },
];
export const NAV_ROUTES = NAVIGATION.flatMap((item) => item.children || [item]);
export const routeGroup = (route) =>
  NAVIGATION.find((item) => item.children?.some((child) => child.id === route));
export function studioRoute(value) {
  const route =
    {
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
    }[value] || value;
  return [...NAV_ROUTES.map((item) => item.id), "meetings"].includes(route)
    ? route
    : "home";
}
export const MODEL_TABS = {
  "model-defaults": "preferences",
  "model-setup": "setup",
  "model-memory": "memory",
  "runtime-packages": "packages",
};
