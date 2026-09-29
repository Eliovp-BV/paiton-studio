import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Home,
  MessageSquare,
  Folder,
  Palette,
  Code2,
  Bot,
  AudioLines,
  Library,
  Boxes,
  Image,
  Film,
  PenLine,
  Smartphone,
  PanelsTopLeft,
  Plug,
  ChevronDown,
  Download,
  Settings2,
  Cpu,
  Package,
  BookOpen,
  X,
} from "lucide-react";
import { NAVIGATION, routeGroup } from "./studioNavigation";
import "./studio-navigation.css";

const ICONS = {
  Home,
  MessageSquare,
  Folder,
  Palette,
  Code2,
  Bot,
  AudioLines,
  Library,
  Boxes,
  Image,
  Film,
  PenLine,
  Smartphone,
  PanelsTopLeft,
  Plug,
  Download,
  Settings2,
  Cpu,
  Package,
  BookOpen,
};
const key = "paiton-navigation-sections:v1";
function readSections(route) {
  let saved = {};
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      saved = value;
  } catch {
    /* Navigation remains usable without browser storage. */
  }
  const sections = Object.fromEntries(
    NAVIGATION.filter((item) => item.children).map((item) => [
      item.id,
      saved[item.id] === true,
    ]),
  );
  const active = routeGroup(route);
  if (active) sections[active.id] = true;
  return sections;
}
export default function StudioNavigation({
  route,
  onNavigate,
  collapsed = false,
  hidden = [],
}) {
  const [sections, setSections] = useState(() => readSections(route));
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width: 900px)").matches,
  );
  const compact = collapsed || narrow;
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const focus = requestAnimationFrame(() =>
      menuRef.current?.querySelector("[data-navigation-target]")?.focus(),
    );
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (
        event.type === "pointerdown" &&
        menuRef.current?.contains(event.target)
      )
        return;
      setMenu(null);
      if (event.type === "keydown") menu.trigger?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);
  useEffect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const group = routeGroup(route);
    if (group) setSections((old) => ({ ...old, [group.id]: true }));
  }, [route]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(sections));
    } catch {
      /* Optional convenience only. */
    }
  }, [sections]);
  return (
    <nav className="studio-navigation" aria-label="Main navigation">
      {NAVIGATION.filter((item) => !hidden.includes(item.id)).map((item) => {
        const Icon = ICONS[item.icon];
        const active = item.children
          ? item.children.some((child) => child.id === route)
          : route === item.id || (item.id === "home" && route === "meetings");
        const expanded = !compact && sections[item.id];
        return (
          <div
            className={`navigation-section${item.children ? " has-children" : ""}`}
            key={item.id}
          >
            <div className="navigation-parent">
              <button
                type="button"
                className={`nav${active ? " active" : ""}`}
                aria-label={item.label}
                title={item.label}
                aria-current={active && !expanded ? "page" : undefined}
                aria-expanded={
                  compact && item.children
                    ? menu?.item.id === item.id
                    : undefined
                }
                aria-controls={
                  compact && item.children
                    ? "compact-navigation-sections"
                    : undefined
                }
                onClick={(event) => {
                  if (compact && item.children) {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setMenu({
                      item,
                      top: Math.min(bounds.top, innerHeight - 330),
                      left: bounds.right + 8,
                      trigger: event.currentTarget,
                    });
                  }
                  if (item.children)
                    setSections((old) => ({ ...old, [item.id]: true }));
                  onNavigate(item.route || item.id);
                }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
              {item.children && !compact && (
                <button
                  type="button"
                  className="navigation-disclosure"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${item.label} sections`}
                  aria-expanded={Boolean(expanded)}
                  aria-controls={`navigation-${item.id}`}
                  onClick={() =>
                    setSections((old) => ({ ...old, [item.id]: !old[item.id] }))
                  }
                >
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
            {item.children && (
              <div
                id={`navigation-${item.id}`}
                className="navigation-children"
                hidden={!expanded}
                role="group"
                aria-label={`${item.label} sections`}
              >
                {item.children.map((child) => (
                  <button
                    type="button"
                    key={child.id}
                    className={`nav nav-child${route === child.id ? " active" : ""}`}
                    title={child.description}
                    aria-label={child.label}
                    aria-current={route === child.id ? "page" : undefined}
                    onClick={() => onNavigate(child.id)}
                  >
                    <span>{child.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {compact &&
        menu &&
        createPortal(
          <section
            className="navigation-flyout"
            id="compact-navigation-sections"
            aria-label={`${menu.item.label} sections`}
            ref={menuRef}
            style={{ top: Math.max(8, menu.top), left: menu.left }}
          >
            <header>
              <strong>{menu.item.label}</strong>
              <button
                aria-label="Close navigation sections"
                onClick={() => {
                  setMenu(null);
                  menu.trigger?.focus();
                }}
              >
                <X size={16} />
              </button>
            </header>
            {menu.item.children.map((child) => (
              <button
                key={child.id}
                data-navigation-target
                aria-current={route === child.id ? "page" : undefined}
                onClick={() => {
                  setMenu(null);
                  onNavigate(child.id);
                }}
              >
                {child.label}
              </button>
            ))}
          </section>,
          document.body,
        )}
    </nav>
  );
}

export function WorkspaceSections({ route, onNavigate }) {
  const group = routeGroup(route);
  if (!group) return null;
  return (
    <nav className="workspace-sections" aria-label={`${group.label} workspace`}>
      <span className="workspace-section-label">{group.label}</span>
      <div>
        {group.children.map((child) => {
          const Icon = ICONS[child.icon];
          return (
            <button
              type="button"
              key={child.id}
              aria-current={route === child.id ? "page" : undefined}
              className={route === child.id ? "active" : ""}
              onClick={() => onNavigate(child.id)}
            >
              <Icon size={15} />
              {child.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
