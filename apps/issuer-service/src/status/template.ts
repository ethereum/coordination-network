/** One panel on a status page: a titled box the client script rewrites by `id`. */
export interface Panel {
    id: string
    title: string
    /** Inner HTML, already escaped by the caller (see {@link keyValueTable}, {@link list}, {@link badge},
     *  {@link details}). */
    body: string
}

/** One tab of a page: the panels it holds, and the one line that introduces them. */
export interface Tab {
    key: string
    label: string
    /** Shown above the tab's panels until the reader dismisses it, then never again on that
     *  browser. One plain line. */
    intro: string
    /** A caveat the intro itself shouldn't carry, folded under it. */
    note?: string
    /** Ids of the panels this tab holds, in the order they appear. */
    panelIds: string[]
    /**
     * `"lead"` gives the first panel two thirds of the row and the second the rest, for a tab that
     * is about one thing with a reference beside it. Opt-in: a tab that names no layout keeps the
     * equal-width auto-fit grid, so a page setting this nowhere is unchanged.
     */
    layout?: "lead"
}

export interface RenderPageOptions {
    title: string
    subtitle?: string
    panels: Panel[]
    /** Vanilla JS, inlined in its own `<script>` tag at the end of the body. */
    script?: string
    /** This org's brand accent, e.g. `#1d4ed8`; overrides the default `--accent` token on `<body>`. */
    accent?: string
    /** Splits the panels across tabs; every panel id must be named by exactly one tab. Without
     *  this the panels render as one grid, as they did before tabs. */
    tabs?: Tab[]
    /** Namespaces this page's dismissed intros in `localStorage`, so the dashboard's own tabs and
     *  an org page's don't share a key. */
    tabScope?: string
}

/** Escapes text for safe inclusion in HTML. Every helper below routes untrusted values through this. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/** A label/value table, both escaped. */
export function keyValueTable(rows: [label: string, value: string][]): string {
    const body = rows
        .map(
            ([label, value]) =>
                `<tr><td class="kv-label">${escapeHtml(label)}</td><td class="kv-value">${escapeHtml(value)}</td></tr>`
        )
        .join("")
    return `<table class="kv">${body}</table>`
}

/** A plain bulleted list, each item escaped. */
export function list(items: string[]): string {
    if (items.length === 0) return `<p class="empty">None yet.</p>`
    return `<ul class="plain">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
}

/** A closed-by-default disclosure for raw detail under a panel's own caption; `summary` is
 *  escaped, `body` is inner HTML the caller already built (like {@link Panel.body} itself). */
export function details(summary: string, body: string): string {
    return `<details><summary>${escapeHtml(summary)}</summary>${body}</details>`
}

export type BadgeTone = "default" | "success" | "warning" | "danger"

/** A small status pill, e.g. for an approval or membership state. */
export function badge(label: string, tone: BadgeTone = "default"): string {
    return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`
}

/** A `<button>` the page script wires up by its `data-action`, plus any extra `data-*` attributes
 *  (e.g. an admit button's own `data-network-id`) escaped like everything else here. */
export function actionButton(label: string, action: string, data: Record<string, string> = {}): string {
    const attrs = Object.entries(data)
        .map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`)
        .join("")
    return `<button type="button" data-action="${escapeHtml(action)}"${attrs}>${escapeHtml(label)}</button>`
}

const HINT_MS = 6000

/**
 * Drives the tabs `renderPage` emits: which one is open, the one-time intros, and the hint pop a
 * page's own script raises with `showHint(key, text)` when something happened on a tab nobody is
 * looking at. It never touches a panel's body, so a page's poll keeps rewriting bodies inside
 * hidden sections exactly as it did before tabs. Inlined ahead of the page's own script.
 */
export function tabsScript(): string {
    return `
var INTRO_PREFIX = "cn.intro." + document.querySelector("[data-tab-scope]").getAttribute("data-tab-scope") + ".";
function tabs() { return Array.prototype.slice.call(document.querySelectorAll("[role=\\"tab\\"]")); }
function selectedTab() { return document.querySelector("[role=\\"tab\\"][aria-selected=\\"true\\"]").getAttribute("data-tab"); }
function keyFromHash() {
    var key = location.hash.replace(/^#/, "");
    var known = tabs().filter(function (tab) { return tab.getAttribute("data-tab") === key; });
    return known.length ? key : tabs()[0].getAttribute("data-tab");
}
function selectTab(key) {
    tabs().forEach(function (tab) {
        var open = tab.getAttribute("data-tab") === key;
        tab.setAttribute("aria-selected", open ? "true" : "false");
        tab.tabIndex = open ? 0 : -1;
        document.getElementById("tabpanel-" + tab.getAttribute("data-tab")).hidden = !open;
    });
    if (hintFor === key) clearHint();
    location.hash = key;
}
var hintFor = null;
var hintTimer = null;
function clearHint() {
    var pop = document.querySelector(".hint-pop");
    if (pop) pop.parentNode.removeChild(pop);
    if (hintTimer) clearTimeout(hintTimer);
    hintFor = null;
    hintTimer = null;
}
function showHint(key, text) {
    if (selectedTab() === key) return;
    clearHint();
    var button = document.getElementById("tab-" + key);
    var pop = document.createElement("span");
    pop.className = "hint-pop";
    pop.setAttribute("role", "status");
    pop.textContent = text;
    // The tablist is the positioned ancestor, so the pop sits under its own tab button whatever
    // the buttons wrapped to.
    pop.style.left = button.offsetLeft + "px";
    button.parentNode.appendChild(pop);
    hintFor = key;
    hintTimer = setTimeout(clearHint, ${HINT_MS});
}
// A browser with site data blocked throws on localStorage; the intro then shows every load
// rather than the page failing to open at all.
function introDismissed(key) { try { return localStorage.getItem(INTRO_PREFIX + key) !== null; } catch (err) { return false; } }
function dismissIntro(key) {
    try { localStorage.setItem(INTRO_PREFIX + key, "1"); } catch (err) { /* nothing to remember it in */ }
    document.getElementById("intro-" + key).hidden = true;
}
document.addEventListener("click", function (event) {
    if (!event.target.closest) return;
    if (event.target.closest(".hint-pop")) { clearHint(); return; }
    var intro = event.target.closest("[data-intro]");
    if (intro) { dismissIntro(intro.getAttribute("data-intro")); return; }
    var tab = event.target.closest("[role=\\"tab\\"]");
    if (tab) selectTab(tab.getAttribute("data-tab"));
});
document.addEventListener("keydown", function (event) {
    var tab = event.target.closest ? event.target.closest("[role=\\"tab\\"]") : null;
    if (!tab) return;
    var all = tabs();
    var index = all.indexOf(tab);
    var target = event.key === "ArrowLeft" ? all[(index - 1 + all.length) % all.length]
        : event.key === "ArrowRight" ? all[(index + 1) % all.length]
        : event.key === "Home" ? all[0]
        : event.key === "End" ? all[all.length - 1] : null;
    if (!target) return;
    event.preventDefault();
    selectTab(target.getAttribute("data-tab"));
    target.focus();
});
window.addEventListener("hashchange", function () { selectTab(keyFromHash()); });
tabs().forEach(function (tab) {
    var key = tab.getAttribute("data-tab");
    if (introDismissed(key)) document.getElementById("intro-" + key).hidden = true;
});
selectTab(keyFromHash());
`
}

function panelHtml(panel: Panel): string {
    return `<section class="panel" id="panel-${escapeHtml(panel.id)}"><h2>${escapeHtml(panel.title)}</h2><div class="panel-body" id="panel-body-${escapeHtml(panel.id)}">${panel.body}</div></section>`
}

function tabListHtml(tabs: Tab[]): string {
    const buttons = tabs
        .map(
            (tab, index) =>
                `<button type="button" role="tab" id="tab-${escapeHtml(tab.key)}" data-tab="${escapeHtml(tab.key)}" aria-controls="tabpanel-${escapeHtml(tab.key)}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(tab.label)}</button>`
        )
        .join("")
    return `<div class="tabs" role="tablist" aria-label="Sections">${buttons}</div>`
}

/** Every tab's section, all hidden: `tabsScript` opens the one the hash names as soon as it runs. */
function tabPanelsHtml(tabs: Tab[], panels: Panel[]): string {
    const byId = new Map(panels.map((panel) => [panel.id, panel]))
    return tabs
        .map((tab) => {
            const held = tab.panelIds.map((id) => {
                const panel = byId.get(id)
                if (!panel) throw new Error(`tab ${tab.key} names a panel the page doesn't have: ${id}`)
                return panelHtml(panel)
            })
            const note = tab.note ? details("Good to know", escapeHtml(tab.note)) : ""
            const intro =
                `<div class="tab-intro" id="intro-${escapeHtml(tab.key)}"><span>${escapeHtml(tab.intro)}</span>` +
                `<button type="button" data-intro="${escapeHtml(tab.key)}">Got it</button>${note}</div>`
            return (
                `<section role="tabpanel" id="tabpanel-${escapeHtml(tab.key)}" aria-labelledby="tab-${escapeHtml(tab.key)}" hidden>` +
                `${intro}<div class="panel-grid${tab.layout === "lead" ? " panel-grid-lead" : ""}">${held.join("")}</div></section>`
            )
        })
        .join("")
}

/**
 * Renders one framework-free HTML page: a titled header, its panels (as one grid, or split across
 * tabs), and an optional inline script. Tokens copied from `apps/web-demo/public/styles.css`, so
 * an org's status page and the stack dashboard (which imports this module too) share one look.
 */
export function renderPage({
    title,
    subtitle,
    panels,
    script,
    accent,
    tabs,
    tabScope = "page"
}: RenderPageOptions): string {
    const subtitleHtml = subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""
    const bodyStyle = accent ? ` style="--accent: ${escapeHtml(accent)}"` : ""
    const mainHtml = tabs
        ? `${tabListHtml(tabs)}\n<main class="tabbed" data-tab-scope="${escapeHtml(tabScope)}">\n${tabPanelsHtml(tabs, panels)}\n</main>`
        : `<main>\n${panels.map(panelHtml).join("")}\n</main>`

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
    --ink: #17201c;
    --muted: #66716b;
    --line: #dce3de;
    --surface: #ffffff;
    --canvas: #f4f7f4;
    --accent: #176b4d;
    --accent-soft: #dff1e9;
    --warning: #9b6b16;
    --danger: #a33b32;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
    margin: 0;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--ink);
    background: var(--canvas);
}
header { padding: 24px 28px; border-top: 4px solid var(--accent); border-bottom: 1px solid var(--line); background: var(--surface); }
header h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
header .subtitle { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
main, .panel-grid {
    padding: 24px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
}
main.tabbed { display: block; padding: 0; }
.tabs {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
}
.tabs button {
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    padding: 12px 14px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    cursor: pointer;
}
.tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
.tab-intro {
    margin: 20px 24px -8px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: 14px;
}
.tab-intro button {
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding: 5px 12px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--accent);
    cursor: pointer;
}
.tab-intro details { margin: 0; }
.hint-pop {
    position: absolute;
    top: 100%;
    margin-top: -1px;
    padding: 7px 11px;
    border-radius: 0 0 8px 8px;
    background: var(--accent);
    color: var(--surface);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
    animation: hint-pop-in 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
@keyframes hint-pop-in {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
    @keyframes hint-pop-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }
}
.org-card { border-left: 4px solid var(--org-accent); padding-left: 10px; margin-bottom: 14px; }
.org-card a { color: var(--org-accent); }
.panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px;
}
/* A tab about one thing: the first panel leads and the second sits beside it as a reference, so
   the hierarchy is in the layout rather than in a label. The auto-fit grid above cannot say this -
   its column count follows the viewport, so two panels on a wide screen both come out narrow. */
.panel-grid-lead { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
/* Capped, or a long feed in the aside stretches the panel beside it to match. */
.panel-grid-lead > .panel:not(:first-child) .panel-body { max-height: 520px; overflow-y: auto; }
@media (max-width: 900px) {
    .panel-grid-lead { grid-template-columns: 1fr; }
    .panel-grid-lead > .panel:not(:first-child) .panel-body { max-height: none; }
}
.panel h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
/* One step: a state marker, the step itself, and one figure. Three columns rather than a stack of
   paragraphs, so the eye can run down the markers, the titles or the numbers on its own. */
.flow-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    gap: 0 10px;
    align-items: start;
    padding: 12px 0;
    border-top: 1px solid var(--line);
}
.flow-row:first-child { border-top: 0; padding-top: 0; }
.flow-mark { font-size: 14px; line-height: 21px; text-align: center; color: var(--line); }
.flow-done .flow-mark { color: var(--success); }
.flow-current .flow-mark { color: var(--accent); }
.flow-title { margin: 0; font-size: 15px; line-height: 21px; font-weight: 700; }
.flow-line { margin: 2px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
.flow-aside { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.flow-stat { margin: 0; text-align: right; }
/* Tabular figures so a column of counts lines up as it changes under the poll. */
.flow-figure {
    display: block;
    font-size: 20px;
    line-height: 1.1;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}
.flow-waiting .flow-figure { color: var(--muted); }
.flow-noun { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
/* The step the demo is on: the live line and the next instruction hang off it, so there is one
   place to look rather than a panel above saying what just happened. */
.flow-current {
    margin: 0 -12px;
    padding: 12px;
    background: var(--canvas);
    box-shadow: inset 3px 0 0 var(--accent);
    border-radius: 0 8px 8px 0;
    border-top: 0;
}
.flow-live { grid-column: 2 / -1; margin: 8px 0 0; font-size: 13px; font-weight: 700; }
.flow-next { grid-column: 2 / -1; margin: 3px 0 0; font-size: 13px; font-weight: 700; color: var(--accent); }
/* Rows either side of the filled one would otherwise draw a rule against its edge. */
.flow-current + .flow-row { border-top: 0; }
.caption { margin: 0 0 10px; font-size: 14px; line-height: 1.4; }
details { margin-top: 4px; }
details summary { cursor: pointer; font-size: 12px; color: var(--muted); }
details[open] summary { margin-bottom: 8px; }
table.kv { width: 100%; border-collapse: collapse; font-size: 13px; }
table.kv td { padding: 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
table.kv td.kv-label { color: var(--muted); padding-right: 14px; white-space: nowrap; }
table.kv td.kv-value { word-break: break-all; }
ul.plain { margin: 0; padding-left: 18px; font-size: 13px; }
ul.plain li { margin-bottom: 4px; }
/* A feed of timestamped events: no bullets, the clock in tabular figures so the column is straight. */
ul.feed { margin: 0; padding: 0; list-style: none; font-size: 13px; }
ul.feed li { margin-bottom: 6px; line-height: 1.4; }
.feed-at { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
/* Divides the orgs' own events from the stack's, which are a different kind of thing. */
.feed-split {
    margin: 14px 0 10px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
}
p.empty { margin: 0; color: var(--muted); font-size: 13px; }
.badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    background: var(--accent-soft);
    color: var(--accent);
}
.badge-warning { background: #fff4d9; color: var(--warning); }
.badge-danger { background: #fbe8e6; color: var(--danger); }
.badge-default { background: var(--line); color: var(--muted); }
.actions { margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }
.actions button {
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--accent);
    cursor: pointer;
}
.actions button:disabled { opacity: 0.5; cursor: default; }
.hint { margin: 12px 0 0; color: var(--muted); font-size: 12px; }
</style>
</head>
<body${bodyStyle}>
<header>
<h1>${escapeHtml(title)}</h1>
${subtitleHtml}
</header>
${mainHtml}
<script>${script ?? ""}</script>
</body>
</html>`
}
