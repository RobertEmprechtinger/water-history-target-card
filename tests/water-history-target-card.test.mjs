import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TargetInteractionController,
  WaterHistoryTargetCard,
  averagePositiveIncreaseRate,
  buildStatisticsRequest,
  capturePointer,
  keyboardTarget,
  nearestHistoryPoint,
  normalizeCardConfig,
  normalizeStatisticsResponse,
  normalizeTargetInput,
  releasePointer,
  smoothAreaPath,
  smoothLinePath,
  snapValue,
  splitSeriesByGap,
  tooltipPosition,
  valueFromY,
} from "../water-history-target-card.js";

const BASE = {
  entity: "sensor.water",
  target_entity: "input_number.water_target",
};

test("browser source has one card, one service callsite, and no eval or remote loader", () => {
  const source = readFileSync(
    new URL("../water-history-target-card.js", import.meta.url),
    "utf8",
  );
  assert.equal((source.match(/<ha-card>/g) || []).length, 1);
  assert.equal((source.match(/\.callService\(/g) || []).length, 1);
  assert.match(source, /stroke-width:\s*1;/);
  assert.match(source, /const hitHeight = Math\.min\(72,/);
  assert.match(source, /<rect class="target-hit"/);
  assert.match(source, /Ziel: —/);
  assert.match(source, /Ø Anstieg \(60 min\): —/);
  assert.match(source, /<dialog class="target-dialog"/);
  assert.match(source, /window\.addEventListener\("pointermove"/);
  assert.match(source, /window\.addEventListener\("pageshow"/);
  assert.match(source, /window\.addEventListener\("online"/);
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(source, /class="history-hit"/);
  assert.match(source, /font-size:\s*14px;/);
  assert.doesNotMatch(source, /target-label|Ziel ·/);
  assert.match(source, /\.target-header\s*\{[^}]*color:\s*var\(--primary-text-color\);/s);
  assert.match(source, /\.target-line\s*\{[^}]*stroke:\s*#607d8b;/s);
  assert.match(
    source,
    /background:\s*var\(--ha-card-background,\s*var\(--card-background-color,\s*#fff\)\);/,
  );
  assert.doesNotMatch(source, /#e53935/i);
  assert.match(source, /recorder\/statistics_during_period/);
  assert.doesNotMatch(
    source,
    /new Function|\beval\s*\(|document\.head|<script\b|\.src\s*=|\bfetch\s*\(|createCardElement|hui-/,
  );
});

test("configuration defaults are generic and validated", () => {
  assert.deepEqual(normalizeCardConfig(BASE), {
    ...BASE,
    config_version: 1,
    hours: 24,
    period: "5minute",
    min: 0,
    max: 500,
    step: 10,
  });
  assert.throws(() => normalizeCardConfig({ ...BASE, min: 500, max: 0 }), /max/);
  assert.throws(() => normalizeCardConfig({ ...BASE, period: "minute" }), /period/);
  assert.throws(() => normalizeCardConfig({ ...BASE, config_version: 2 }), /config_version/);
  assert.throws(() => normalizeCardConfig({ entity: "sensor.water" }), /target_entity/);
  assert.throws(() => normalizeCardConfig({ ...BASE, target_entity: "sensor.water_target" }), /input_number/);
  assert.throws(() => normalizeCardConfig({ ...BASE, target_entity: "input_number." }), /input_number/);
});

test("target values clamp and snap to ten liters", () => {
  assert.equal(snapValue(-7, 0, 500, 10), 0);
  assert.equal(snapValue(204, 0, 500, 10), 200);
  assert.equal(snapValue(206, 0, 500, 10), 210);
  assert.equal(snapValue(507, 0, 500, 10), 500);
  assert.equal(valueFromY(0, 0, 200, 0, 500, 10), 500);
  assert.equal(valueFromY(120, 0, 200, 0, 500, 10), 200);
  assert.equal(valueFromY(250, 0, 200, 0, 500, 10), 0);
});

test("typed target values require range and exact ten-liter steps", () => {
  assert.equal(normalizeTargetInput("0", 0, 500, 10), 0);
  assert.equal(normalizeTargetInput("200", 0, 500, 10), 200);
  assert.equal(normalizeTargetInput("500", 0, 500, 10), 500);
  assert.equal(normalizeTargetInput("200,0", 0, 500, 10), 200);
  assert.equal(normalizeTargetInput("", 0, 500, 10), null);
  assert.equal(normalizeTargetInput("205", 0, 500, 10), null);
  assert.equal(normalizeTargetInput("-10", 0, 500, 10), null);
  assert.equal(normalizeTargetInput("510", 0, 500, 10), null);
  assert.equal(normalizeTargetInput("not a number", 0, 500, 10), null);
});

test("statistics request is a 24-hour five-minute mean request", () => {
  const config = normalizeCardConfig(BASE);
  const end = Date.parse("2026-09-01T12:00:00.000Z");
  assert.deepEqual(buildStatisticsRequest(config, end), {
    type: "recorder/statistics_during_period",
    start_time: "2026-08-31T12:00:00.000Z",
    end_time: "2026-09-01T12:00:00.000Z",
    statistic_ids: ["sensor.water"],
    period: "5minute",
    types: ["mean"],
  });
});

test("short chart windows still request enough history for the 60-minute average", () => {
  const end = Date.parse("2026-09-01T12:00:00.000Z");
  const request = buildStatisticsRequest(normalizeCardConfig({ ...BASE, hours: 0.5 }), end);
  assert.equal(request.start_time, "2026-09-01T10:55:00.000Z");
  assert.equal(request.end_time, "2026-09-01T12:00:00.000Z");
});

test("statistics normalization handles seconds, milliseconds, ISO, invalid and duplicate rows", () => {
  const result = normalizeStatisticsResponse({
    "sensor.water": [
      { start: 1_700_000_000, end: "invalid", mean: "200" },
      { start: 1_700_000_000_000, mean: 210 },
      { start: "2023-11-14T22:20:00Z", mean: 220 },
      { start: "invalid", mean: 230 },
      { start: 1_700_000_600, mean: null },
    ],
  }, "sensor.water");
  assert.deepEqual(result, [
    { timestamp: 1_700_000_000_000, value: 210 },
    { timestamp: 1_700_000_400_000, value: 220 },
  ]);
});

test("recorder means use interval ends so a boundary increase remains visible", () => {
  const period = 5 * 60 * 1000;
  const start = Date.parse("2026-09-01T11:00:00.000Z");
  const records = Array.from({ length: 13 }, (_, index) => ({
    start: start + (index - 1) * period,
    end: start + index * period,
    mean: index === 0 ? 100 : 120,
  }));
  const points = normalizeStatisticsResponse({
    "sensor.water": records,
  }, "sensor.water");

  assert.equal(points[0].timestamp, start);
  assert.equal(points.at(-1).timestamp, start + 60 * 60 * 1000);
  assert.equal(averagePositiveIncreaseRate(points, start + 60 * 60 * 1000), 20);
});

test("live recorder fixture stays positive after interval-end normalization", () => {
  const period = 5 * 60 * 1000;
  const firstStart = Date.parse("2026-09-05T13:15:00.000Z");
  const means = [
    142.15, 146.336, 149.19, 149.19, 148.564, 152.291, 158.1,
    158.1, 158.851, 160.231, 160.61, 160.61, 160.173,
  ];
  const points = normalizeStatisticsResponse({
    "sensor.water": means.map((mean, index) => ({
      start: firstStart + index * period,
      end: firstStart + (index + 1) * period,
      mean,
    })),
  }, "sensor.water");
  points.push({
    timestamp: Date.parse("2026-09-05T14:21:43.254Z"),
    value: 172.67,
  });

  const rate = averagePositiveIncreaseRate(
    points,
    Date.parse("2026-09-05T14:21:53.362Z"),
    60 * 60 * 1000,
    period,
  );
  assert.ok(Math.abs(rate - 30.001222226666663) < 1e-9);
});

test("60-minute average counts only positive tank changes", () => {
  const minute = 60 * 1000;
  const values = [100, 110, 105, 120, 120, 118, 118, 118, 118, 118, 118, 118, 118];
  const points = values.map((value, index) => ({
    timestamp: index * 5 * minute,
    value,
  }));
  assert.equal(averagePositiveIncreaseRate(points, 60 * minute), 25);
});

test("60-minute average returns zero for reductions and plateaus", () => {
  const minute = 60 * 1000;
  const points = Array.from({ length: 13 }, (_, index) => ({
    timestamp: index * 5 * minute,
    value: 200 - index,
  }));
  points[7].value = points[6].value;
  assert.equal(averagePositiveIncreaseRate(points, 60 * minute), 0);
});

test("60-minute average weights the cutoff interval and rejects sparse history", () => {
  const minute = 60 * 1000;
  const boundaryPoints = [
    { timestamp: -5 * minute, value: 100 },
    { timestamp: 5 * minute, value: 120 },
    ...Array.from({ length: 11 }, (_, index) => ({
      timestamp: (10 + index * 5) * minute,
      value: 120,
    })),
  ];
  assert.equal(averagePositiveIncreaseRate(boundaryPoints, 60 * minute), 10);

  const sparsePoints = [
    { timestamp: 0, value: 100 },
    { timestamp: 5 * minute, value: 110 },
    { timestamp: 40 * minute, value: 200 },
    { timestamp: 45 * minute, value: 210 },
    { timestamp: 50 * minute, value: 220 },
    { timestamp: 55 * minute, value: 230 },
    { timestamp: 60 * minute, value: 240 },
  ];
  assert.equal(averagePositiveIncreaseRate(sparsePoints, 60 * minute), null);
  assert.equal(averagePositiveIncreaseRate(sparsePoints.slice(0, 1), 60 * minute), null);

  const minimumCoverage = Array.from({ length: 12 }, (_, index) => ({
    timestamp: (5 + index * 5) * minute,
    value: 100,
  }));
  const insufficientCoverage = minimumCoverage.slice(1);
  assert.equal(averagePositiveIncreaseRate(minimumCoverage, 60 * minute), 0);
  assert.equal(averagePositiveIncreaseRate(insufficientCoverage, 60 * minute), null);
});

test("increase header includes the live tank value as the newest point", () => {
  const minute = 60 * 1000;
  const end = 60 * minute;
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._history = Array.from({ length: 12 }, (_, index) => ({
    timestamp: index * 5 * minute,
    value: 100,
  }));
  card._hass = {
    states: { "sensor.water": {
      state: "125",
      last_updated: new Date(end).toISOString(),
    } },
  };
  card._increaseHeader = { textContent: "" };
  card._drawIncrease(end);
  assert.equal(card._increaseHeader.textContent, "Ø Anstieg (60 min): +25 L/h");

  card._hass.states["sensor.water"].last_updated =
    new Date(end + minute).toISOString();
  card._drawIncrease(end);
  assert.equal(card._increaseHeader.textContent, "Ø Anstieg (60 min): +25 L/h");

  card._hass.states["sensor.water"].last_updated =
    new Date(end + 6 * minute).toISOString();
  card._drawIncrease(end);
  assert.equal(card._increaseHeader.textContent, "Ø Anstieg (60 min): 0 L/h");
});

test("increase header ignores a live reduction and rejects a stale live endpoint", () => {
  const minute = 60 * 1000;
  const end = 60 * minute;
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._increaseHeader = { textContent: "" };
  card._history = Array.from({ length: 12 }, (_, index) => ({
    timestamp: index * 5 * minute,
    value: 100,
  }));
  card._hass = {
    states: { "sensor.water": {
      state: "90",
      last_updated: new Date(end).toISOString(),
    } },
  };
  card._drawIncrease(end);
  assert.equal(card._increaseHeader.textContent, "Ø Anstieg (60 min): 0 L/h");

  card._history = card._history.slice(0, 11);
  card._hass.states["sensor.water"] = {
    state: "125",
    last_updated: new Date(52 * minute).toISOString(),
  };
  card._drawIncrease(end);
  assert.equal(card._increaseHeader.textContent, "Ø Anstieg (60 min): —");
});

test("series gaps are not bridged and smooth paths stay bounded", () => {
  const points = [
    { timestamp: 0, value: 100 },
    { timestamp: 300_000, value: 120 },
    { timestamp: 2_000_000, value: 140 },
  ];
  assert.deepEqual(splitSeriesByGap(points, 300_000).map((part) => part.length), [2, 1]);
  const mapped = [{ x: 10, y: 50 }, { x: 20, y: 10 }, { x: 30, y: 50 }];
  assert.match(smoothLinePath(mapped, 0, 60), /^M 10 50 C /);
  assert.match(smoothAreaPath(mapped, 60, 0, 60), /^M 10 60 L 10 50 C /);
  assert.match(smoothAreaPath(mapped, 60, 0, 60), /L 30 60 Z$/);
});

test("history inspection selects only nearby points and clamps its tooltip to the plot", () => {
  const period = 5 * 60 * 1000;
  const points = [
    { timestamp: 0, value: 100 },
    { timestamp: period, value: 120 },
    { timestamp: period * 3, value: 140 },
    { timestamp: period * 6, value: 180 },
  ];
  assert.equal(nearestHistoryPoint(points, period * 0.6, period * 1.5), points[1]);
  assert.equal(nearestHistoryPoint(points, period * 2, period * 1.5), null);
  assert.equal(nearestHistoryPoint(points, period * 4.5, period * 1.5), null);
  assert.equal(nearestHistoryPoint(points, period * 6, period * 1.5), points[3]);

  const plot = { left: 46, right: 582, top: 14, bottom: 218 };
  for (const position of [
    tooltipPosition(46, 14, 110, 30, plot),
    tooltipPosition(582, 218, 110, 30, plot),
  ]) {
    assert.ok(position.x >= plot.left + 4);
    assert.ok(position.x + 110 <= plot.right - 4);
    assert.ok(position.y >= plot.top + 4);
    assert.ok(position.y + 30 <= plot.bottom - 4);
  }
});

test("history touch and pen inspection accepts taps but yields to scrolling and target drag", () => {
  const card = new WaterHistoryTargetCard();
  const inspected = [];
  card._controller = { cancelAll: () => {}, pointerId: null };
  card._scheduleDraw = () => {};
  card._inspectHistoryAt = (event) => {
    inspected.push(event.pointerId);
    card._historyInspection = event.pointerId;
    return true;
  };

  card._onHistoryPointerDown({
    button: 0, clientX: 10, clientY: 10, isPrimary: true, pointerId: 1, pointerType: "touch",
  });
  card._onHistoryPointerUp({ clientX: 16, clientY: 14, pointerId: 1, pointerType: "touch" });
  assert.deepEqual(inspected, [1]);
  card._onHistoryPointerLeave({ pointerId: 1, pointerType: "touch" });
  assert.equal(card._historyInspection, 1, "post-tap touch leave keeps the inspector visible");
  card._onHistoryPointerLeave({ pointerId: 1, pointerType: "mouse" });
  assert.equal(card._historyInspection, null, "mouse leave still hides the inspector");

  card._onHistoryPointerDown({
    button: 0, clientX: 10, clientY: 10, isPrimary: true, pointerId: 4, pointerType: "touch",
  });
  card._historyInspection = 1;
  card._onHistoryPointerLeave({ pointerId: 4, pointerType: "touch" });
  assert.equal(card._historyPointerCandidate, null);
  assert.equal(card._historyInspection, null, "touch leave before release cancels the tap");

  card._onHistoryPointerDown({
    button: 0, clientX: 10, clientY: 10, isPrimary: true, pointerId: 2, pointerType: "pen",
  });
  card._onHistoryPointerMove({ clientX: 19, clientY: 10, pointerId: 2, pointerType: "pen" });
  card._onHistoryPointerUp({ clientX: 19, clientY: 10, pointerId: 2, pointerType: "pen" });
  assert.deepEqual(inspected, [1]);
  assert.equal(card._historyInspection, null);

  card._historyInspection = 1;
  card._controller.pointerId = 9;
  card._onHistoryPointerMove({ clientX: 20, clientY: 20, pointerId: 3, pointerType: "mouse" });
  assert.deepEqual(inspected, [1]);
  assert.equal(card._historyInspection, null);
  card._onHistoryPointerCancel({ pointerId: 3 });
  card._detachRuntime();
});

test("target overlay treats touch jitter as history tap and deliberate motion as drag", () => {
  const commits = [];
  const inspected = [];
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._geometry = { top: 14, bottom: 218 };
  card._svg = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 250 }) };
  card._targetHit = {
    focus() {},
    setPointerCapture() {},
    hasPointerCapture() { return true; },
    releasePointerCapture() {},
  };
  card._hideHistoryInspection = () => {};
  card._inspectHistoryAt = (event) => {
    inspected.push(event.pointerId);
    return true;
  };
  card._scheduleDraw = () => {};
  card._controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value, source) => commits.push({ value, source }),
  });
  card._controller.setPersisted(200);
  const event = (pointerId, clientX, clientY) => ({
    button: 0,
    cancelable: true,
    clientX,
    clientY,
    isPrimary: true,
    pointerId,
    pointerType: "touch",
    preventDefault() {},
    stopPropagation() {},
  });
  const lineAt200 = 218 - (200 / 500) * (218 - 14);

  card._onPointerDown(event(21, 200, lineAt200));
  card._onPointerMove(event(21, 212, lineAt200));
  assert.equal(card._controller.value, 200, "finger jitter must not preview a target change");
  card._onPointerUp(event(21, 212, lineAt200));
  assert.deepEqual(inspected, [21]);
  assert.deepEqual(commits, []);

  card._onPointerDown(event(22, 200, lineAt200));
  const lineAt300 = 218 - (300 / 500) * (218 - 14);
  card._onPointerMove(event(22, 200, lineAt300));
  assert.equal(card._controller.value, 300);
  card._onPointerUp(event(22, 200, lineAt300));
  assert.deepEqual(inspected, [21], "a deliberate drag must not open history inspection");
  assert.deepEqual(commits, [{ value: 300, source: "pointer" }]);
});

test("pointer drag previews locally and commits exactly once on release", () => {
  const previews = [];
  const commits = [];
  const controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onPreview: (value) => previews.push(value),
    onCommit: (value, source) => commits.push({ value, source }),
  });
  controller.setPersisted(200);
  assert.equal(controller.beginPointer(7, 227), true);
  assert.equal(controller.movePointer(8, 300), false);
  assert.equal(controller.movePointer(7, 264), true);
  assert.deepEqual(commits, []);
  assert.equal(controller.endPointer(7), true);
  assert.deepEqual(commits, [{ value: 260, source: "pointer" }]);
  assert.equal(controller.endPointer(7), false);
  assert.equal(controller.cancelPointer(7), false);
  assert.equal(previews.at(-1), 260);
});

test("pointer cancellation and unchanged release never commit", () => {
  const commits = [];
  const controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value) => commits.push(value),
  });
  controller.setPersisted(200);
  controller.beginPointer(1, 350);
  assert.equal(controller.cancelPointer(1), true);
  assert.equal(controller.value, 200);
  controller.beginPointer(2, 204);
  controller.endPointer(2);
  assert.deepEqual(commits, []);
});

test("direct target entry commits changed values exactly once", () => {
  const previews = [];
  const commits = [];
  const controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onPreview: (value) => previews.push(value),
    onCommit: (value, source) => commits.push({ value, source }),
  });
  assert.equal(controller.commitValue(300, "prompt"), false, "unknown persisted state blocks input");
  controller.setPersisted(200);
  assert.equal(controller.commitValue(300, "prompt"), true);
  assert.equal(controller.commitValue(300, "prompt"), true, "same value is accepted without a write");
  assert.deepEqual(commits, [{ value: 300, source: "prompt" }]);
  controller.beginPointer(1, 300);
  assert.equal(controller.commitValue(400, "prompt"), false, "active drag blocks prompt commits");
  controller.cancelPointer(1);
  assert.equal(previews.at(-1), 300);
});

test("header target mirrors availability and dialog validates before committing", () => {
  const commits = [];
  const closed = [];
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._targetHeader = {
    attributes: new Map(),
    disabled: false,
    textContent: "",
    setAttribute(name, value) { this.attributes.set(name, value); },
  };
  card._targetDialog = {
    open: false,
    close(reason) { closed.push(reason); },
  };
  card._targetDialogError = { textContent: "" };
  card._targetInput = {
    attributes: new Map(),
    focus() {},
    removeAttribute(name) { this.attributes.delete(name); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    value: "205",
  };
  card._scheduleDraw = () => {};
  card._controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value, source) => commits.push({ value, source }),
  });
  card._controller.setPersisted(200);

  card._updateTargetHeader(200);
  assert.equal(card._targetHeader.textContent, "Ziel: 200 L");
  assert.equal(card._targetHeader.disabled, false);
  card._onTargetFormSubmit({ preventDefault() {} });
  assert.deepEqual(commits, []);
  assert.deepEqual(closed, []);
  assert.equal(card._targetInput.attributes.get("aria-invalid"), "true");
  assert.match(card._targetDialogError.textContent, /10-L-Schritten/);

  card._targetInput.value = "300";
  card._onTargetFormSubmit({ preventDefault() {} });
  assert.deepEqual(commits, [{ value: 300, source: "prompt" }]);
  assert.deepEqual(closed, ["save"]);
  card._targetInput.value = "300";
  card._onTargetFormSubmit({ preventDefault() {} });
  assert.equal(commits.length, 1, "submitting the current value performs no extra write");

  card._updateTargetHeader("unavailable");
  assert.equal(card._targetHeader.textContent, "Ziel: —");
  assert.equal(card._targetHeader.disabled, true);
});

test("tablet drag survives SVG pointer capture failure without jumping and commits on window release", () => {
  const commits = [];
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._geometry = { top: 14, bottom: 218 };
  card._svg = { getBoundingClientRect: () => ({ top: 0, height: 250 }) };
  card._targetHit = {
    focus() {},
    setPointerCapture() { throw new Error("SVG capture unsupported"); },
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
  };
  card._hideHistoryInspection = () => {};
  card._scheduleDraw = () => {};
  card._controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value, source) => commits.push({ value, source }),
  });
  card._controller.setPersisted(200);
  const event = (clientY) => ({
    button: 0,
    cancelable: true,
    clientY,
    isPrimary: true,
    pointerId: 9,
    preventDefault() {},
    stopPropagation() {},
  });

  const lineAt200 = 218 - (200 / 500) * (218 - 14);
  card._onPointerDown(event(lineAt200 + 24));
  assert.equal(card._controller.pointerId, 9, "capture failure must not cancel the drag");
  assert.equal(card._controller.value, 200, "off-centre grab must not jump the value");
  const lineAt300 = 218 - (300 / 500) * (218 - 14);
  card._onPointerMove(event(lineAt300 + 24));
  assert.equal(card._controller.value, 300);
  assert.deepEqual(commits, [], "moving only previews");
  card._onPointerUp(event(lineAt300 + 24));
  assert.deepEqual(commits, [{ value: 300, source: "pointer" }]);
  card._onPointerUp(event(lineAt300 + 24));
  assert.equal(commits.length, 1, "release remains exactly-once");
});

test("keyboard repeats preview but commit once on key release", () => {
  const commits = [];
  const controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value, source) => commits.push({ value, source }),
  });
  controller.setPersisted(200);
  controller.keyDown("ArrowUp");
  controller.keyDown("ArrowUp");
  controller.keyDown("ArrowUp");
  assert.deepEqual(commits, []);
  assert.equal(controller.keyUp("ArrowUp"), true);
  assert.deepEqual(commits, [{ value: 230, source: "keyboard" }]);
  assert.equal(controller.keyUp("ArrowUp"), false);
  assert.equal(keyboardTarget("Home", 230, 0, 500, 10), 0);
  assert.equal(keyboardTarget("End", 230, 0, 500, 10), 500);
  assert.equal(keyboardTarget("Escape", 230, 0, 500, 10), null);
});

test("keyboard Escape or focus loss cancels the local preview without commit", () => {
  const commits = [];
  const controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value) => commits.push(value),
  });
  controller.setPersisted(200);
  controller.keyDown("ArrowUp");
  controller.keyDown("ArrowUp");
  assert.equal(controller.value, 220);
  assert.equal(controller.keyDown("Escape"), true);
  assert.equal(controller.value, 200);
  assert.deepEqual(commits, []);

  controller.keyDown("ArrowDown");
  assert.equal(controller.cancelKeyboard(), true, "blur handler uses cancelKeyboard");
  assert.equal(controller.value, 200);
  assert.deepEqual(commits, []);
});

test("pointer capture failures are contained and can cancel without commit", () => {
  const commits = [];
  const controller = new TargetInteractionController({
    min: 0,
    max: 500,
    step: 10,
    onCommit: (value) => commits.push(value),
  });
  controller.setPersisted(200);
  controller.beginPointer(9, 300);
  const throwingElement = {
    setPointerCapture() { throw new Error("capture failed"); },
    hasPointerCapture() { return true; },
    releasePointerCapture() { throw new Error("release failed"); },
  };
  assert.equal(capturePointer(throwingElement, 9), false);
  assert.equal(controller.cancelPointer(9), true);
  assert.equal(controller.value, 200);
  assert.equal(releasePointer(throwingElement, 9), false);
  assert.deepEqual(commits, []);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("only the newest target commit may update pending and error state", async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const restores = [];
  const firstHass = {
    states: { "input_number.water_target": { state: "200" } },
    callService(domain, service, data) {
      calls.push({ data, domain, hass: "first", service });
      return first.promise;
    },
  };
  const secondHass = {
    states: { "input_number.second_target": { state: "210" } },
    callService(domain, service, data) {
      calls.push({ data, domain, hass: "second", service });
      return second.promise;
    },
  };
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._hass = firstHass;
  card._controller = {
    cancelAll: () => {},
    setPersisted: (value) => restores.push(value),
  };
  card._scheduleDraw = () => {};

  card._commitTarget(250);
  card._config = normalizeCardConfig({
    entity: "sensor.second_water",
    target_entity: "input_number.second_target",
  });
  card._hass = secondHass;
  await Promise.resolve();
  assert.equal(calls[0].hass, "first", "hass is captured synchronously");
  assert.equal(calls[0].data.entity_id, "input_number.water_target");

  card._commitTarget(300);
  await Promise.resolve();
  assert.equal(calls[1].hass, "second");
  first.reject(new Error("stale failure"));
  await nextTurn();
  assert.equal(card._pendingTarget.value, 300);
  assert.equal(card._targetError, null);
  assert.deepEqual(restores, []);

  second.reject(new Error("current failure"));
  await nextTurn();
  assert.equal(card._pendingTarget, null);
  assert.equal(card._targetError, "Ziel konnte nicht gespeichert werden.");
  assert.deepEqual(restores, [210]);
  card._detachRuntime();
});

test("forced refresh re-arms while a recorder request is still loading", () => {
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._runtimeAttached = true;
  card._historyState = "loading";
  const delays = [];
  card._armHistoryRefresh = (delay) => delays.push(delay);
  card._hass = { callWS: () => Promise.resolve({}) };
  card._maybeLoadHistory(true);
  assert.deepEqual(delays, [30 * 1000]);
  card._runtimeAttached = false;
});

test("forced refresh supersedes a recorder request after its timeout", async () => {
  const base = Date.parse("2026-09-01T12:00:00.000Z");
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._runtimeAttached = true;
  card._historyState = "loading";
  card._historyLoadStartedAt = Date.now() - 31 * 1000;
  card._scheduleDraw = () => {};
  const delays = [];
  card._armHistoryRefresh = (delay) => delays.push(delay);
  let calls = 0;
  card._hass = {
    callWS() {
      calls += 1;
      return Promise.resolve({
        "sensor.water": [{ start: base, end: base + 5 * 60 * 1000, mean: 120 }],
      });
    },
  };

  card._maybeLoadHistory(true);
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(card._historyState, "ready");
  assert.equal(card._history[0].value, 120);
  assert.deepEqual(delays, [30 * 1000, 5 * 60 * 1000]);
  card._detachRuntime();
});

test("resume refresh supersedes a stranded request and ignores its late response", async () => {
  const first = deferred();
  const second = deferred();
  const base = Date.parse("2026-09-01T12:00:00.000Z");
  let calls = 0;
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._runtimeAttached = true;
  card._scheduleDraw = () => {};
  card._armHistoryRefresh = () => {};
  card._hass = {
    callWS() {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  };

  card._maybeLoadHistory(true);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(card._historyState, "loading");

  card._redrawFrame = 99;
  card._resumeHistoryRefresh();
  card._resumeHistoryRefresh();
  await Promise.resolve();
  assert.equal(calls, 2, "resume events within one second are deduplicated");
  assert.equal(card._redrawFrame, null);

  second.resolve({
    "sensor.water": [
      { start: base - 5 * 60 * 1000, end: base, mean: 100 },
      { start: base, end: base + 5 * 60 * 1000, mean: 120 },
    ],
  });
  await nextTurn();
  assert.equal(card._historyState, "ready");
  assert.deepEqual(card._history.map(({ value }) => value), [100, 120]);

  first.resolve({
    "sensor.water": [
      { start: base, end: base + 5 * 60 * 1000, mean: 999 },
    ],
  });
  await nextTurn();
  assert.deepEqual(card._history.map(({ value }) => value), [100, 120]);
  card._detachRuntime();
});

test("synchronous history errors are caught and refresh timer is lifecycle-safe", async () => {
  const card = new WaterHistoryTargetCard();
  card._config = normalizeCardConfig(BASE);
  card._runtimeAttached = true;
  card._scheduleDraw = () => {};
  card._hass = {
    callWS() { throw new Error("synchronous recorder failure"); },
  };
  card._maybeLoadHistory(true);
  await nextTurn();
  assert.equal(card._historyState, "error");
  assert.match(card._historyError, /synchronous recorder failure/);
  assert.notEqual(card._historyTimer, null);
  card._detachRuntime();
  assert.equal(card._historyTimer, null);
  assert.equal(card._runtimeAttached, false);
});
