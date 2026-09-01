const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_TAG = "water-history-target-card";
const CHART_HEIGHT = 250;
const DEFAULT_CONFIG = Object.freeze({
  config_version: 1,
  hours: 24,
  period: "5minute",
  min: 0,
  max: 500,
  step: 10,
});
const PERIOD_MILLISECONDS = Object.freeze({
  "5minute": 5 * 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
});

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function snapValue(value, min, max, step) {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  const snapped = min + Math.round((numeric - min) / step) * step;
  return Number(clamp(snapped, min, max).toFixed(10));
}

export function valueFromY(y, plotTop, plotBottom, min, max, step) {
  if (plotBottom <= plotTop) return min;
  const ratio = clamp((plotBottom - y) / (plotBottom - plotTop), 0, 1);
  return snapValue(min + ratio * (max - min), min, max, step);
}

export function normalizeCardConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("water-history-target-card: configuration is required.");
  }
  for (const key of ["entity", "target_entity"]) {
    if (typeof config[key] !== "string" || config[key].trim() === "") {
      throw new Error(`water-history-target-card: ${key} is required.`);
    }
  }
  const normalized = {
    ...DEFAULT_CONFIG,
    ...config,
    entity: config.entity.trim(),
    target_entity: config.target_entity.trim(),
  };
  if (
    !normalized.target_entity.startsWith("input_number.") ||
    normalized.target_entity.length === "input_number.".length
  ) {
    throw new Error("water-history-target-card: target_entity must be an input_number entity.");
  }
  normalized.config_version = finiteNumber(normalized.config_version);
  if (normalized.config_version !== 1) {
    throw new Error("water-history-target-card: unsupported config_version.");
  }
  for (const key of ["hours", "min", "max", "step"]) {
    normalized[key] = finiteNumber(normalized[key]);
    if (normalized[key] === null) {
      throw new Error(`water-history-target-card: ${key} must be numeric.`);
    }
  }
  if (normalized.hours <= 0 || normalized.hours > 24 * 31) {
    throw new Error("water-history-target-card: hours must be greater than 0 and no more than 744.");
  }
  if (normalized.max <= normalized.min) {
    throw new Error("water-history-target-card: max must be greater than min.");
  }
  if (normalized.step <= 0 || normalized.step > normalized.max - normalized.min) {
    throw new Error("water-history-target-card: step is outside the axis range.");
  }
  if (!Object.hasOwn(PERIOD_MILLISECONDS, normalized.period)) {
    throw new Error(
      "water-history-target-card: period must be 5minute, hour, day, week, or month.",
    );
  }
  return normalized;
}

export function buildStatisticsRequest(config, endTime = Date.now()) {
  const end = finiteNumber(endTime);
  if (end === null) throw new Error("A finite end time is required.");
  const start = end - config.hours * 60 * 60 * 1000;
  return {
    type: "recorder/statistics_during_period",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    statistic_ids: [config.entity],
    period: config.period,
    types: ["mean"],
  };
}

export function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeStatisticsResponse(response, entity) {
  const records = Array.isArray(response)
    ? response
    : Array.isArray(response?.[entity])
      ? response[entity]
      : [];
  const byTimestamp = new Map();
  for (const record of records) {
    const timestamp = parseTimestamp(record?.start ?? record?.start_time);
    const mean = finiteNumber(record?.mean);
    if (timestamp !== null && mean !== null) {
      byTimestamp.set(timestamp, { timestamp, value: mean });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function splitSeriesByGap(points, expectedInterval, multiplier = 2.5) {
  if (points.length === 0) return [];
  const segments = [[points[0]]];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    if (point.timestamp - previous.timestamp > expectedInterval * multiplier) {
      segments.push([]);
    }
    segments.at(-1).push(point);
  }
  return segments;
}

function formatCoordinate(value) {
  return Number(value.toFixed(2));
}

export function nearestHistoryPoint(points, timestamp, maxDistance) {
  const needle = finiteNumber(timestamp);
  const limit = finiteNumber(maxDistance);
  if (!Array.isArray(points) || points.length === 0 || needle === null || limit === null || limit < 0) {
    return null;
  }
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp < needle) low = middle + 1;
    else high = middle;
  }
  const previous = points[low - 1];
  const next = points[low];
  if (
    previous && next && needle > previous.timestamp && needle < next.timestamp &&
    next.timestamp - previous.timestamp > limit
  ) {
    return null;
  }
  const candidates = [previous, next].filter((point) =>
    point && finiteNumber(point.timestamp) !== null && finiteNumber(point.value) !== null);
  if (candidates.length === 0) return null;
  const nearest = candidates.reduce((best, point) =>
    Math.abs(point.timestamp - needle) < Math.abs(best.timestamp - needle) ? point : best);
  return Math.abs(nearest.timestamp - needle) <= limit ? nearest : null;
}

export function tooltipPosition(anchorX, anchorY, width, height, plot, gap = 10, inset = 4) {
  const minX = plot.left + inset;
  const maxX = Math.max(minX, plot.right - inset - width);
  const minY = plot.top + inset;
  const maxY = Math.max(minY, plot.bottom - inset - height);
  let x = anchorX + gap;
  if (x + width > plot.right - inset) x = anchorX - gap - width;
  let y = anchorY - gap - height;
  if (y < minY) y = anchorY + gap;
  return {
    x: formatCoordinate(clamp(x, minX, maxX)),
    y: formatCoordinate(clamp(y, minY, maxY)),
  };
}

export function smoothCurveCommands(points, minY = -Infinity, maxY = Infinity) {
  if (points.length < 2) return "";
  const commands = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] ?? next;
    const control1 = {
      x: current.x + (next.x - before.x) / 6,
      y: clamp(current.y + (next.y - before.y) / 6, minY, maxY),
    };
    const control2 = {
      x: next.x - (after.x - current.x) / 6,
      y: clamp(next.y - (after.y - current.y) / 6, minY, maxY),
    };
    commands.push(
      `C ${formatCoordinate(control1.x)} ${formatCoordinate(control1.y)} ` +
      `${formatCoordinate(control2.x)} ${formatCoordinate(control2.y)} ` +
      `${formatCoordinate(next.x)} ${formatCoordinate(next.y)}`,
    );
  }
  return commands.join(" ");
}

export function smoothLinePath(points, minY = -Infinity, maxY = Infinity) {
  if (points.length === 0) return "";
  const first = points[0];
  const start = `M ${formatCoordinate(first.x)} ${formatCoordinate(first.y)}`;
  if (points.length === 1) return start;
  return `${start} ${smoothCurveCommands(points, minY, maxY)}`;
}

export function smoothAreaPath(points, baseline, minY = -Infinity, maxY = Infinity) {
  if (points.length === 0) return "";
  const first = points[0];
  const last = points.at(-1);
  const curve = smoothCurveCommands(points, minY, maxY);
  return [
    `M ${formatCoordinate(first.x)} ${formatCoordinate(baseline)}`,
    `L ${formatCoordinate(first.x)} ${formatCoordinate(first.y)}`,
    curve,
    `L ${formatCoordinate(last.x)} ${formatCoordinate(baseline)}`,
    "Z",
  ].filter(Boolean).join(" ");
}

export function keyboardTarget(key, current, min, max, step) {
  const changes = {
    ArrowUp: step,
    ArrowRight: step,
    ArrowDown: -step,
    ArrowLeft: -step,
    PageUp: step * 10,
    PageDown: -step * 10,
  };
  if (key === "Home") return min;
  if (key === "End") return max;
  if (!Object.hasOwn(changes, key)) return null;
  return snapValue(current + changes[key], min, max, step);
}

export function capturePointer(element, pointerId) {
  try {
    if (typeof element?.setPointerCapture !== "function") return false;
    element.setPointerCapture(pointerId);
    return typeof element.hasPointerCapture !== "function" ||
      element.hasPointerCapture(pointerId);
  } catch {
    return false;
  }
}

export function releasePointer(element, pointerId) {
  try {
    if (typeof element?.releasePointerCapture !== "function") return false;
    if (
      typeof element.hasPointerCapture === "function" &&
      !element.hasPointerCapture(pointerId)
    ) {
      return false;
    }
    element.releasePointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

export class TargetInteractionController {
  constructor({ min, max, step, onPreview = () => {}, onCommit = () => {} }) {
    this.min = min;
    this.max = max;
    this.step = step;
    this.onPreview = onPreview;
    this.onCommit = onCommit;
    this.persisted = null;
    this.value = null;
    this.pointerId = null;
    this.keyboardActive = false;
    this.keyboardDirty = false;
  }

  get active() {
    return this.pointerId !== null || this.keyboardActive;
  }

  setPersisted(value) {
    const normalized = snapValue(value, this.min, this.max, this.step);
    this.persisted = normalized;
    if (!this.active) {
      this.value = normalized;
      this.onPreview(normalized);
    }
  }

  beginPointer(pointerId, value) {
    if (this.active || this.persisted === null) return false;
    this.pointerId = pointerId;
    this.value = snapValue(value, this.min, this.max, this.step);
    this.onPreview(this.value);
    return true;
  }

  movePointer(pointerId, value) {
    if (this.pointerId !== pointerId) return false;
    this.value = snapValue(value, this.min, this.max, this.step);
    this.onPreview(this.value);
    return true;
  }

  endPointer(pointerId) {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    this.#commitIfChanged("pointer");
    return true;
  }

  cancelPointer(pointerId) {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    this.value = this.persisted;
    this.onPreview(this.value);
    return true;
  }

  keyDown(key) {
    if (key === "Escape") return this.cancelKeyboard();
    if (this.pointerId !== null || this.value === null) return false;
    const next = keyboardTarget(key, this.value, this.min, this.max, this.step);
    if (next === null) return false;
    this.keyboardActive = true;
    this.value = next;
    this.keyboardDirty = this.value !== this.persisted;
    this.onPreview(this.value);
    return true;
  }

  keyUp(key) {
    if (!this.keyboardActive) return false;
    if (keyboardTarget(key, this.value, this.min, this.max, this.step) === null) {
      return false;
    }
    this.keyboardActive = false;
    if (this.keyboardDirty) this.#commitIfChanged("keyboard");
    this.keyboardDirty = false;
    return true;
  }

  cancelKeyboard() {
    if (!this.keyboardActive) return false;
    this.keyboardActive = false;
    this.keyboardDirty = false;
    this.value = this.persisted;
    this.onPreview(this.value);
    return true;
  }

  cancelAll() {
    const wasActive = this.active;
    this.pointerId = null;
    this.keyboardActive = false;
    this.keyboardDirty = false;
    this.value = this.persisted;
    if (wasActive) this.onPreview(this.value);
  }

  #commitIfChanged(source) {
    if (this.value === null || this.value === this.persisted) return;
    this.persisted = this.value;
    this.onCommit(this.value, source);
  }
}

function createSvgElement(name, attributes = {}, text = null) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  if (text !== null) element.textContent = text;
  return element;
}

const HTMLElementBase = globalThis.HTMLElement ?? class {};

export class WaterHistoryTargetCard extends HTMLElementBase {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._domReady = false;
    this._runtimeAttached = false;
    this._history = [];
    this._historyState = "idle";
    this._historyError = null;
    this._targetError = null;
    this._nextHistoryRefreshAt = 0;
    this._historyGeneration = 0;
    this._historyTimer = null;
    this._geometry = null;
    this._plotPoints = [];
    this._historyInspection = null;
    this._historyPointerCandidate = null;
    this._controller = null;
    this._pendingTarget = null;
    this._pendingTimer = null;
    this._commitGeneration = 0;
    this._redrawFrame = null;
    this._runtimeAbort = null;
    this._resizeObserver = null;
    if (typeof this.attachShadow === "function") {
      this.attachShadow({ mode: "open" });
    }
  }

  setConfig(config) {
    const normalized = normalizeCardConfig(config);
    this._detachRuntime();
    this._config = normalized;
    this._history = [];
    this._historyState = "idle";
    this._historyError = null;
    this._nextHistoryRefreshAt = 0;
    this._plotPoints = [];
    this._historyInspection = null;
    this._historyPointerCandidate = null;
    this._historyGeneration += 1;
    if (this.isConnected) this._attachRuntime();
  }

  set hass(hass) {
    this._hass = hass;
    if (this.isConnected) this._attachRuntime();
    this._syncEntityStates();
    this._maybeLoadHistory();
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    this._attachRuntime();
    this._syncEntityStates();
    this._maybeLoadHistory(true);
  }

  disconnectedCallback() {
    this._detachRuntime();
  }

  _renderShell() {
    if (!this.shadowRoot || this._domReady) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          display: block;
          overflow: hidden;
          box-sizing: border-box;
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none);
        }
        .header {
          min-height: 24px;
          padding: 14px 16px 4px;
          color: var(--primary-text-color);
          font-size: 16px;
          font-weight: 500;
          line-height: 24px;
        }
        .header.unavailable { color: var(--secondary-text-color); }
        .chart { position: relative; width: 100%; height: ${CHART_HEIGHT}px; }
        svg {
          display: block;
          width: 100%;
          height: ${CHART_HEIGHT}px;
          overflow: visible;
          color: var(--secondary-text-color);
          user-select: none;
          -webkit-user-select: none;
        }
        .grid-line { stroke: var(--divider-color); stroke-width: 1; vector-effect: non-scaling-stroke; }
        .axis-label { fill: var(--secondary-text-color); font-size: 11px; }
        .area { fill: #2196f3; fill-opacity: 0.18; stroke: none; }
        .series-line {
          fill: none;
          stroke: #2196f3;
          stroke-width: 2;
          stroke-linejoin: round;
          stroke-linecap: round;
          vector-effect: non-scaling-stroke;
        }
        .history-hit {
          fill: transparent;
          pointer-events: all;
          cursor: crosshair;
          touch-action: pan-y;
        }
        .history-inspector { pointer-events: none; }
        .history-guide {
          stroke: #2196f3;
          stroke-width: 1;
          stroke-dasharray: 3 3;
          stroke-opacity: 0.65;
          vector-effect: non-scaling-stroke;
        }
        .history-point {
          fill: #2196f3;
          stroke: var(--ha-card-background, var(--card-background-color, #fff));
          stroke-width: 2;
          vector-effect: non-scaling-stroke;
        }
        .history-tooltip-box {
          fill: var(--ha-card-background, var(--card-background-color, #fff));
          stroke: #2196f3;
          stroke-width: 1;
          vector-effect: non-scaling-stroke;
        }
        .history-tooltip-text {
          fill: var(--primary-text-color);
          font-size: 14px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
        }
        .target-line {
          stroke: #e53935;
          stroke-width: 1;
          vector-effect: non-scaling-stroke;
          pointer-events: none;
        }
        .target-label {
          fill: #e53935;
          font-size: 12px;
          font-weight: 600;
          pointer-events: none;
        }
        .target-hit {
          stroke: transparent;
          stroke-width: 44;
          vector-effect: non-scaling-stroke;
          pointer-events: stroke;
          cursor: ns-resize;
          touch-action: none;
          outline: none;
        }
        .target-hit:focus-visible { stroke: color-mix(in srgb, #e53935 18%, transparent); }
        .status {
          position: absolute;
          inset: 42% 16px auto;
          color: var(--secondary-text-color);
          text-align: center;
          font-size: 12px;
          pointer-events: none;
        }
        .status.error { color: var(--error-color, #db4437); }
        [hidden] { display: none !important; }
      </style>
      <ha-card>
        <div class="header">Wasser: —</div>
        <div class="chart">
          <svg viewBox="0 0 600 ${CHART_HEIGHT}" role="img" aria-label="Wasserverlauf der letzten 24 Stunden">
            <defs><clipPath id="plot-clip"><rect></rect></clipPath></defs>
            <g class="grid"></g>
            <g class="series" clip-path="url(#plot-clip)"></g>
            <g class="history-overlay">
              <rect class="history-hit" aria-hidden="true"></rect>
              <g class="history-inspector" display="none" aria-hidden="true">
                <line class="history-guide"></line>
                <circle class="history-point" r="4"></circle>
                <g class="history-tooltip">
                  <rect class="history-tooltip-box" rx="6" ry="6"></rect>
                  <text class="history-tooltip-text"></text>
                </g>
              </g>
            </g>
            <g class="target">
              <line class="target-line"></line>
              <text class="target-label" text-anchor="end"></text>
              <line class="target-hit" tabindex="0" focusable="true" role="slider" aria-label="Zielmenge" aria-orientation="vertical"></line>
            </g>
          </svg>
          <div class="status" role="status" aria-live="polite" hidden></div>
        </div>
      </ha-card>
    `;
    this._header = this.shadowRoot.querySelector(".header");
    this._chart = this.shadowRoot.querySelector(".chart");
    this._svg = this.shadowRoot.querySelector("svg");
    this._clipRect = this.shadowRoot.querySelector("clipPath rect");
    this._gridGroup = this.shadowRoot.querySelector(".grid");
    this._seriesGroup = this.shadowRoot.querySelector(".series");
    this._historyHit = this.shadowRoot.querySelector(".history-hit");
    this._historyInspector = this.shadowRoot.querySelector(".history-inspector");
    this._historyGuide = this.shadowRoot.querySelector(".history-guide");
    this._historyPoint = this.shadowRoot.querySelector(".history-point");
    this._historyTooltipBox = this.shadowRoot.querySelector(".history-tooltip-box");
    this._historyTooltipText = this.shadowRoot.querySelector(".history-tooltip-text");
    this._targetGroup = this.shadowRoot.querySelector(".target");
    this._targetLine = this.shadowRoot.querySelector(".target-line");
    this._targetLabel = this.shadowRoot.querySelector(".target-label");
    this._targetHit = this.shadowRoot.querySelector(".target-hit");
    this._status = this.shadowRoot.querySelector(".status");
    this._domReady = true;
  }

  _attachRuntime() {
    if (this._runtimeAttached || !this._config || !this.shadowRoot) return;
    this._renderShell();
    this._runtimeAbort = new AbortController();
    const signal = this._runtimeAbort.signal;
    this._controller = new TargetInteractionController({
      min: this._config.min,
      max: this._config.max,
      step: this._config.step,
      onPreview: () => this._scheduleDraw(),
      onCommit: (value) => this._commitTarget(value),
    });
    this._targetHit.addEventListener("pointerdown", (event) => this._onPointerDown(event), { signal });
    this._targetHit.addEventListener("pointermove", (event) => this._onPointerMove(event), { signal });
    this._targetHit.addEventListener("pointerup", (event) => this._onPointerUp(event), { signal });
    this._targetHit.addEventListener("pointercancel", (event) => this._onPointerCancel(event), { signal });
    this._targetHit.addEventListener("lostpointercapture", (event) => this._onPointerCancel(event), { signal });
    this._targetHit.addEventListener("keydown", (event) => this._onKeyDown(event), { signal });
    this._targetHit.addEventListener("keyup", (event) => this._onKeyUp(event), { signal });
    this._targetHit.addEventListener("blur", () => this._onTargetBlur(), { signal });
    this._historyHit.addEventListener("pointerdown", (event) => this._onHistoryPointerDown(event), { signal });
    this._historyHit.addEventListener("pointermove", (event) => this._onHistoryPointerMove(event), { signal });
    this._historyHit.addEventListener("pointerup", (event) => this._onHistoryPointerUp(event), { signal });
    this._historyHit.addEventListener("pointercancel", (event) => this._onHistoryPointerCancel(event), { signal });
    this._historyHit.addEventListener("pointerleave", () => this._onHistoryPointerLeave(), { signal });
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this._hideHistoryInspection();
      }, { signal });
    }
    if (typeof ResizeObserver === "function") {
      this._resizeObserver = new ResizeObserver(() => this._scheduleDraw());
      this._resizeObserver.observe(this._chart);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", () => this._scheduleDraw(), { signal });
    }
    this._runtimeAttached = true;
    this._syncEntityStates();
    this._scheduleDraw();
  }

  _detachRuntime() {
    this._historyGeneration += 1;
    this._commitGeneration += 1;
    this._runtimeAbort?.abort();
    this._runtimeAbort = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._controller?.cancelAll();
    this._controller = null;
    this._plotPoints = [];
    this._historyInspection = null;
    this._historyPointerCandidate = null;
    this._historyInspector?.setAttribute("display", "none");
    if (this._redrawFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._redrawFrame);
    }
    this._redrawFrame = null;
    if (this._historyTimer !== null) clearTimeout(this._historyTimer);
    this._historyTimer = null;
    if (this._historyState === "loading") {
      this._historyState = this._history.length > 0 ? "ready" : "idle";
    }
    if (this._pendingTimer !== null) clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
    this._pendingTarget = null;
    this._runtimeAttached = false;
  }

  _scheduleDraw() {
    if (!this._runtimeAttached) return;
    if (typeof requestAnimationFrame !== "function") {
      this._draw();
      return;
    }
    if (this._redrawFrame !== null) return;
    this._redrawFrame = requestAnimationFrame(() => {
      this._redrawFrame = null;
      this._draw();
    });
  }

  _syncEntityStates() {
    if (!this._config || !this._hass || !this._domReady) return;
    const water = finiteNumber(this._hass.states?.[this._config.entity]?.state);
    this._header.textContent = `Wasser: ${water === null ? "—" : `${Math.round(water)} L`}`;
    this._header.classList.toggle("unavailable", water === null);
    const target = finiteNumber(this._hass.states?.[this._config.target_entity]?.state);
    if (
      this._pendingTarget !== null &&
      this._pendingTarget.generation === this._commitGeneration &&
      this._pendingTarget.targetEntity === this._config.target_entity &&
      target === this._pendingTarget.value
    ) {
      this._pendingTarget = null;
      if (this._pendingTimer !== null) clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    if (this._pendingTarget === null && !this._controller?.active) {
      this._controller?.setPersisted(target);
    }
    this._scheduleDraw();
  }

  _maybeLoadHistory(force = false) {
    if (!this._runtimeAttached || !this._hass || typeof this._hass.callWS !== "function") return;
    const now = Date.now();
    if (this._historyState === "loading") return;
    if (!force && now < this._nextHistoryRefreshAt) return;
    const generation = ++this._historyGeneration;
    const request = buildStatisticsRequest(this._config, now);
    const hass = this._hass;
    const entity = this._config.entity;
    this._historyState = "loading";
    this._historyError = null;
    this._nextHistoryRefreshAt = now + PERIOD_MILLISECONDS[this._config.period];
    this._armHistoryRefresh(PERIOD_MILLISECONDS[this._config.period]);
    this._scheduleDraw();
    Promise.resolve().then(() => hass.callWS(request)).then((response) => {
      if (!this._runtimeAttached || generation !== this._historyGeneration) return;
      this._history = normalizeStatisticsResponse(response, entity);
      this._historyState = "ready";
      this._scheduleDraw();
    }).catch((error) => {
      if (!this._runtimeAttached || generation !== this._historyGeneration) return;
      this._history = [];
      this._historyState = "error";
      this._historyError = error instanceof Error ? error.message : String(error);
      this._scheduleDraw();
    });
  }

  _armHistoryRefresh(delay) {
    if (this._historyTimer !== null) clearTimeout(this._historyTimer);
    this._historyTimer = null;
    if (!this._runtimeAttached) return;
    this._historyTimer = setTimeout(() => {
      this._historyTimer = null;
      if (this._runtimeAttached) this._maybeLoadHistory(true);
    }, delay);
    this._historyTimer?.unref?.();
  }

  _commitTarget(value) {
    const generation = ++this._commitGeneration;
    const hass = this._hass;
    const targetEntity = this._config?.target_entity;
    if (!hass || typeof hass.callService !== "function" || !targetEntity) {
      this._targetError = "Ziel konnte nicht gespeichert werden.";
      const actual = finiteNumber(this._hass?.states?.[targetEntity]?.state);
      this._controller?.setPersisted(actual);
      this._scheduleDraw();
      return;
    }
    this._pendingTarget = { generation, targetEntity, value };
    this._targetError = null;
    if (this._pendingTimer !== null) clearTimeout(this._pendingTimer);
    this._pendingTimer = setTimeout(() => {
      if (
        generation !== this._commitGeneration ||
        this._pendingTarget?.generation !== generation ||
        this._pendingTarget?.targetEntity !== targetEntity
      ) return;
      this._pendingTimer = null;
      this._pendingTarget = null;
      this._targetError = "Zieländerung wurde von Home Assistant nicht bestätigt.";
      const actual = finiteNumber(this._hass?.states?.[targetEntity]?.state);
      this._controller?.setPersisted(actual);
      this._scheduleDraw();
    }, 5000);
    this._pendingTimer?.unref?.();
    Promise.resolve().then(() => hass.callService("input_number", "set_value", {
      entity_id: targetEntity,
      value,
    })).catch(() => {
      this._syncTargetAfterFailure(generation, targetEntity);
    });
  }

  _syncTargetAfterFailure(generation, targetEntity) {
    if (
      generation !== this._commitGeneration ||
      this._pendingTarget?.generation !== generation ||
      this._pendingTarget?.targetEntity !== targetEntity
    ) return;
    this._targetError = "Ziel konnte nicht gespeichert werden.";
    this._pendingTarget = null;
    if (this._pendingTimer !== null) clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
    const actual = finiteNumber(this._hass?.states?.[targetEntity]?.state);
    this._controller?.setPersisted(actual);
    this._scheduleDraw();
  }

  _eventValue(event) {
    const rectangle = this._svg.getBoundingClientRect();
    if (!this._geometry || rectangle.height <= 0) return this._config.min;
    const svgY = (event.clientY - rectangle.top) * (CHART_HEIGHT / rectangle.height);
    return valueFromY(
      svgY,
      this._geometry.top,
      this._geometry.bottom,
      this._config.min,
      this._config.max,
      this._config.step,
    );
  }

  _inspectHistoryAt(event) {
    const rectangle = this._svg?.getBoundingClientRect();
    if (!this._geometry || !rectangle || rectangle.width <= 0 || this._plotPoints.length === 0) {
      this._hideHistoryInspection();
      return false;
    }
    const svgX = (event.clientX - rectangle.left) * (this._geometry.width / rectangle.width);
    const x = clamp(svgX, this._geometry.left, this._geometry.right);
    const ratio = (x - this._geometry.left) / (this._geometry.right - this._geometry.left);
    const timestamp = this._geometry.start + ratio * (this._geometry.end - this._geometry.start);
    const point = nearestHistoryPoint(
      this._plotPoints,
      timestamp,
      PERIOD_MILLISECONDS[this._config.period] * 1.5,
    );
    const next = point?.timestamp ?? null;
    if (this._historyInspection === next) return next !== null;
    this._historyInspection = next;
    this._scheduleDraw();
    return next !== null;
  }

  _hideHistoryInspection() {
    if (this._historyInspection === null) return false;
    this._historyInspection = null;
    this._scheduleDraw();
    return true;
  }

  _onHistoryPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.isPrimary === false || this._controller?.pointerId !== null) return;
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      this._historyPointerCandidate = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      return;
    }
    this._inspectHistoryAt(event);
  }

  _onHistoryPointerMove(event) {
    if (this._controller?.pointerId !== null) {
      this._historyPointerCandidate = null;
      this._hideHistoryInspection();
      return;
    }
    if (event.pointerType !== "touch" && event.pointerType !== "pen") {
      this._inspectHistoryAt(event);
      return;
    }
    const candidate = this._historyPointerCandidate;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) > 8) {
      this._historyPointerCandidate = null;
      this._hideHistoryInspection();
    }
  }

  _onHistoryPointerUp(event) {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") {
      if (this._controller?.pointerId === null) this._inspectHistoryAt(event);
      return;
    }
    const candidate = this._historyPointerCandidate;
    this._historyPointerCandidate = null;
    if (!candidate || candidate.pointerId !== event.pointerId || this._controller?.pointerId !== null) {
      this._hideHistoryInspection();
      return;
    }
    const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
    if (distance <= 8) this._inspectHistoryAt(event);
    else this._hideHistoryInspection();
  }

  _onHistoryPointerCancel(event) {
    if (this._historyPointerCandidate?.pointerId === event.pointerId) {
      this._historyPointerCandidate = null;
    }
    this._hideHistoryInspection();
  }

  _onHistoryPointerLeave() {
    this._historyPointerCandidate = null;
    this._hideHistoryInspection();
  }

  _onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.isPrimary === false) return;
    this._historyPointerCandidate = null;
    this._hideHistoryInspection();
    if (!this._controller?.beginPointer(event.pointerId, this._eventValue(event))) return;
    event.preventDefault();
    if (!capturePointer(this._targetHit, event.pointerId)) {
      this._controller.cancelPointer(event.pointerId);
      this._scheduleDraw();
    }
  }

  _onPointerMove(event) {
    if (!this._controller?.movePointer(event.pointerId, this._eventValue(event))) return;
    event.preventDefault();
  }

  _onPointerUp(event) {
    if (this._controller?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this._controller.endPointer(event.pointerId);
    releasePointer(this._targetHit, event.pointerId);
  }

  _onPointerCancel(event) {
    if (!this._controller?.cancelPointer(event.pointerId)) return;
    this._scheduleDraw();
  }

  _onKeyDown(event) {
    if (event.key === "Escape") this._hideHistoryInspection();
    if (!this._controller?.keyDown(event.key)) return;
    event.preventDefault();
  }

  _onKeyUp(event) {
    if (!this._controller?.keyUp(event.key)) return;
    event.preventDefault();
  }

  _onTargetBlur() {
    if (this._controller?.cancelKeyboard()) this._scheduleDraw();
  }

  _draw() {
    if (!this._runtimeAttached || !this._config) return;
    const measuredWidth = this._chart.getBoundingClientRect().width || this._chart.clientWidth || 600;
    const width = Math.max(240, Math.round(measuredWidth));
    const end = Date.now();
    const geometry = {
      width,
      height: CHART_HEIGHT,
      left: 46,
      right: width - 18,
      top: 14,
      bottom: CHART_HEIGHT - 32,
      start: end - this._config.hours * 60 * 60 * 1000,
      end,
    };
    this._geometry = geometry;
    this._svg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
    this._svg.setAttribute("aria-label", `Wasserverlauf der letzten ${this._config.hours} Stunden`);
    for (const [name, value] of Object.entries({
      x: geometry.left,
      y: geometry.top,
      width: geometry.right - geometry.left,
      height: geometry.bottom - geometry.top,
    })) {
      this._clipRect.setAttribute(name, String(value));
    }
    this._drawGrid(geometry);
    this._drawSeries(geometry);
    this._drawHistoryInspection(geometry);
    this._drawTarget(geometry);
    this._drawStatus();
  }

  _drawGrid(geometry) {
    const nodes = [];
    for (let tick = 0; tick <= 5; tick += 1) {
      const ratio = tick / 5;
      const y = geometry.bottom - ratio * (geometry.bottom - geometry.top);
      const value = this._config.min + ratio * (this._config.max - this._config.min);
      nodes.push(createSvgElement("line", {
        class: "grid-line",
        x1: geometry.left,
        x2: geometry.right,
        y1: y,
        y2: y,
      }));
      nodes.push(createSvgElement("text", {
        class: "axis-label",
        x: geometry.left - 7,
        y: y + 4,
        "text-anchor": "end",
      }, Number.isInteger(value) ? String(value) : value.toFixed(1)));
    }
    const formatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
    for (let tick = 0; tick <= 4; tick += 1) {
      const ratio = tick / 4;
      const x = geometry.left + ratio * (geometry.right - geometry.left);
      const timestamp = geometry.start + ratio * (geometry.end - geometry.start);
      nodes.push(createSvgElement("text", {
        class: "axis-label",
        x,
        y: geometry.bottom + 20,
        "text-anchor": tick === 0 ? "start" : tick === 4 ? "end" : "middle",
      }, formatter.format(timestamp)));
    }
    this._gridGroup.replaceChildren(...nodes);
  }

  _drawSeries(geometry) {
    const usable = this._history.filter((point) =>
      point.timestamp >= geometry.start && point.timestamp <= geometry.end);
    const mapPoint = (point) => ({
      timestamp: point.timestamp,
      value: point.value,
      x: geometry.left + ((point.timestamp - geometry.start) / (geometry.end - geometry.start)) * (geometry.right - geometry.left),
      y: geometry.bottom - ((clamp(point.value, this._config.min, this._config.max) - this._config.min) / (this._config.max - this._config.min)) * (geometry.bottom - geometry.top),
    });
    this._plotPoints = usable.map(mapPoint);
    const segments = splitSeriesByGap(
      usable,
      PERIOD_MILLISECONDS[this._config.period],
    );
    const nodes = [];
    for (const segment of segments) {
      const mapped = segment.map(mapPoint);
      if (mapped.length === 1) {
        nodes.push(createSvgElement("circle", {
          cx: mapped[0].x,
          cy: mapped[0].y,
          r: 2,
          fill: "#2196f3",
        }));
        continue;
      }
      nodes.push(createSvgElement("path", {
        class: "area",
        d: smoothAreaPath(mapped, geometry.bottom, geometry.top, geometry.bottom),
      }));
      nodes.push(createSvgElement("path", {
        class: "series-line",
        d: smoothLinePath(mapped, geometry.top, geometry.bottom),
      }));
    }
    this._seriesGroup.replaceChildren(...nodes);
  }

  _drawHistoryInspection(geometry) {
    for (const [name, value] of Object.entries({
      x: geometry.left,
      y: geometry.top,
      width: geometry.right - geometry.left,
      height: geometry.bottom - geometry.top,
    })) {
      this._historyHit.setAttribute(name, String(value));
    }
    const point = this._historyInspection === null
      ? null
      : this._plotPoints.find((candidate) => candidate.timestamp === this._historyInspection) ?? null;
    if (!point || this._controller?.pointerId !== null) {
      if (!point) this._historyInspection = null;
      this._historyInspector.setAttribute("display", "none");
      return;
    }
    this._historyInspector.removeAttribute("display");
    for (const [name, value] of Object.entries({
      x1: point.x,
      x2: point.x,
      y1: geometry.top,
      y2: geometry.bottom,
    })) {
      this._historyGuide.setAttribute(name, String(value));
    }
    this._historyPoint.setAttribute("cx", String(point.x));
    this._historyPoint.setAttribute("cy", String(point.y));
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(point.timestamp);
    const label = `${time} · ${Math.round(point.value)} L`;
    const width = Math.min(
      Math.max(100, label.length * 7.5 + 16),
      Math.max(100, geometry.right - geometry.left - 8),
    );
    const height = 30;
    const position = tooltipPosition(point.x, point.y, width, height, geometry);
    for (const [name, value] of Object.entries({
      x: position.x,
      y: position.y,
      width,
      height,
    })) {
      this._historyTooltipBox.setAttribute(name, String(value));
    }
    this._historyTooltipText.setAttribute("x", String(position.x + 8));
    this._historyTooltipText.setAttribute("y", String(position.y + 20));
    this._historyTooltipText.textContent = label;
  }

  _drawTarget(geometry) {
    const target = this._controller?.value;
    if (target === null || target === undefined) {
      this._targetGroup.setAttribute("display", "none");
      this._targetHit.setAttribute("aria-disabled", "true");
      return;
    }
    this._targetGroup.removeAttribute("display");
    this._targetHit.removeAttribute("aria-disabled");
    const ratio = (target - this._config.min) / (this._config.max - this._config.min);
    const y = geometry.bottom - ratio * (geometry.bottom - geometry.top);
    for (const line of [this._targetLine, this._targetHit]) {
      line.setAttribute("x1", String(geometry.left));
      line.setAttribute("x2", String(geometry.right));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
    }
    this._targetLabel.setAttribute("x", String(geometry.right - 5));
    this._targetLabel.setAttribute("y", String(y < geometry.top + 18 ? y + 16 : y - 7));
    this._targetLabel.textContent = `Ziel · ${target} L`;
    this._targetHit.setAttribute("aria-valuemin", String(this._config.min));
    this._targetHit.setAttribute("aria-valuemax", String(this._config.max));
    this._targetHit.setAttribute("aria-valuenow", String(target));
    this._targetHit.setAttribute("aria-valuetext", `Ziel ${target} Liter`);
  }

  _drawStatus() {
    let message = "";
    let error = false;
    if (this._targetError) {
      message = this._targetError;
      error = true;
    } else if (this._historyState === "loading" && this._history.length === 0) {
      message = "Verlauf wird geladen …";
    } else if (this._historyState === "error") {
      message = "Verlauf nicht verfügbar.";
      error = true;
    } else if (this._historyState === "ready" && this._history.length === 0) {
      message = "Keine Statistikdaten verfügbar.";
    }
    this._status.textContent = message;
    this._status.hidden = message === "";
    this._status.classList.toggle("error", error);
  }
}

if (typeof globalThis.customElements !== "undefined" && !customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, WaterHistoryTargetCard);
}

if (typeof globalThis.window !== "undefined") {
  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: "Water History Target Card",
      description: "24-hour water history with an accessible draggable target line.",
      preview: false,
    });
  }
}
