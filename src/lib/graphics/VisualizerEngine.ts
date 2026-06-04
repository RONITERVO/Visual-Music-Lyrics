/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { getEnergy, idleEnergy, pseudoRandom } from "../utils";

interface Drop { x: number; y: number; speed: number; length: number; isBg: boolean; z: number; }
interface Splat { x: number; y: number; life: number; maxLife: number; }
interface Bird { x: number; y: number; vx: number; vy: number; flapPhase: number; }
interface Fish { x: number; y: number; vx: number; vy: number; active: boolean; }

export class VisualizerEngine {
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  rafId: number = 0;
  lastTime: number = performance.now();

  seeds: number[] = Array.from({ length: 192 }, (_, i) => pseudoRandom(i + 7));
  smoothedBins: Float32Array = new Float32Array(32);

  drops: Drop[] = [];
  splats: Splat[] = [];
  birds: Bird[] = [];
  fish: Fish | null = null;

  scrollX: number = 0;

  colors = {
    ink: 'rgba(35, 30, 28, 0.85)',
    inkSoft: 'rgba(35, 30, 28, 0.35)',
    inkFaint: 'rgba(35, 30, 28, 0.1)',
    blueprint: 'rgba(24, 75, 165, 0.8)',
    blueprintSoft: 'rgba(24, 75, 165, 0.3)',
    sun: 'rgba(235, 150, 45, 0.7)',
    sunGlow: 'rgba(235, 150, 45, 0.15)',
    waterWash: 'rgba(110, 140, 160, 0.25)',
    skyWash: 'rgba(200, 210, 220, 0.3)'
  };

  init(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (this.canvas) this.ctx = this.canvas.getContext('2d');
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  resize() {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  jitter(x: number, y: number, amp: number, t: number) {
    const frame = Math.floor(t * 12) % 3;
    const seed = x * 12.9898 + y * 78.233 + frame * 13.131;
    const h = Math.sin(seed) * 43758.5453;
    return ((h - Math.floor(h)) - 0.5) * amp;
  }

  terrainNoise(x: number) {
    let n = Math.sin(x * 0.005) * 0.5 + 0.5;
    n += Math.sin(x * 0.012) * 0.25;
    n += Math.sin(x * 0.03) * 0.125;
    let sharp = Math.abs(Math.sin(x * 0.008));
    return (n * 0.7 + sharp * 0.3);
  }

  drawFrame(analyser: AnalyserNode | null, dataFrequency: Uint8Array | null, dataTime: Uint8Array | null) {
    this.resize();
    if (!this.ctx || !this.canvas) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    const t = now / 1000;

    const width = this.canvas.width; const height = this.canvas.height;
    const ratio = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.save();
    this.ctx.scale(ratio, ratio);

    const w = width / ratio; const h = height / ratio;

    let frequency = null; let timeData = null;
    if (analyser && dataFrequency && dataTime) {
      analyser.getByteFrequencyData(dataFrequency);
      analyser.getByteTimeDomainData(dataTime);
      frequency = dataFrequency; timeData = dataTime;
    }

    const energy = frequency ? getEnergy(frequency, 3, frequency.length * 0.72) : idleEnergy(t);
    const bass = frequency ? getEnergy(frequency, 0, 18) : idleEnergy(t + 2) * 0.7;
    const treble = frequency ? getEnergy(frequency, 60, frequency.length) : idleEnergy(t + 4) * 0.5;

    for (let i = 0; i < 32; i++) {
      const target = frequency ? (frequency[i] / 255) : Math.abs(Math.sin(t + i * 0.2)) * 0.2;
      this.smoothedBins[i] += (target - this.smoothedBins[i]) * 15 * dt;
    }

    this.scrollX += dt * (20 + energy * 60);

    // Dynamic Horizon: Anchors to the gap between Primary and Translation text
    let horizonY = h * 0.5;
    const primaryEl = document.querySelector('.lyric-primary');
    if (primaryEl) {
      const rect = primaryEl.getBoundingClientRect();
      if (rect.height > 0) horizonY = rect.bottom + 5;
    }

    const transEl = document.querySelector('.translation-wrap');
    let transRect = null;
    if (transEl) {
      const r = transEl.getBoundingClientRect();
      if (r.height > 0) transRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }

    const sunCx = w * 0.5;
    const sunCy = horizonY - h * 0.25;

    // --- Master Render Pipeline ---
    this.drawSkyWash(this.ctx, w, horizonY);
    this.drawCircularScribbleSun(this.ctx, w, h, t, frequency, energy, bass, sunCx, sunCy);
    this.drawTerrain(this.ctx, w, h, horizonY, t);
    this.drawOcean(this.ctx, w, h, horizonY, t, timeData, treble, energy, sunCx);
    this.drawWatercolorClouds(this.ctx, w, h, t, energy, sunCx);
    this.processWildlife(this.ctx, w, h, horizonY, energy, dt, t);
    this.processWeather(this.ctx, w, h, horizonY, energy, dt, t, transRect);

    this.ctx.restore();
  }

  drawSkyWash(ctx: CanvasRenderingContext2D, w: number, horizonY: number) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    // Faded, washed-out paper sky
    const grad = ctx.createLinearGradient(0, 0, 0, horizonY);
    grad.addColorStop(0, this.colors.skyWash);
    grad.addColorStop(1, 'rgba(240, 230, 220, 0.1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, horizonY);
    ctx.restore();
  }

  drawCircularScribbleSun(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, frequency: Uint8Array | null, energy: number, bass: number, cx: number, cy: number) {
    const smaller = Math.min(w, h);
    const baseRadius = smaller * (0.12 + bass * 0.02);
    const maxLift = smaller * (0.08 + energy * 0.08);
    const points = 150;

    ctx.save();

    // Watercolor Sun Glow Wash
    ctx.globalCompositeOperation = 'multiply';
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * 3, 0, Math.PI * 2);
    const glow = ctx.createRadialGradient(cx, cy, baseRadius * 0.5, cx, cy, baseRadius * 3);
    glow.addColorStop(0, this.colors.sunGlow);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = "round"; ctx.lineJoin = "round";

    // Scribble Rays
    const tickCount = 26;
    ctx.strokeStyle = this.colors.sun;
    ctx.globalAlpha = 0.4 + bass * 0.4;
    ctx.lineWidth = 1.5 + bass * 2;
    for (let i = 0; i < tickCount; i++) {
      const angle = (i / tickCount) * Math.PI * 2 + Math.sin(t * 0.6) * 0.03;
      const len = 10 + bass * 35 * this.seeds[i];
      const inner = baseRadius * 1.1 + Math.sin(t * 2 + i) * 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner * 0.9);
      ctx.lineTo(cx + Math.cos(angle) * (inner + len) + this.jitter(cx, cy, 5, t),
        cy + Math.sin(angle) * (inner + len) * 0.9 + this.jitter(cy, cx, 5, t));
      ctx.stroke();
    }

    // Scribble Core
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const percent = i / points; const angle = percent * Math.PI * 2;
        const sourceIndex = frequency ? Math.floor(percent * (frequency.length - 1)) : 0;
        const value = frequency ? frequency[sourceIndex] / 255 : 0.18 + 0.05 * Math.sin(t * 1.7 + i);
        const seed = this.seeds[(i + pass * 17) % this.seeds.length];

        const wobble = Math.sin(t * (1.7 + seed) + i * 0.19 + pass) * smaller * 0.006;
        const rough = Math.sin(i * 0.55 + seed * 9 + t * 0.35) * smaller * 0.004;
        const radius = baseRadius + value * maxLift + wobble + rough + pass * smaller * 0.004;

        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius * 0.9;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = pass === 2 ? this.colors.ink : this.colors.sun;
      ctx.globalAlpha = pass === 2 ? 0.6 : 0.8;
      ctx.lineWidth = (pass === 0 ? 1 : 1.5 + pass * 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawWatercolorClouds(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, energy: number, sunCx: number) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.filter = 'blur(12px)';

    const segments = 12;
    const segW = w / segments;

    for (let i = 0; i < segments; i++) {
      const val = this.smoothedBins[i * 2] || 0;
      if (val < 0.03) continue;

      const cx = i * segW + (segW / 2);

      // Intelligent Cloud Colors
      // Close to sun = warm edges. High energy = dark storm clouds. Low energy = fluffy light clouds.
      const distToSun = Math.abs(cx - sunCx);
      const sunProximity = Math.max(0, 1 - (distToSun / (w * 0.4)));

      const lightness = 95 - (energy * 45) + (sunProximity * 15);
      const saturation = 10 + (sunProximity * 40);
      const hue = 210 - (sunProximity * 170); // 210 is blue/grey, 40 is orange/yellow

      ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${val * 0.8})`;

      const cy = -10 + (val * h * 0.15) + Math.sin(t + i) * 10;
      const radius = (w * 0.12) + (val * w * 0.15);

      ctx.beginPath();
      for (let j = 0; j <= 10; j++) {
        let angle = (j / 10) * Math.PI * 2;
        let noise = Math.sin(angle * 3 + t) * 0.3;
        let r = radius * (1 + noise);

        if (angle > Math.PI && angle < Math.PI * 2) r *= 0.3; // Flat top against ceiling

        let px = cx + Math.cos(angle) * r;
        let py = Math.min(cy + Math.sin(angle) * r, cy + r);

        if (j === 0) ctx.moveTo(px, py);
        else ctx.bezierCurveTo(
          cx + Math.cos(angle - 0.2) * r, cy + Math.sin(angle - 0.2) * r,
          px, py, px, py
        );
      }
      ctx.fill();
    }
    ctx.restore();
  }

  drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, t: number) {
    ctx.save();
    const points = 60;
    const spacing = w / (points - 1);

    // Mask out the sun behind the mountains using paper color
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    let pts = [];
    for (let i = 0; i < points; i++) {
      const worldX = i * spacing + this.scrollX * 0.5; // Parallax
      const hNoise = this.terrainNoise(worldX);
      const py = horizonY - (hNoise * h * 0.15);
      pts.push({ x: i * spacing, y: py });
      ctx.lineTo(i * spacing, py);
    }
    ctx.lineTo(w, horizonY);
    ctx.fillStyle = '#f4eee1'; // Paper base color
    ctx.fill();

    // Watercolor mountain shadow
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(40, 50, 60, 0.15)';
    ctx.fill();

    // Sketchy Outline
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = this.colors.inkSoft;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i]; const p2 = pts[i + 1];
      ctx.moveTo(p1.x + this.jitter(p1.x, p1.y, 2, t), p1.y + this.jitter(p1.y, p1.x, 2, t));
      ctx.lineTo(p2.x + this.jitter(p2.x, p2.y, 2, t), p2.y + this.jitter(p2.y, p2.x, 2, t));
    }
    ctx.stroke();

    // Horizon line
    ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(w, horizonY);
    ctx.strokeStyle = this.colors.ink; ctx.stroke();
    ctx.restore();
  }

  drawOcean(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, t: number, timeData: Uint8Array | null, treble: number, energy: number, sunCx: number) {
    ctx.save();

    // Ocean Watercolor Wash
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = this.colors.waterWash;
    ctx.fillRect(0, horizonY, w, h - horizonY);

    // Sun Reflection on Water
    ctx.globalCompositeOperation = 'source-over';
    for (let py = horizonY; py < h; py += 6) {
      const depth = (py - horizonY) / (h - horizonY); // 0 at horizon, 1 at bottom
      if (Math.random() > 0.8) continue; // broken reflection

      // Reflection gets wider and more scattered closer to the viewer
      const waveShift = Math.sin(py * 0.1 + t * 4) * (15 * depth);
      const refWidth = (w * 0.08) + (depth * w * 0.15) + Math.sin(py * 0.05 + t) * 10;

      ctx.fillStyle = this.colors.sun;
      ctx.globalAlpha = 0.4 * (1 - depth) * (0.5 + energy * 0.5);
      ctx.fillRect(sunCx - refWidth / 2 + waveShift + this.jitter(sunCx, py, 5, t), py, refWidth, 2 + depth * 3);
    }

    // Perspective Audio Waves (Ink surface ripples)
    const points = 64;
    ctx.globalAlpha = 0.25 + treble * 0.5;
    ctx.strokeStyle = this.colors.ink;
    ctx.lineWidth = 1 + treble * 2;
    ctx.lineCap = "round";

    const waveCount = 5 + Math.floor(energy * 3);
    for (let wIdx = 0; wIdx < waveCount; wIdx++) {
      const depth = (wIdx + (t * 0.5) % 1) / waveCount; // Waves drift forward
      if (depth <= 0 || depth >= 1) continue;

      const y = horizonY + Math.pow(depth, 1.5) * (h - horizonY); // Perspective curve
      const width = w * (0.3 + depth * 0.7);
      const left = (w - width) / 2;
      const right = left + width;

      ctx.beginPath();
      for (let i = 0; i < points; i++) {
        const x = left + ((right - left) * i) / (points - 1);
        const offsetIdx = Math.floor(((i / points) + depth) * (timeData?.length || points)) % (timeData?.length || points);
        const sample = timeData ? (timeData[offsetIdx] - 128) / 128 : Math.sin(t * 2 + i * 0.35 + wIdx) * 0.15;

        const scratch = Math.sin(i * 0.62 + t * 2.4 + wIdx) * (1 + depth * 3);
        const yy = y + sample * (h * 0.08 * depth) + scratch;

        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  processWildlife(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, energy: number, dt: number, t: number) {
    if (!this.fish && Math.random() < 0.001 * (1 + energy * 2)) {
      this.fish = { x: w * 0.2 + Math.random() * w * 0.6, y: horizonY + 5, vx: (Math.random() - 0.5) * 200, vy: -300 - Math.random() * 250, active: true };
      this.splats.push({ x: this.fish.x, y: horizonY, life: 0.4, maxLife: 0.4 });
    }

    if (this.birds.length < 4 && Math.random() < 0.005) {
      const fromLeft = Math.random() > 0.5;
      this.birds.push({
        x: fromLeft ? -20 : w + 20,
        y: horizonY - h * 0.15 - Math.random() * h * 0.3,
        vx: (fromLeft ? 1 : -1) * (120 + Math.random() * 80),
        vy: (Math.random() - 0.5) * 40,
        flapPhase: Math.random() * Math.PI * 2
      });
    }

    ctx.save();
    ctx.strokeStyle = this.colors.ink;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.fish && this.fish.active) {
      this.fish.x += this.fish.vx * dt;
      this.fish.vy += 700 * dt;
      this.fish.y += this.fish.vy * dt;

      if (this.fish.y > horizonY + 20) {
        this.splats.push({ x: this.fish.x, y: horizonY, life: 0.4, maxLife: 0.4 });
        this.fish = null;
      } else {
        const angle = Math.atan2(this.fish.vy, this.fish.vx);
        ctx.translate(this.fish.x, this.fish.y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(-6, 0); ctx.quadraticCurveTo(0, -5, 8, 0); ctx.quadraticCurveTo(0, 5, -6, 0);
        ctx.moveTo(-6, 0); ctx.lineTo(-10, -4); ctx.moveTo(-6, 0); ctx.lineTo(-10, 4);
        ctx.stroke();
        ctx.resetTransform();
      }
    }

    for (let i = this.birds.length - 1; i >= 0; i--) {
      let b = this.birds[i];
      b.flapPhase += 18 * dt;

      if (this.fish && this.fish.y < horizonY) {
        const dx = this.fish.x - b.x; const dy = this.fish.y - b.y;
        b.vx += (dx * 0.8) * dt; b.vy += (dy * 0.8) * dt;
        const speed = Math.hypot(b.vx, b.vy);
        if (speed > 350) { b.vx = (b.vx / speed) * 350; b.vy = (b.vy / speed) * 350; }
      } else {
        b.vy += (Math.sin(t + i) * 60 - b.vy) * dt;
      }

      b.x += b.vx * dt; b.y += b.vy * dt;

      if (b.x < -100 || b.x > w + 100 || b.y < -100 || b.y > h) {
        this.birds.splice(i, 1); continue;
      }

      const flapY = Math.sin(b.flapPhase) * 6;
      ctx.beginPath();
      ctx.moveTo(b.x - 8, b.y - flapY);
      ctx.quadraticCurveTo(b.x - 4, b.y, b.x, b.y + 2);
      ctx.quadraticCurveTo(b.x + 4, b.y, b.x + 8, b.y - flapY);
      ctx.stroke();
    }
    ctx.restore();
  }

  processWeather(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, energy: number, dt: number, t: number, transRect: any) {
    if (energy > 0.35) {
      const spawnCount = Math.floor((energy - 0.3) * 6);
      for (let d = 0; d < spawnCount; d++) {
        const z = 0.5 + Math.random() * 1.5;
        this.drops.push({
          x: Math.random() * w, y: -20, z,
          isBg: Math.random() > 0.6,
          speed: 600 * z + Math.random() * 300 + (energy * 300),
          length: 10 * z + Math.random() * 15
        });
      }
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.strokeStyle = this.colors.blueprintSoft;

    for (let i = this.drops.length - 1; i >= 0; i--) {
      let drop = this.drops[i];
      drop.y += drop.speed * dt;
      drop.x += (drop.speed * 0.04 * energy) * dt;

      let hitObstacle = false;
      let splatY = 0;

      if (drop.isBg) {
        if (drop.y > horizonY) { hitObstacle = true; splatY = horizonY; }
      } else {
        // Rain hits the Translation Text (since it's on the water surface)
        if (transRect && drop.y > transRect.top && drop.y < transRect.bottom && drop.x > transRect.left && drop.x < transRect.right) {
          hitObstacle = true; splatY = drop.y; // Splat exactly where it hit the word
        } else if (drop.y > h) {
          hitObstacle = true; splatY = h;
        }
      }

      if (hitObstacle) {
        this.splats.push({ x: drop.x, y: splatY, life: 0.2, maxLife: 0.2 });
        this.drops.splice(i, 1);
        continue;
      }

      ctx.globalAlpha = drop.isBg ? 0.2 : 0.5;
      ctx.lineWidth = drop.isBg ? 1 : 1.5;
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x + (drop.speed * 0.02), drop.y + drop.length);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.4;
    for (let i = this.splats.length - 1; i >= 0; i--) {
      let splat = this.splats[i];
      splat.life -= dt;
      if (splat.life <= 0) { this.splats.splice(i, 1); continue; }

      const progress = 1 - (splat.life / splat.maxLife);
      const radius = progress * 10;

      ctx.beginPath();
      // Squashed ripples
      ctx.ellipse(splat.x, splat.y, radius * 2, radius * 0.4, 0, 0, Math.PI * 2);
      ctx.strokeStyle = this.colors.blueprint;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}