#!/usr/bin/env node
// Generates localized SEO variants of qr.html (the EN master) into www/<lang>/qr.html.
// Only the SEO shell differs per language (lang attr, <title>/meta/og, hreflang cluster,
// WebApplication + FAQPage JSON-LD, static h1/intro, default UI language, FAQ section);
// the whole app (CSS/JS/form, incl. the cs/de i18n dictionary) is shared from the master.
// Re-run after editing qr.html. EN master keeps its own hreflang/FAQ (edited in place).
//
//   node www/build-qr-i18n.mjs
//
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const MASTER = ROOT + 'qr.html';
const master = readFileSync(MASTER, 'utf8');

// Shared hreflang cluster (every page self-canonicals; alternates point to real URLs).
const CLUSTER = [
  '  <link rel="alternate" hreflang="x-default" href="https://qr.cz-agents.dev/">',
  '  <link rel="alternate" hreflang="en" href="https://qr.cz-agents.dev/">',
  '  <link rel="alternate" hreflang="cs" href="https://qr.cz-agents.dev/cs/">',
  '  <link rel="alternate" hreflang="de" href="https://qr.cz-agents.dev/de/">',
].join('\n');

const LANGS = {
  cs: {
    ogLocale: 'cs_CZ',
    canonical: 'https://qr.cz-agents.dev/cs/',
    title: 'QR platba: generátor QR kódu zdarma (SPAYD i SEPA)',
    desc: 'Vytvořte QR kód k platbě z čísla účtu (IBAN) nebo z vyfocené faktury. Český SPAYD i evropský SEPA (EPC/GiroCode). Vše běží ve vašem prohlížeči — žádné údaje neodesíláme.',
    ogDesc: 'Vytvořte QR kód k platbě z IBANu nebo z vyfocené faktury. Český SPAYD i evropský SEPA. Vše běží ve vašem prohlížeči.',
    appName: 'Generátor QR platby',
    appDesc: 'Bezplatný generátor QR plateb (SPAYD i SEPA/EPC) běžící přímo v prohlížeči.',
    // dict title used by JS for the H1 — make it keyword-rich (replaces the master value)
    dictTitleFrom: "      title: 'Generátor evropských platebních QR kódů',",
    dictTitleTo: "      title: 'Generátor QR platby zdarma',",
    h1: 'Generátor QR platby zdarma',
    intro: 'Zadejte číslo účtu (IBAN) a částku, nebo přetáhněte snímek faktury — QR kód k platbě vytvoříte během chvilky. Vznikne český SPAYD i evropský SEPA QR (EPC/GiroCode). Vše se počítá přímo ve vašem prohlížeči, žádné údaje neopouštějí vaše zařízení.',
    subtitle: 'SEPA · SPAYD · EPC — běží ve vašem prohlížeči, váš obrázek nikdy neopustí vaše zařízení',
    faqHeading: 'Časté dotazy',
    faq: [
      ['Co je QR platba?', 'QR platba je čtvercový kód, který obsahuje platební údaje — číslo účtu, částku a variabilní symbol. Naskenujete ho v mobilní bankovní aplikaci a platba se předvyplní, takže nic nepřepisujete ručně.'],
      ['Co je SPAYD?', 'SPAYD (Short Payment Descriptor) je český standard QR platby. Přečtou ho běžné české a slovenské bankovní aplikace. Pro platby v eurech v rámci SEPA slouží formát EPC (GiroCode).'],
      ['Jak vytvořím QR kód k platbě z faktury?', 'Přetáhněte snímek faktury do nástroje. Text se rozpozná přímo ve vašem prohlížeči a předvyplní číslo účtu (IBAN) i částku. Údaje pak zkontrolujte a QR kód stáhněte nebo rovnou naskenujte v bankovní aplikaci.'],
      ['Je nástroj zdarma a bezpečný?', 'Je zdarma a bez reklam. Veškeré zpracování včetně čtení faktury probíhá ve vašem prohlížeči — žádné platební údaje se nikam neodesílají ani neukládají.'],
      ['Funguje QR kód v mojí bankovní aplikaci?', 'Český SPAYD kód přečtou běžné mobilní bankovní aplikace v ČR i na Slovensku. Pro platbu v eurech vytvořte variantu SEPA (EPC/GiroCode).'],
      ['Jaký je rozdíl mezi SPAYD a SEPA QR?', 'SPAYD je český formát (částky v korunách, variabilní a konstantní symbol). SEPA/EPC je evropský formát pro platby v eurech v rámci jednotné oblasti SEPA. Nástroj zvolí formát automaticky podle země účtu.'],
    ],
  },
  de: {
    ogLocale: 'de_DE',
    canonical: 'https://qr.cz-agents.dev/de/',
    title: 'QR-Code für Überweisung erstellen — GiroCode & SEPA (kostenlos)',
    desc: 'Kostenlos einen Zahlungs-QR-Code (GiroCode/EPC) aus IBAN oder aus einer abfotografierten Rechnung erstellen. Alles läuft in Ihrem Browser — es werden keine Daten übertragen.',
    ogDesc: 'Zahlungs-QR-Code (GiroCode/EPC) aus IBAN oder Rechnung erstellen. Alles läuft in Ihrem Browser.',
    appName: 'Zahlungs-QR-Code Generator',
    appDesc: 'Kostenloser Generator für Zahlungs-QR-Codes (GiroCode/EPC und SPAYD), der im Browser läuft.',
    dictTitleFrom: "      title: 'Generator für europäische Zahlungs-QR-Codes',",
    dictTitleTo: "      title: 'QR-Code für Überweisung erstellen',",
    h1: 'QR-Code für Überweisung erstellen',
    intro: 'Geben Sie IBAN und Betrag ein oder ziehen Sie ein Foto der Rechnung hierher — den Zahlungs-QR-Code erstellen Sie in wenigen Sekunden. Es entsteht ein europäischer GiroCode (SEPA/EPC) oder ein tschechischer SPAYD-Code. Alles wird direkt in Ihrem Browser berechnet, es werden keine Daten übertragen.',
    subtitle: 'SEPA · SPAYD · EPC — läuft in Ihrem Browser, Ihr Bild verlässt niemals Ihr Gerät',
    faqHeading: 'Häufige Fragen',
    faq: [
      ['Was ist ein GiroCode?', 'Ein GiroCode ist ein QR-Code nach dem europäischen EPC-Standard. Er enthält die Zahlungsdaten (IBAN, Betrag, Verwendungszweck). Ihre Banking-App liest ihn und füllt die Überweisung automatisch aus.'],
      ['Wie erstelle ich einen QR-Code aus einer Rechnung?', 'Ziehen Sie ein Foto oder einen Screenshot der Rechnung in das Tool. Der Text wird direkt in Ihrem Browser erkannt und IBAN sowie Betrag werden übernommen. Prüfen Sie die Daten und laden Sie den QR-Code herunter.'],
      ['Ist das Tool kostenlos und sicher?', 'Es ist kostenlos und werbefrei. Die gesamte Verarbeitung einschließlich des Auslesens der Rechnung erfolgt in Ihrem Browser — es werden keine Zahlungsdaten übertragen oder gespeichert.'],
      ['Funktioniert der QR-Code in meiner Banking-App?', 'GiroCode/EPC-Codes werden von gängigen deutschen und europäischen Banking-Apps gelesen. Für Zahlungen in Tschechien oder der Slowakei erzeugt das Tool das SPAYD-Format.'],
      ['Was ist der Unterschied zwischen GiroCode und SPAYD?', 'GiroCode (EPC) ist der europäische Standard für SEPA-Überweisungen in Euro. SPAYD ist der tschechische und slowakische Standard. Das Tool wählt das Format automatisch nach dem Land der IBAN.'],
      ['Welche Daten brauche ich?', 'Mindestens die IBAN und — für GiroCode — den Namen des Empfängers. Betrag und Verwendungszweck sind optional, machen die Überweisung aber bequemer.'],
    ],
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const warnings = [];
function sub(html, re, repl, label) {
  if (!re.test(html)) { warnings.push(`MISS: ${label}`); return html; }
  return html.replace(re, () => repl);
}

function build(lang, cfg) {
  let html = master;

  html = html.replace('<html lang="en">', `<html lang="${lang}">`);

  // --- head SEO block: <title> … <meta og:url> ---
  const head = [
    `  <title>${esc(cfg.title)}</title>`,
    `  <meta name="description" content="${esc(cfg.desc)}">`,
    '  <meta name="robots" content="index, follow">',
    `  <link rel="canonical" href="${cfg.canonical}">`,
    CLUSTER,
    `  <meta property="og:title" content="${esc(cfg.title)}">`,
    `  <meta property="og:description" content="${esc(cfg.ogDesc)}">`,
    '  <meta property="og:type" content="website">',
    `  <meta property="og:url" content="${cfg.canonical}">`,
    `  <meta property="og:locale" content="${cfg.ogLocale}">`,
  ].join('\n');
  html = sub(html, /  <title>[\s\S]*?<meta property="og:url" content="[^"]*">/, head, 'head SEO block');

  // --- WebApplication JSON-LD ---
  const webApp = `<script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": ${JSON.stringify(cfg.appName)},
      "description": ${JSON.stringify(cfg.appDesc)},
      "url": "${cfg.canonical}",
      "inLanguage": "${lang}",
      "applicationCategory": "FinanceApplication",
      "operatingSystem": "Any",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "EUR" }
    }
    </script>`;
  html = sub(html, /<script type="application\/ld\+json">\s*\{\s*"@context": "https:\/\/schema\.org",\s*"@type": "WebApplication"[\s\S]*?<\/script>/, webApp, 'WebApplication JSON-LD');

  // --- static h1 / intro / subtitle (pre-JS / no-JS) ---
  html = sub(html, /<h1 data-i18n="title">[^<]*<\/h1>/, `<h1 data-i18n="title">${esc(cfg.h1)}</h1>`, 'h1');
  html = sub(html, /<p class="subtitle" data-i18n="intro">[\s\S]*?<\/p>/, `<p class="subtitle" data-i18n="intro">${esc(cfg.intro)}</p>`, 'intro');
  html = sub(html, /<p class="subtitle" data-i18n="subtitle">[^<]*<\/p>/, `<p class="subtitle" data-i18n="subtitle">${esc(cfg.subtitle)}</p>`, 'subtitle');

  // --- dict title → keyword H1 after JS runs ---
  if (html.includes(cfg.dictTitleFrom)) html = html.replace(cfg.dictTitleFrom, cfg.dictTitleTo);
  else warnings.push(`MISS: dict title (${lang})`);

  // --- default UI language = this page's language ---
  html = sub(html, /let L = localStorage\.qrLang;\s*if \(!L\) \{[\s\S]*?\}\s*if \(!I\[L\]\) L = 'en';/,
    `let L = localStorage.qrLang || '${lang}';\n  if (!I[L]) L = '${lang}';`, 'default L');

  // --- FAQ section + FAQPage JSON-LD (the rankable native content) ---
  const items = cfg.faq.map(([q, a]) => `      <details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n');
  const faqLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang,
    mainEntity: cfg.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  const faqBlock = `  <style>.faq{max-width:680px;margin:30px auto 0;padding:0 16px}.faq h2{font-size:18px;margin:0 0 8px}.faq details{border-top:1px solid #e5e7eb;padding:11px 0}.faq summary{cursor:pointer;font-weight:600;font-size:14.5px}.faq p{margin:8px 0 0;color:#555;font-size:14px;line-height:1.55}</style>
  <section class="faq" aria-labelledby="faq-h">
    <h2 id="faq-h">${esc(cfg.faqHeading)}</h2>
${items}
  </section>
  <script type="application/ld+json">
${JSON.stringify(faqLd, null, 2)}
  </script>
`;
  html = sub(html, /  <footer>/, faqBlock + '  <footer>', 'FAQ inject');

  const out = `${ROOT}${lang}/qr.html`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return out;
}

for (const [lang, cfg] of Object.entries(LANGS)) {
  const out = build(lang, cfg);
  console.log(`✅ ${lang} → ${out}`);
}
if (warnings.length) { console.error('\n⚠ WARNINGS:\n' + warnings.join('\n')); process.exit(1); }
console.log('\nDone. EN master (qr.html) hreflang/FAQ edited separately.');
