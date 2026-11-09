import { describe, expect, it } from "vitest";
import { pickLocale, isLocale } from "@/i18n/locales";
import { messagesFor, translatorFor } from "@/i18n/messages";
import en from "../messages/en.json";
import pt from "../messages/pt.json";

function leafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === "object" ? leafKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

describe("i18n", () => {
  it("picks the best supported locale from Accept-Language", () => {
    expect(pickLocale(null)).toBe("en");
    expect(pickLocale("pt-PT,pt;q=0.9,en;q=0.8")).toBe("pt");
    expect(pickLocale("pt-BR")).toBe("pt");
    expect(pickLocale("fr-FR,fr;q=0.9")).toBe("en");
    expect(pickLocale("en;q=0.5, pt;q=0.9")).toBe("pt");
    expect(pickLocale("*")).toBe("en");
    expect(isLocale("pt")).toBe(true);
    expect(isLocale("es")).toBe(false);
  });

  it("pt.json only contains keys that exist in en.json, and the founders funnel is fully translated", () => {
    const enKeys = new Set(leafKeys(en));
    const ptKeys = leafKeys(pt);
    expect(ptKeys.filter((k) => !enKeys.has(k))).toEqual([]);
    for (const ns of ["founders", "foundersThanks", "consent", "founderEmails"]) {
      const want = leafKeys((en as Record<string, Record<string, unknown>>)[ns]!, `${ns}.`);
      const have = new Set(ptKeys.filter((k) => k.startsWith(`${ns}.`)));
      expect(want.filter((k) => !have.has(k))).toEqual([]);
    }
  });

  it("falls back to English for untranslated namespaces and serves pt where it exists", () => {
    expect(messagesFor("pt").signIn.title).toBe(en.signIn.title); // not translated yet → English
    expect(translatorFor("pt", "founders")("submit")).toBe("Garantir as minhas condições de membro fundador");
    expect(translatorFor("en", "founders")("submit")).toBe("Lock in my founder deal");
    expect(translatorFor("xx", "founders")("submit")).toBe("Lock in my founder deal");
    expect(translatorFor("pt", "founderEmails")("welcomeSubject", { number: 7 })).toBe("és o membro fundador #7");
  });
});
