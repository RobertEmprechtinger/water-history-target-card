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
        const headerTarget = root.querySelector(".target-header");
        const targetY = Number(target.getAttribute("y1"));
        const matchingGrid = [...root.querySelectorAll(".grid-line")]
          .some((line) => Math.abs(Number(line.getAttribute("y1")) - targetY) < 0.01);
        return {
          headerTarget: root.querySelector(".target-header").textContent,
          headerTargetHeight: root.querySelector(".target-header").getBoundingClientRect().height,
          headerTargetColor: getComputedStyle(headerTarget).color,
          cardBackground: getComputedStyle(root.querySelector("ha-card")).backgroundColor,
          label: root.querySelector(".target-label").textContent,
          stroke: getComputedStyle(target).stroke,
          strokeWidth: getComputedStyle(target).strokeWidth,
          matchingGrid,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      if (initial.headerTarget !== "Ziel: 300 L" || initial.headerTargetHeight < 44 ||
          initial.headerTargetColor !== "rgb(0, 0, 0)" ||
          initial.cardBackground !== "rgb(255, 255, 255)" ||
          initial.label !== "Ziel · 300 L" || !initial.matchingGrid || initial.overflow) {
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
          const line = root.querySelector(".target-line").getBoundingClientRect();
          const grid = [...root.querySelectorAll(".grid-line")];
          const target200 = grid[2].getBoundingClientRect();
          root.querySelector(".target-hit").setPointerCapture = () => {
            throw new Error("simulated SVG pointer-capture failure");
          };
          const fromY = hit.top + 5;
          const grabOffset = fromY - (line.top + line.height / 2);
          return {
            from: { x: hit.left + hit.width / 2, y: fromY },
            to: {
              x: hit.left + hit.width / 2,
              y: target200.top + target200.height / 2 + grabOffset,
            },
          };
        });
        await page.mouse.move(points.from.x, points.from.y);
        await page.mouse.down();
        const downState = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          return {
            historyHidden: root.querySelector(".history-inspector").getAttribute("display") === "none",
            label: root.querySelector(".target-label").textContent,
            calls: window.serviceCalls.length,
          };
        });
        if (!downState.historyHidden || downState.label !== "Ziel · 300 L" || downState.calls !== 0) {
          throw new Error(`Target pointer-down invariant failed: ${JSON.stringify(downState)}`);
        }
        await page.mouse.move(points.to.x, points.to.y, { steps: 6 });
        await page.mouse.up();
        await page.waitForFunction(() => window.serviceCalls.length === 1);
        const committed = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          const targetY = Number(root.querySelector(".target-line").getAttribute("y1"));
          const gridY = Number([...root.querySelectorAll(".grid-line")][2].getAttribute("y1"));
          return {
            calls: window.serviceCalls,
            headerTarget: root.querySelector(".target-header").textContent,
            label: root.querySelector(".target-label").textContent,
            aligned: Math.abs(targetY - gridY) < 0.01,
          };
        });
        if (committed.calls[0].value !== 200 || committed.headerTarget !== "Ziel: 200 L" ||
            committed.label !== "Ziel · 200 L" || !committed.aligned) {
          throw new Error(`Drag invariant failed: ${JSON.stringify(committed)}`);
        }
      } else {
        await page.locator("water-history-target-card").evaluate((card) =>
          card.shadowRoot.querySelector(".target-header").click());
        const dialog = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          const input = root.querySelector(".target-input");
          return {
            open: root.querySelector(".target-dialog").open,
            value: input.value,
            min: input.min,
            max: input.max,
            step: input.step,
          };
        });
        if (!dialog.open || dialog.value !== "300" || dialog.min !== "0" ||
            dialog.max !== "500" || dialog.step !== "10") {
          throw new Error(`Dialog opening invariant failed: ${JSON.stringify(dialog)}`);
        }
        await page.locator("water-history-target-card").evaluate((card) => {
          const input = card.shadowRoot.querySelector(".target-input");
          input.value = "205";
          card.shadowRoot.querySelector(".target-form")
            .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        });
        const invalid = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          return {
            calls: window.serviceCalls.length,
            error: root.querySelector(".target-dialog-error").textContent,
            open: root.querySelector(".target-dialog").open,
          };
        });
        if (invalid.calls !== 0 || !invalid.open || !/10-L-Schritten/.test(invalid.error)) {
          throw new Error(`Dialog validation invariant failed: ${JSON.stringify(invalid)}`);
        }
        await page.locator("water-history-target-card").evaluate((card) => {
          const input = card.shadowRoot.querySelector(".target-input");
          input.value = "200";
          card.shadowRoot.querySelector(".target-form")
            .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        });
        await page.waitForFunction(() => window.serviceCalls.length === 1);
        await page.waitForFunction(() => {
          const root = document.querySelector("water-history-target-card")?.shadowRoot;
          return root?.querySelector(".target-label")?.textContent === "Ziel · 200 L";
        });
        const dialogCommit = await page.evaluate(() => {
          const root = document.querySelector("water-history-target-card").shadowRoot;
          return {
            calls: window.serviceCalls,
            headerTarget: root.querySelector(".target-header").textContent,
            label: root.querySelector(".target-label").textContent,
            open: root.querySelector(".target-dialog").open,
          };
        });
        if (dialogCommit.calls[0].value !== 200 || dialogCommit.headerTarget !== "Ziel: 200 L" ||
            dialogCommit.label !== "Ziel · 200 L" || dialogCommit.open) {
          throw new Error(`Dialog commit invariant failed: ${JSON.stringify(dialogCommit)}`);
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
