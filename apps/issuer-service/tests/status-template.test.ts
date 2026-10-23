import assert from "node:assert/strict"
import { test } from "node:test"
import { actionButton, badge, details, keyValueTable, list, renderPage, tabsScript } from "../src/status/template"

const PANELS = [
    { id: "one", title: "Panel One", body: "<p>first</p>" },
    { id: "two", title: "Panel Two", body: "<p>second</p>" },
    { id: "three", title: "Panel Three", body: "<p>third</p>" }
]

const TABS = [
    { key: "story", label: "Story", intro: "What happens, in order.", panelIds: ["one", "two"] },
    { key: "detail", label: "Detail", intro: "The addresses behind it.", panelIds: ["three"] }
]

/** One tab's own `<section>`, sliced at the next tab's, so a panel can be asserted against the
 *  tab that holds it rather than against the page as a whole. */
function tabPanel(html: string, key: string): string {
    const start = html.indexOf(`<section role="tabpanel" id="tabpanel-${key}"`)
    assert.ok(start >= 0, `tab panel ${key} not found`)
    const next = html.indexOf(`<section role="tabpanel"`, start + 1)
    return html.slice(start, next === -1 ? html.indexOf("</main>", start) : next)
}

test("renderPage includes the title, subtitle, and every panel's title and body", () => {
    const html = renderPage({
        title: "Member A status",
        subtitle: "0xabc",
        panels: [
            { id: "one", title: "Panel One", body: "<p>first</p>" },
            { id: "two", title: "Panel Two", body: "<p>second</p>" }
        ]
    })

    assert.match(html, /<title>Member A status<\/title>/)
    assert.match(html, /Member A status/)
    assert.match(html, /0xabc/)
    assert.match(html, /Panel One/)
    assert.match(html, /<p>first<\/p>/)
    assert.match(html, /Panel Two/)
    assert.match(html, /<p>second<\/p>/)
    assert.match(html, /id="panel-body-one"/)
    assert.match(html, /id="panel-body-two"/)
})

test("renderPage inlines the script verbatim", () => {
    const html = renderPage({ title: "t", panels: [], script: "console.log('hi')" })

    assert.match(html, /console\.log\('hi'\)/)
})

test("renderPage sets --accent on <body> when given an accent, and escapes it", () => {
    const html = renderPage({ title: "t", panels: [], accent: "#1d4ed8" })

    assert.match(html, /<body style="--accent: #1d4ed8">/)
})

test("renderPage leaves <body> plain when no accent is given", () => {
    const html = renderPage({ title: "t", panels: [] })

    assert.match(html, /<body>/)
    assert.doesNotMatch(html, /<body style=/)
})

test("keyValueTable escapes both labels and values", () => {
    const html = keyValueTable([["<script>", "\"onload='x'\""]])

    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /&quot;onload=&#39;x&#39;&quot;/)
})

test("list escapes every item and renders an empty state for no items", () => {
    const html = list(["<img src=x onerror=alert(1)>"])
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /&lt;img/)

    assert.match(list([]), /None yet\./)
})

test("badge escapes its label and applies the requested tone class", () => {
    const html = badge("<b>danger</b>", "danger")

    assert.doesNotMatch(html, /<b>/)
    assert.match(html, /&lt;b&gt;danger&lt;\/b&gt;/)
    assert.match(html, /badge-danger/)
})

test("details wraps its body in a closed <details>, escaping the summary but not the pre-built body", () => {
    const html = details("<b>cap</b>", "<p>raw</p>")

    assert.doesNotMatch(html, /<b>cap<\/b>/)
    assert.match(html, /<summary>&lt;b&gt;cap&lt;\/b&gt;<\/summary>/)
    assert.match(html, /<p>raw<\/p>/)
    assert.doesNotMatch(html, /<details open>/)
})

test("actionButton renders its action as data-action and any extra data attributes", () => {
    const html = actionButton("Admit", "admit", { "network-id": "0xabc" })

    assert.match(html, /<button type="button" data-action="admit" data-network-id="0xabc">Admit<\/button>/)
})

test("actionButton escapes the label, the action, and every data attribute", () => {
    const html = actionButton(`<b>"'`, `<i>`, { "network-id": `<script>alert(1)</script>` })

    assert.doesNotMatch(html, /<b>|<i>|<script>/)
    assert.match(html, /&lt;b&gt;&quot;&#39;/)
    assert.match(html, /data-action="&lt;i&gt;"/)
    assert.match(html, /data-network-id="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/)
})

test("renderPage lays every panel out in one grid, with no tablist, when given no tabs", () => {
    const html = renderPage({ title: "t", panels: PANELS })

    assert.doesNotMatch(html, /role="tablist"/)
    assert.doesNotMatch(html, /role="tabpanel"/)
    assert.match(html, /<main>/)
})

test("renderPage emits one tab button per tab, the first selected and the rest out of the tab order", () => {
    const html = renderPage({ title: "t", panels: PANELS, tabs: TABS })

    assert.match(html, /<div class="tabs" role="tablist" aria-label="Sections">/)
    assert.match(
        html,
        /<button type="button" role="tab" id="tab-story" data-tab="story" aria-controls="tabpanel-story" aria-selected="true" tabindex="0">Story<\/button>/
    )
    assert.match(
        html,
        /<button type="button" role="tab" id="tab-detail" data-tab="detail" aria-controls="tabpanel-detail" aria-selected="false" tabindex="-1">Detail<\/button>/
    )
    assert.equal(html.match(/role="tab"/g)?.length, 2)
})

test("renderPage puts each tab's own panels in its own hidden tabpanel, and nothing else in it", () => {
    const html = renderPage({ title: "t", panels: PANELS, tabs: TABS })

    assert.equal(html.match(/<section role="tabpanel"[^>]*hidden>/g)?.length, 2)

    const story = tabPanel(html, "story")
    assert.match(story, /aria-labelledby="tab-story" hidden>/)
    assert.match(story, /id="panel-body-one"/)
    assert.match(story, /id="panel-body-two"/)
    assert.doesNotMatch(story, /id="panel-body-three"/)

    const detail = tabPanel(html, "detail")
    assert.match(detail, /id="panel-body-three"/)
    assert.doesNotMatch(detail, /id="panel-body-one"/)
})

test("renderPage gives each tab an intro with its own Got it button, and escapes the intro's text", () => {
    const html = renderPage({
        title: "t",
        panels: PANELS,
        tabs: [{ ...TABS[0], intro: "<script>alert(1)</script>" }, TABS[1]]
    })

    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
    assert.match(
        html,
        /<div class="tab-intro" id="intro-story"><span>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span><button type="button" data-intro="story">Got it<\/button><\/div>/
    )
    assert.match(tabPanel(html, "detail"), /<span>The addresses behind it\.<\/span>/)
})

test("renderPage folds a tab's note under its intro, escaped", () => {
    const html = renderPage({
        title: "t",
        panels: PANELS,
        tabs: [{ ...TABS[0], note: "These actions carry <no> authentication." }, TABS[1]]
    })

    const story = tabPanel(html, "story")
    assert.match(
        story,
        /<details><summary>Good to know<\/summary>These actions carry &lt;no&gt; authentication\.<\/details>/
    )
    assert.doesNotMatch(tabPanel(html, "detail"), /<details>/)
})

test("renderPage names the localStorage scope its intros are remembered under", () => {
    const html = renderPage({ title: "t", panels: PANELS, tabs: TABS, tabScope: "dashboard" })

    assert.match(html, /<main class="tabbed" data-tab-scope="dashboard">/)
})

test("renderPage refuses a tab naming a panel the page doesn't have", () => {
    assert.throws(
        () =>
            renderPage({
                title: "t",
                panels: PANELS,
                tabs: [{ key: "story", label: "Story", intro: "…", panelIds: ["one", "nope"] }]
            }),
        /tab story names a panel the page doesn't have: nope/
    )
})

// The doc comment on `tabs` calls for every panel id to be named by exactly one tab, but nothing
// enforces that: two tabs naming the same id both render it, rather than one being refused.
test("renderPage renders a panel once per tab that claims it when two tabs' panelIds overlap", () => {
    const html = renderPage({
        title: "t",
        panels: PANELS,
        tabs: [
            { key: "story", label: "Story", intro: "…", panelIds: ["one", "two"] },
            { key: "detail", label: "Detail", intro: "…", panelIds: ["two", "three"] }
        ]
    })

    assert.equal((html.match(/id="panel-body-two"/g) ?? []).length, 2)
    assert.ok(tabPanel(html, "story").includes('id="panel-body-two"'))
    assert.ok(tabPanel(html, "detail").includes('id="panel-body-two"'))
})

test("tabsScript inlines once and leaves every panel body alone", () => {
    const html = renderPage({ title: "t", panels: PANELS, tabs: TABS, script: `${tabsScript()}console.log('page')` })

    assert.equal(html.match(/function selectTab\(key\) \{/g)?.length, 1)
    assert.match(html, /function showHint\(key, text\) \{/)
    // The tabs never rewrite a panel: that stays the page's own poll, which keys off these ids.
    assert.doesNotMatch(tabsScript(), /panel-body-/)
})

test("renderPage does not let a panel's own title break out of its markup unescaped", () => {
    const html = renderPage({
        title: "t",
        panels: [{ id: "x", title: "<script>alert(1)</script>", body: "" }]
    })

    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
})
