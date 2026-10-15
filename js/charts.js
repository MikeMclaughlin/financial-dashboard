const Chart = (() => {
  const BLUE = "#4aa3ff";
  const ORANGE = "#ff9f4a";
  const GRID = "rgba(226,232,240,0.10)";
  const MUTED = "#93a0b5";

  function node(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function svg(el, w, h) {
    el.innerHTML = "";
    const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.setAttribute("viewBox", `0 0 ${w} ${h}`);
    root.setAttribute("width", String(w));
    root.setAttribute("height", String(h));
    root.setAttribute("preserveAspectRatio", "none");
    root.setAttribute("role", "img");
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.display = "block";
    el.appendChild(root);
    return root;
  }

  function size(el) {
    const w = Math.floor(el.clientWidth);
    const h = Math.floor(el.clientHeight);
    if (w < 40 || h < 24) return null;
    return { w, h };
  }

  function niceStep(span, ticks) {
    const rough = span / Math.max(1, ticks);
    if (!(rough > 0)) return 1;
    const pow = 10 ** Math.floor(Math.log10(rough));
    const n = rough / pow;
    const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return mult * pow;
  }

  function axis(values, ticks, mode) {
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, step: 1, ticks: [0, 1] };
    if (min === max) {
      min -= 1;
      max += 1;
    }
    let step = niceStep(max - min, ticks);
    if (mode === "half") {
      const rough = (max - min) / Math.max(2, ticks);
      step = rough <= 0.2 ? 0.25 : rough <= 0.45 ? 0.5 : rough <= 1 ? 1 : Math.max(1, Math.round(rough));
    }
    let lo = Math.floor(min / step) * step;
    let hi = Math.ceil(max / step) * step;
    if (min - lo < step * 0.08) lo -= step;
    if (hi - max < step * 0.08) hi += step;
    if (lo === hi) hi = lo + step;
    const out = [];
    const count = Math.round((hi - lo) / step);
    for (let i = 0; i <= count; i++) {
      out.push(Math.round((lo + step * i) * 1e6) / 1e6);
    }
    return { lo, hi: lo + step * count, step, ticks: out };
  }

  function formatTick(value, step, suffix) {
    const abs = Math.abs(value);
    let text;
    if (abs >= 10000) {
      text = Math.round(value).toLocaleString("en-US");
    } else {
      const places = step >= 1 ? 0 : Math.min(4, Math.max(1, (step.toString().split(".")[1] || "").length));
      text = value.toFixed(places);
    }
    if (text.startsWith("-")) text = `−${text.slice(1)}`;
    return suffix ? `${text}${suffix}` : text;
  }

  function tipAt(event, text) {
    const tip = document.getElementById("tip");
    if (!tip || !text) return;
    tip.style.display = "block";
    tip.style.left = `${event.clientX + 12}px`;
    tip.style.top = `${event.clientY + 12}px`;
    tip.textContent = text;
  }

  function hideTip() {
    const tip = document.getElementById("tip");
    if (tip) tip.style.display = "none";
  }

  function sparkline(el, values, color) {
    const nums = values.filter((v) => Number.isFinite(v));
    el.textContent = "";
    const box = size(el);
    if (!box || nums.length < 2) return;
    const root = svg(el, box.w, box.h);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const top = 3;
    const bottom = box.h - 3;
    const d = nums.map((v, i) => {
      const x = (i / (nums.length - 1)) * (box.w - 1);
      const y = bottom - ((v - min) / span) * (bottom - top);
      return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    root.appendChild(node("path", {
      d, fill: "none", stroke: color, "stroke-width": "2.2",
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
  }

  function lineChart(el, spec) {
    const box = size(el);
    if (!box) return;
    const w = box.w;
    const h = box.h;
    const pad = { l: Math.min(58, Math.max(42, w * 0.08)), r: 12, t: 16, b: 28, ...(spec.pad || {}) };
    const root = svg(el, w, h);
    const series = (spec.series || []).filter((s) => s.points?.some((p) => Number.isFinite(p.y)));
    const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => Number.isFinite(v));
    const scale = axis(ys, spec.ticks || 4, spec.tickMode || "auto");
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const xOf = (x) => pad.l + x * plotW;
    const yOf = (y) => pad.t + ((scale.hi - y) / (scale.hi - scale.lo)) * plotH;
    const suffix = spec.suffix || "";
    for (const yv of scale.ticks) {
      const y = yOf(yv);
      root.appendChild(node("line", { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: GRID }));
      const label = node("text", {
        x: pad.l - 8, y: y + 4, fill: MUTED, "font-size": "12", "text-anchor": "end",
      });
      label.textContent = formatTick(yv, scale.step, suffix);
      root.appendChild(label);
    }
    series.forEach((s) => {
      const pts = s.points.filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x));
      if (!pts.length) return;
      const d = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.x).toFixed(2)},${yOf(p.y).toFixed(2)}`).join(" ");
      if (s.area && pts.length > 1) {
        const gid = `area-${Math.random().toString(36).slice(2, 8)}`;
        const defs = node("defs", {});
        const grad = node("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
        grad.appendChild(node("stop", { offset: "0%", "stop-color": s.color, "stop-opacity": "0.38" }));
        grad.appendChild(node("stop", { offset: "100%", "stop-color": s.color, "stop-opacity": "0" }));
        defs.appendChild(grad);
        root.appendChild(defs);
        const area = `${d} L${xOf(pts.at(-1).x).toFixed(2)},${pad.t + plotH} L${xOf(pts[0].x).toFixed(2)},${pad.t + plotH} Z`;
        root.appendChild(node("path", { d: area, fill: `url(#${gid})` }));
      }
      if (pts.length > 1) {
        root.appendChild(node("path", {
          d, fill: "none", stroke: s.color, "stroke-width": s.width || 2.2,
          "stroke-dasharray": s.dashed ? "5 5" : "none",
          "stroke-linejoin": "round", "stroke-linecap": "round",
        }));
      }
      if (s.dot !== false) {
        const last = pts.at(-1);
        root.appendChild(node("circle", { cx: xOf(last.x), cy: yOf(last.y), r: 7, fill: s.color, opacity: "0.25" }));
        root.appendChild(node("circle", { cx: xOf(last.x), cy: yOf(last.y), r: 4.5, fill: s.color }));
        if (s.callout) {
          const tag = node("text", {
            x: xOf(last.x) + 8, y: yOf(last.y) - 8, fill: s.color, "font-size": "12", "font-weight": "700",
          });
          tag.textContent = s.callout;
          root.appendChild(tag);
        }
      }
    });
    if (spec.marker && Number.isFinite(spec.marker.x)) {
      const x = xOf(spec.marker.x);
      root.appendChild(node("line", {
        x1: x, x2: x, y1: pad.t, y2: pad.t + plotH,
        stroke: spec.marker.color || BLUE, "stroke-dasharray": "4 4", "stroke-width": "1.4",
      }));
      const label = node("text", {
        x: Math.min(x + 6, w - pad.r - 78), y: pad.t + 12,
        fill: spec.marker.color || BLUE, "font-size": "12", "font-weight": "700",
      });
      label.textContent = spec.marker.label || "";
      root.appendChild(label);
    }
    (spec.xLabels || []).forEach((lab) => {
      const text = node("text", {
        x: xOf(lab.at), y: h - 8, fill: MUTED, "font-size": "12",
        "text-anchor": lab.at > 0.85 ? "end" : lab.at < 0.05 ? "start" : "middle",
      });
      text.textContent = lab.text;
      root.appendChild(text);
    });
    root.addEventListener("mousemove", (event) => {
      const rect = root.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * w;
      let best = null;
      for (const s of series) {
        for (const p of s.points) {
          if (!Number.isFinite(p.y)) continue;
          const dx = Math.abs(xOf(p.x) - px);
          if (!best || dx < best.dx) best = { dx, s, p };
        }
      }
      if (!best || best.dx > 28) return hideTip();
      tipAt(event, best.p.title || `${best.s.name || ""} ${formatTick(best.p.y, scale.step, suffix)}`);
    });
    root.addEventListener("mouseleave", hideTip);
  }

  function columnBars(el, spec) {
    const box = size(el);
    if (!box) return;
    const w = box.w;
    const h = box.h;
    const pad = { l: 46, r: 8, t: 12, b: 28 };
    const root = svg(el, w, h);
    const bars = spec.bars || [];
    const values = bars.map((b) => b.value).concat(spec.average != null ? [spec.average] : []);
    const crosses = values.some((v) => v < 0) && values.some((v) => v > 0);
    const scale = axis(crosses ? values.concat([0]) : values, spec.ticks || 3, spec.tickMode || "auto");
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const yOf = (v) => pad.t + ((scale.hi - v) / (scale.hi - scale.lo)) * plotH;
    for (const yv of scale.ticks) {
      const y = yOf(yv);
      root.appendChild(node("line", { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: GRID }));
      const label = node("text", {
        x: pad.l - 6, y: y + 4, fill: MUTED, "font-size": "11", "text-anchor": "end",
      });
      label.textContent = formatTick(yv, scale.step, spec.suffix || "");
      root.appendChild(label);
    }
    if (crosses) {
      const zero = yOf(0);
      root.appendChild(node("line", { x1: pad.l, x2: w - pad.r, y1: zero, y2: zero, stroke: "rgba(226,232,240,0.35)" }));
    }
    if (spec.average != null) {
      const y = yOf(spec.average);
      root.appendChild(node("line", {
        x1: pad.l, x2: w - pad.r, y1: y, y2: y,
        stroke: ORANGE, "stroke-dasharray": "6 5", "stroke-width": "1.6",
      }));
    }
    const gap = plotW / Math.max(bars.length, 1);
    const bw = Math.max(4, gap * 0.62);
    const base = yOf(scale.lo);
    bars.forEach((bar, i) => {
      const x = pad.l + gap * i + (gap - bw) / 2;
      const y = yOf(Math.max(bar.value, scale.lo));
      const y2 = crosses ? yOf(Math.min(bar.value, 0)) : base;
      const top = Math.min(y, y2);
      const rect = node("rect", {
        x, y: top, width: bw, height: Math.max(1, Math.abs(y2 - y)), rx: 2,
        fill: bar.color || BLUE,
      });
      const title = node("title", {});
      title.textContent = bar.title || String(bar.value);
      rect.appendChild(title);
      rect.addEventListener("mousemove", (event) => tipAt(event, bar.title));
      rect.addEventListener("mouseleave", hideTip);
      root.appendChild(rect);
    });
    (spec.xLabels || []).forEach((lab) => {
      const text = node("text", {
        x: pad.l + lab.at * plotW, y: h - 8, fill: MUTED, "font-size": "12",
        "text-anchor": lab.at > 0.8 ? "end" : "start",
      });
      text.textContent = lab.text;
      root.appendChild(text);
    });
  }

  function horizontalBars(el, rows) {
    const rowH = 48;
    const h = Math.max(220, rows.length * rowH + 16);
    if (el.style.height !== `${h}px`) el.style.height = `${h}px`;
    const box = size(el);
    if (!box) return;
    const w = box.w;
    const padL = Math.min(250, Math.max(156, Math.round(w * 0.36)));
    const pad = { l: padL, r: 56, t: 6, b: 8 };
    const root = svg(el, w, h);
    const vals = rows.map((r) => r.value);
    const min = Math.min(...vals, 0);
    const max = Math.max(0, ...vals);
    const span = max - min || 1;
    const plotW = w - pad.l - pad.r;
    const xOf = (v) => pad.l + ((v - min) / span) * plotW;
    const zero = xOf(0);
    root.appendChild(node("line", { x1: zero, x2: zero, y1: 4, y2: h - 6, stroke: "rgba(226,232,240,0.45)" }));
    rows.forEach((row, i) => {
      const y = pad.t + i * rowH;
      const label = node("text", { x: 0, y: y + 16, fill: "#e8eef8", "font-size": "14", "font-weight": "700" });
      label.textContent = row.label;
      root.appendChild(label);
      const sub = node("text", { x: 0, y: y + 32, fill: MUTED, "font-size": "11" });
      sub.textContent = row.sub || "";
      root.appendChild(sub);
      const end = xOf(row.value);
      const x = Math.min(end, zero);
      const rect = node("rect", {
        x, y: y + 10, width: Math.max(Math.abs(end - zero), 1), height: 16, rx: 3,
        fill: row.color || (row.value < 0 ? ORANGE : BLUE),
      });
      const title = node("title", {});
      title.textContent = row.title || "";
      rect.appendChild(title);
      rect.addEventListener("mousemove", (event) => tipAt(event, row.title));
      rect.addEventListener("mouseleave", hideTip);
      root.appendChild(rect);
      const value = node("text", {
        x: Math.max(end, zero) + 8, y: y + 23, fill: "#f8fafc", "font-size": "14", "font-weight": "700",
      });
      value.textContent = row.display;
      root.appendChild(value);
    });
  }

  function timeline(el, spec) {
    const rowH = 54;
    const rows = spec.rows || [];
    const h = rows.length * rowH + 36;
    if (el.style.height !== `${h}px`) el.style.height = `${h}px`;
    const box = size(el);
    if (!box) return;
    const w = box.w;
    const pad = { l: 48, r: 12, t: 8, b: 26 };
    const root = svg(el, w, h);
    const plotW = w - pad.l - pad.r;
    const xOf = (days) => pad.l + (days / spec.maxDays) * plotW;
    rows.forEach((row, i) => {
      const y = pad.t + i * rowH + 28;
      root.appendChild(node("text", { x: 0, y: y + 4, fill: "#d5ddeb", "font-size": "13", "font-weight": "700" })).textContent = row.name;
      root.appendChild(node("line", { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: GRID }));
      row.events.forEach((ev) => {
        const x = xOf(ev.days);
        root.appendChild(node("circle", { cx: x, cy: y, r: 6, fill: row.color }));
        const text = node("text", {
          x: x + (ev.shift || 0), y: y - 12, fill: row.color, "font-size": "12", "font-weight": "700", "text-anchor": "middle",
        });
        text.textContent = ev.label;
        root.appendChild(text);
      });
    });
    root.appendChild(node("text", { x: pad.l, y: h - 6, fill: MUTED, "font-size": "12" })).textContent = "Today";
    root.appendChild(node("text", { x: w - pad.r, y: h - 6, fill: MUTED, "font-size": "12", "text-anchor": "end" })).textContent = `+${spec.maxDays} days`;
  }

  return { BLUE, ORANGE, sparkline, lineChart, columnBars, horizontalBars, timeline, formatTick };
})();
