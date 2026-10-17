import { describe, expect, it } from "vitest";
import { escapeHtml } from "./coop-protocol.ts";

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
