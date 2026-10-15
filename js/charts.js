const Chart = (() => {
  const BLUE = "#4aa3ff";
  const ORANGE = "#ff9f4a";
  const GRID = "rgba(226,232,240,0.10)";
  const MUTED = "#93a0b5";

  function svg(el, w, h) {
    el.innerHTML = "";
    const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.setAttribute("viewBox", `0 0 ${w} ${h}`);
    root.setAttribute("role", "img");
    el.appendChild(root);
    return root;
  }

  function node(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function domain(series) {
    const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => Number.isFinite(v));
    if (!ys.length) return [0, 1];
    let min = Math.min(...ys);
    let max = Math.max(...ys);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    return [min - pad, max + pad];
  }

  function sparkline(el, values, color) {
    el.innerHTML = "";
    const nums = values.filter((v) => Number.isFinite(v));
    if (nums.length < 2) return;
    const root = svg(el, 320, 48);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const d = nums.map((v, i) => {
      const x = (i / (nums.length - 1)) * 320;
      const y = 44 - ((v - min) / span) * 40;
      return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    root.appendChild(node("path", { d, fill: "none", stroke: color, "stroke-width": "2.2", "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }

  function lineChart(el, spec) {
    const w = 720;
    const h = spec.height || 280;
    const pad = { l: 46, r: 18, t: 18, b: 32, ...(spec.pad || {}) };
    const root = svg(el, w, h);
    const series = spec.series || [];
    const [min, max] = domain(series);
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const xOf = (x) => pad.l + x * plotW;
    const yOf = (y) => pad.t + ((max - y) / (max - min)) * plotH;
    const ticks = spec.ticks || 4;
    for (let i = 0; i < ticks; i++) {
      const yv = min + ((max - min) * i) / (ticks - 1);
      const y = yOf(yv);
      root.appendChild(node("line", { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: GRID }));
      root.appendChild(node("text", {
        x: pad.l - 8, y: y + 4, fill: MUTED, "font-size": "12", "text-anchor": "end",
      })).textContent = spec.yFormat ? spec.yFormat(yv) : yv.toFixed(2);
    }
    series.forEach((s, idx) => {
      if (!s.points.length) return;
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${xOf(p.x).toFixed(2)},${yOf(p.y).toFixed(2)}`).join(" ");
      if (s.area) {
        const gid = `area-${Math.random().toString(36).slice(2, 8)}`;
        const defs = node("defs", {});
        const grad = node("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
        grad.appendChild(node("stop", { offset: "0%", "stop-color": s.color, "stop-opacity": "0.38" }));
        grad.appendChild(node("stop", { offset: "100%", "stop-color": s.color, "stop-opacity": "0" }));
        defs.appendChild(grad);
        root.appendChild(defs);
        const area = `${d} L${xOf(s.points.at(-1).x).toFixed(2)},${pad.t + plotH} L${xOf(s.points[0].x).toFixed(2)},${pad.t + plotH} Z`;
        root.appendChild(node("path", { d: area, fill: `url(#${gid})` }));
      }
      root.appendChild(node("path", {
        d,
        fill: "none",
        stroke: s.color,
        "stroke-width": s.width || 2.2,
        "stroke-dasharray": s.dashed ? "5 5" : "none",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }));
      if (s.dot !== false) {
        const last = s.points.at(-1);
        root.appendChild(node("circle", { cx: xOf(last.x), cy: yOf(last.y), r: 7, fill: s.color, opacity: "0.25" }));
        root.appendChild(node("circle", { cx: xOf(last.x), cy: yOf(last.y), r: 4, fill: s.color }));
      }
      if (s.name) root.dataset[`series${idx}`] = s.name;
    });
    if (spec.marker && Number.isFinite(spec.marker.x)) {
      const x = xOf(spec.marker.x);
      root.appendChild(node("line", {
        x1: x, x2: x, y1: pad.t, y2: pad.t + plotH,
        stroke: spec.marker.color || BLUE, "stroke-dasharray": "4 4", "stroke-width": "1.4",
      }));
      const label = node("text", {
        x: x + 6, y: pad.t + 12, fill: spec.marker.color || BLUE, "font-size": "12", "font-weight": "700",
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
    bindHover(el, root, spec, xOf, yOf);
  }

  function bindHover(el, root, spec, xOf, yOf) {
    const tip = document.getElementById("tip");
    if (!tip) return;
    root.addEventListener("mousemove", (event) => {
      const rect = root.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * 720;
      let best = null;
      for (const s of spec.series || []) {
        for (const p of s.points) {
          const dx = Math.abs(xOf(p.x) - px);
          if (!best || dx < best.dx) best = { dx, s, p };
        }
      }
      if (!best || best.dx > 24) {
        tip.style.display = "none";
        return;
      }
      tip.style.display = "block";
      tip.style.left = `${event.clientX + 12}px`;
      tip.style.top = `${event.clientY + 12}px`;
      tip.textContent = best.p.title || `${best.s.name || ""} ${spec.yFormat ? spec.yFormat(best.p.y) : best.p.y}`;
    });
    root.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }

  function columnBars(el, spec) {
    const w = 720;
    const h = spec.height || 250;
    const pad = { l: 28, r: 12, t: 16, b: 32 };
    const root = svg(el, w, h);
    const bars = spec.bars || [];
    const values = bars.map((b) => b.value).concat(spec.average != null ? [spec.average] : []);
    let min = Math.min(0, ...values);
    let max = Math.max(...values, 0);
    if (min === max) max = min + 1;
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.12;
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const yOf = (v) => pad.t + ((max - v) / (max - min)) * plotH;
    const zero = yOf(0);
    root.appendChild(node("line", { x1: pad.l, x2: w - pad.r, y1: zero, y2: zero, stroke: "rgba(226,232,240,0.35)" }));
    if (spec.average != null) {
      const y = yOf(spec.average);
      root.appendChild(node("line", {
        x1: pad.l, x2: w - pad.r, y1: y, y2: y,
        stroke: ORANGE, "stroke-dasharray": "6 5", "stroke-width": "1.6",
      }));
    }
    const gap = plotW / Math.max(bars.length, 1);
    const bw = Math.max(6, gap * 0.62);
    bars.forEach((bar, i) => {
      const x = pad.l + gap * i + (gap - bw) / 2;
      const y = yOf(Math.max(bar.value, 0));
      const y2 = yOf(Math.min(bar.value, 0));
      const rect = node("rect", {
        x, y, width: bw, height: Math.max(1, y2 - y), rx: 3,
        fill: bar.color || BLUE,
      });
      const title = node("title", {});
      title.textContent = bar.title || String(bar.value);
      rect.appendChild(title);
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
    const w = 720;
    const rowH = 48;
    const h = Math.max(180, rows.length * rowH + 20);
    const pad = { l: 214, r: 72, t: 8, b: 12 };
    const root = svg(el, w, h);
    el.style.height = `${Math.max(240, rows.length * 52)}px`;
    const vals = rows.map((r) => r.value);
    const min = Math.min(...vals, 0);
    const max = Math.max(0, ...vals);
    const span = max - min || 1;
    const plotW = w - pad.l - pad.r;
    const xOf = (v) => pad.l + ((v - min) / span) * plotW;
    const zero = xOf(0);
    root.appendChild(node("line", { x1: zero, x2: zero, y1: 4, y2: h - 8, stroke: "rgba(226,232,240,0.45)" }));
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
      const width = Math.abs(end - zero);
      const rect = node("rect", { x, y: y + 10, width: Math.max(width, 1), height: 16, rx: 3, fill: row.color || (row.value < 0 ? ORANGE : BLUE) });
      const title = node("title", {});
      title.textContent = row.title || "";
      rect.appendChild(title);
      root.appendChild(rect);
      const value = node("text", {
        x: Math.max(end, zero) + 8, y: y + 23, fill: "#f8fafc", "font-size": "14", "font-weight": "700",
      });
      value.textContent = row.display;
      root.appendChild(value);
    });
  }

  function timeline(el, spec) {
    const w = 720;
    const rowH = 54;
    const rows = spec.rows || [];
    const h = rows.length * rowH + 36;
    const pad = { l: 54, r: 16, t: 8, b: 26 };
    const root = svg(el, w, h);
    el.style.height = `${h}px`;
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

  return { BLUE, ORANGE, sparkline, lineChart, columnBars, horizontalBars, timeline };
})();
