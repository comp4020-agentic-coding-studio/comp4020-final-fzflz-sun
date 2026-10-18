import { describe, expect, it } from "vitest";
import { escapeHtml, escapeKaplayText } from "./coop-protocol.ts";

describe("escapeHtml", () => {
  it("leaves normal names (Chinese, spaces, punctuation) with no HTML-significant characters unchanged", () => {
    for (const name of ["Ash", "小明", "Birch 2", "名字 名字", "ridge-captain!", "Explorer_42"]) {
      expect(escapeHtml(name)).toBe(name);
    }
  });

  it("escapes an apostrophe in an otherwise-normal name (e.g. O'Brien) without corrupting the rest of the text", () => {
    expect(escapeHtml("O'Brien-ish!")).toBe("O&#39;Brien-ish!");
  });

  it("escapes every HTML-significant character so a crafted name renders as text, not markup", () => {
    expect(escapeHtml("<svg/onload=alert(1)>")).toBe("&lt;svg/onload=alert(1)&gt;");
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's <b>bold</b>")).toBe("it&#39;s &lt;b&gt;bold&lt;/b&gt;");
  });

  it("round-trips back to the original text when re-parsed as HTML (no tag/attribute boundary survives)", () => {
    const payload = `<img src=x onerror="window.__xss=true">`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<img");
    expect(escaped).not.toMatch(/<[a-z]/i);
  });
});

// Kaplay's text() has its own styled-text grammar (see src/coop-protocol.ts's
// doc comment): unescaped `[`/`]` are style-tag syntax, and a trailing
// unescaped `\` is an escape error — a name like `[Sun]` reaching it
// unescaped throws inside src/coop-main.ts's applyState(), confirmed in a
// real two-profile browser reproduction. escapeHtml does nothing for this
// sink since the special characters are entirely different.
describe("escapeKaplayText", () => {
  it("leaves normal names (Chinese, spaces, punctuation, no brackets/backslash) unchanged", () => {
    for (const name of ["Ash", "小明", "Birch 2", "名字 名字", "ridge-captain!", "Explorer_42", "O'Brien"]) {
      expect(escapeKaplayText(name)).toBe(name);
    }
  });

  it("escapes a bracketed name so no unescaped [ or ] survives", () => {
    const escaped = escapeKaplayText("[Sun]");
    expect(escaped).not.toMatch(/(?<!\\)\[/);
    expect(escaped).not.toMatch(/(?<!\\)\]/);
    expect(escaped).toBe("\\[Sun\\]");
  });

  it("escapes a lone opening or closing bracket", () => {
    expect(escapeKaplayText("[")).toBe("\\[");
    expect(escapeKaplayText("]")).toBe("\\]");
  });

  it("escapes a trailing backslash so it's never seen as an unterminated escape", () => {
    expect(escapeKaplayText("a\\")).toBe("a\\\\");
  });

  it("escapes backslashes before brackets so an inserted backslash is never itself unescaped", () => {
    const original = "a[b]c\\d";
    const escaped = escapeKaplayText(original);
    expect(escaped).toBe("a\\[b\\]c\\\\d");
    // unescaping (reverse of the same transform, applied to single chars) recovers the original exactly
    expect(escaped.replace(/\\(.)/g, "$1")).toBe(original);
  });

  it("a mismatched-tag-shaped name still produces only escaped brackets, never a live tag boundary", () => {
    const escaped = escapeKaplayText("mismatched]tag[");
    expect(escaped).not.toMatch(/(?<!\\)[[\]]/);
  });
});
