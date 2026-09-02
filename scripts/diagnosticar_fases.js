// Abre o portal para um ou mais codigos e imprime como o wizard marca cada fase.
// Uso: node scripts/diagnosticar_fases.js <codigo> [<codigo> ...]
import "dotenv/config";
import { chromium } from "playwright";
import {
  loadConfig,
  fillCode,
  handleCaptcha,
  clickConsultar,
  extractProcessData
} from "../consulta_status.js";

const codigos = process.argv.slice(2).map((c) => c.trim()).filter(Boolean);
if (!codigos.length) {
  console.error("Informe ao menos um codigo de consulta.");
  process.exit(1);
}

const config = loadConfig();
const browser = await chromium.launch({ headless: Boolean(config.headless) });

for (const codigo of codigos) {
  const page = await browser.newPage();
  try {
    await page.goto(config.url_consulta, {
      waitUntil: "domcontentloaded",
      timeout: config.timeout_ms
    });
    await fillCode(page, codigo);
    await handleCaptcha(page, config, null);
    if (config.use_capsolver || config.use_2captcha) await clickConsultar(page);

    await page.waitForSelector(".wizard-wrapper-item", { timeout: 60000 });
    await page.waitForTimeout(1000);

    const dump = await page.evaluate(() => ({
      itens: [...document.querySelectorAll(".wizard-wrapper-item")].map((item, index) => ({
        i: index + 1,
        classes: item.className.replace(/\s+/g, " ").trim(),
        texto: item.innerText.replace(/\s+/g, " ").trim()
      })),
      tooltips: [...document.querySelectorAll("[id*='TooltipBallon']")]
        .map((el) => el.innerText.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    }));

    console.log(`\n##### CODIGO ${codigo} #####`);
    console.table(dump.itens);
    dump.tooltips.forEach((t) => console.log(`  [tooltip] ${t}`));

    // Fecha o diagnostico com o que a extracao oficial devolveria. Nada e
    // gravado: o script apenas le a pagina.
    const extraido = await extractProcessData(page);
    console.log(`  [extracao] ${extraido.status} | posicao ${extraido.position}`
      + ` | data ${extraido.phaseDate || "-"}`);
  } catch (error) {
    console.error(`\n##### CODIGO ${codigo} — FALHOU: ${error.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

await browser.close().catch(() => {});
