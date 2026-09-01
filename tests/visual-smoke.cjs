const path = require("node:path");

const moduleRoot = process.argv[2];
const executablePath = process.argv[3];
if (!moduleRoot) throw new Error("Pass the bundled Node modules directory.");
const { chromium } = require(path.join(moduleRoot, "playwright"));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const results = [];
  try {
    for (const width of [600, 768]) {
      const page = await browser.newPage({ viewport: { width, height: 460 } });
      await page.goto("http://127.0.0.1:8091/water-history-target-card/tests/visual-harness.html");
      await page.waitForFunction(() => window.cardReady === true);
      await page.waitForFunction(() => {
        const card = document.querySelector("water-history-target-card");
        return card?.shadowRoot?.querySelectorAll(".series-line").length > 0;
      });

      const initial = await page.evaluate(() => {
        const card = document.querySelector("water-history-target-card");
        const root = card.shadowRoot;
        const target = root.querySelector(".target-line");
        const targetY = Number(target.getAttribute("y1"));
        const matchingGrid = [...root.querySelectorAll(".grid-line")]
          .some((line) => Math.abs(Number(line.getAttribute("y1")) - targetY) < 0.01);
        return {
          label: root.querySelector(".target-label").textContent,
          stroke: getComputedStyle(target).stroke,
          strokeWidth: getComputedStyle(target).strokeWidth,
          matchingGrid,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      if (initial.label !== "Ziel · 300 L" || !initial.matchingGrid || initial.overflow) {
        throw new Error(`Initial visual invariant failed at ${width}px: ${JSON.stringify(initial)}`);
      }

      const hoverPoint = await page.evaluate(() => {
        const hit = document.querySelector("water-history-target-card")
          .shadowRoot.querySelector(".history-hit").getBoundingClientRect();
        return { x: hit.left + hit.width * 0.55, y: hit.top + hit.height * 0.85 };
      });
      await page.mouse.move(hoverPoint.x, hoverPoint.y);
      await page.waitForFunction(() => {
        const inspector = document.querySelector("water-history-target-card")
          .shadowRoot.querySelector(".history-inspector");
        return inspector.getAttribute("display") !== "none";
      });
      const inspection = await page.evaluate(() => {
        const root = document.querySelector("water-history-target-card").shadowRoot;
        const hit = root.querySelector(".history-hit");
        const box = root.querySelector(".history-tooltip-box");
        const plot = {
          left: Number(hit.getAttribute("x")),
          top: Number(hit.getAttribute("y")),
          right: Number(hit.getAttribute("x")) + Number(hit.getAttribute("width")),
          bottom: Number(hit.getAttribute("y")) + Number(hit.getAttribute("height")),
        };
        const tooltip = {
          left: Number(box.getAttribute("x")),
          top: Number(box.getAttribute("y")),
          right: Number(box.getAttribute("x")) + Number(box.getAttribute("width")),
          bottom: Number(box.getAttribute("y")) + Number(box.getAttribute("height")),
        };
        return {
          label: root.querySelector(".history-tooltip-text").textContent,
          inside: tooltip.left >= plot.left && tooltip.top >= plot.top &&
            tooltip.right <= plot.right && tooltip.bottom <= plot.bottom,
          guide: root.querySelector(".history-guide").getAttribute("x1"),
          point: root.querySelector(".history-point").getAttribute("cx"),
          serviceCalls: window.serviceCalls.length,
        };
      });
      if (!/^\d{2}:\d{2} · \d+ L$/.test(inspection.label) || !inspection.inside ||
          inspection.guide !== inspection.point || inspection.serviceCalls !== 0) {
        throw new Error(`History inspection invariant failed at ${width}px: ${JSON.stringify(inspection)}`);
      }
      await page.mouse.move(2, 2);
      await page.waitForFunction(() => {
        const inspector = document.querySelector("water-history-target-card")
          .shadowRoot.querySelector(".history-inspector");
        return inspector.getAttribute("display") === "none";
      });

      if (width === 600) {
        const points = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          const hit = root.querySelector(".target-hit").getBoundingClientRect();
          const grid = [...root.querySelectorAll(".grid-line")];
          const target200 = grid[2].getBoundingClientRect();
          return {
            from: { x: hit.left + hit.width / 2, y: hit.top + hit.height / 2 },
            to: { x: hit.left + hit.width / 2, y: target200.top + target200.height / 2 },
          };
        });
        await page.mouse.move(points.from.x, points.from.y);
        await page.mouse.down();
        const targetHasPriority = await page.evaluate(() =>
          document.querySelector("water-history-target-card").shadowRoot
            .querySelector(".history-inspector").getAttribute("display") === "none");
        if (!targetHasPriority) throw new Error("Target drag did not hide history inspection.");
        await page.mouse.move(points.to.x, points.to.y, { steps: 6 });
        await page.mouse.up();
        await page.waitForFunction(() => window.serviceCalls.length === 1);
        const committed = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          const targetY = Number(root.querySelector(".target-line").getAttribute("y1"));
          const gridY = Number([...root.querySelectorAll(".grid-line")][2].getAttribute("y1"));
          return {
            calls: window.serviceCalls,
            label: root.querySelector(".target-label").textContent,
            aligned: Math.abs(targetY - gridY) < 0.01,
          };
        });
        if (committed.calls[0].value !== 200 || committed.label !== "Ziel · 200 L" || !committed.aligned) {
          throw new Error(`Drag invariant failed: ${JSON.stringify(committed)}`);
        }
      }

      const screenshot = path.resolve(__dirname, `visual-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ width, initial, screenshot });
      await page.close();
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
