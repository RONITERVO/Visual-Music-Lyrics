/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

export class GraphiteDesignSystem {
    canvas: HTMLCanvasElement | null = null;
    ctx: CanvasRenderingContext2D | null = null;
    lamp: HTMLElement | null = null;
    time: number = 0;
    fps: number = 12; // "Spider-Verse / Stop Motion" feel
    fpsInterval: number = 1000 / 12;
    then: number = performance.now();
    
    colors: Record<string, string> = {
        'graphite': 'rgba(235, 230, 228, 0.95)',
        'graphite-light': 'rgba(235, 230, 228, 0.4)',
        'blueprint': 'rgba(100, 180, 255, 0.9)',
        'red': 'rgba(255, 100, 100, 0.9)',
        'paper': 'rgba(255, 255, 255, 0.05)'
    };

    drawables: any[] = [];
    hoveredElement: HTMLElement | null = null;
    observer: MutationObserver | null = null;
    rafId: number = 0;
    boundResize: () => void;
    boundMouse: (e: MouseEvent) => void;

    constructor() {
        this.boundResize = this.resize.bind(this);
        this.boundMouse = this.handleMouse.bind(this);
    }

    init() {
        this.canvas = document.getElementById('graphite-overlay') as HTMLCanvasElement;
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.lamp = document.getElementById('desk-lamp');
        
        this.resize();
        window.addEventListener('resize', this.boundResize);
        
        window.addEventListener('mousemove', this.boundMouse);

        this.scanDOM();
        this.observer = new MutationObserver(() => this.scanDOM());
        this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-sketch-box', 'data-sketch-btn', 'data-sketch-underline'] });
        this.renderLoop();
    }

    destroy() {
        window.removeEventListener('resize', this.boundResize);
        window.removeEventListener('mousemove', this.boundMouse);
        this.observer?.disconnect();
        this.observer = null;
        if (this.rafId) cancelAnimationFrame(this.rafId);
    }

    handleMouse(e: MouseEvent) {
        if (this.lamp) {
            this.lamp.style.setProperty('--mouse-x', `${e.clientX}px`);
            this.lamp.style.setProperty('--mouse-y', `${e.clientY}px`);
        }
        this.hoveredElement = null;
        for (let item of this.drawables) {
            if (item.node.hasAttribute('data-sketch-btn') || item.node.hasAttribute('data-sketch-choice') || item.node.classList.contains('song-card-main')) {
                if (e.clientX >= item.rect.left && e.clientX <= item.rect.right &&
                    e.clientY >= item.rect.top && e.clientY <= item.rect.bottom) {
                    this.hoveredElement = item.node;
                    break;
                }
            }
        }
    }

    resize() {
        if(!this.canvas || !this.ctx) return;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = window.innerWidth * dpr;
        this.canvas.height = window.innerHeight * dpr;
        this.ctx.scale(dpr, dpr);
        this.canvas.style.width = window.innerWidth + 'px';
        this.canvas.style.height = window.innerHeight + 'px';
        this.scanDOM(); 
    }

    scanDOM() {
        const elements = document.querySelectorAll('[data-sketch-box], [data-sketch-btn], [data-sketch-underline], [data-sketch-highlight], .song-card-main');
        this.drawables = Array.from(elements).map(el => ({
            node: el as HTMLElement,
            rect: el.getBoundingClientRect(), 
            progress: 0 
        }));
    }

    jitter(x: number, y: number, amp: number) {
        const frame = Math.floor(this.time * 4) % 3; 
        const seed = x * 12.9898 + y * 78.233 + frame * 13.131;
        const h = Math.sin(seed) * 43758.5453;
        return ((h - Math.floor(h)) - 0.5) * amp;
    }

    drawRoughLine(x1: number, y1: number, x2: number, y2: number, passes: number, roughness: number, progress = 1) {
        if (!this.ctx) return;
        this.ctx.beginPath();
        const dx = x2 - x1; const dy = y2 - y1;
        const tx = x1 + (dx * progress); const ty = y1 + (dy * progress);

        for (let i = 0; i < passes; i++) {
            const ox1 = x1 + this.jitter(x1, y1 + i, roughness);
            const oy1 = y1 + this.jitter(x1 + i, y1, roughness);
            const ox2 = tx + this.jitter(tx, ty + i, roughness);
            const oy2 = ty + this.jitter(tx + i, ty, roughness);
            this.ctx.moveTo(ox1, oy1);
            const mx = (x1 + tx) / 2 + this.jitter((x1 + tx)/2, (y1 + ty)/2 + i, roughness * 1.5);
            const my = (y1 + ty) / 2 + this.jitter((x1 + tx)/2 + i, (y1 + ty)/2, roughness * 1.5);
            this.ctx.quadraticCurveTo(mx, my, ox2, oy2);
        }
        this.ctx.stroke();
    }

    drawCrossHatch(x: number, y: number, w: number, h: number, color: string) {
        if (!this.ctx) return;
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        const gap = 8;
        for (let i = -h; i < w; i += gap) {
            const startX = Math.max(x, x + i); const startY = Math.max(y, y + h - (x + i + h - x));
            const endX = Math.min(x + w, x + i + h); const endY = Math.min(y + h, y + h - (x + i - x));
            if (startX < endX) { this.ctx.moveTo(startX + this.jitter(startX, startY, 4), startY); this.ctx.lineTo(endX + this.jitter(endX, endY, 4), endY); }
        }
        for (let i = 0; i < w + h; i += gap * 1.5) {
            const startX = Math.max(x, x + w - i); const startY = Math.max(y, y + i - w);
            const endX = Math.min(x + w, x + w - i + h); const endY = Math.min(y + h, y + i);
            if (startX < endX) { this.ctx.moveTo(startX + this.jitter(startX, startY, 3), startY); this.ctx.lineTo(endX + this.jitter(endX, endY, 3), endY); }
        }
        this.ctx.stroke();
    }

    drawRoughBox(rect: DOMRect, colorKey: string, passes: number, roughness: number, bgFillKey: string | null, p: number) {
        if (!this.ctx) return;
        if (bgFillKey && this.colors[bgFillKey]) {
            this.ctx.fillStyle = this.colors[bgFillKey];
            this.ctx.beginPath();
            this.ctx.moveTo(rect.left - 2, rect.top - 2); this.ctx.lineTo(rect.right + 2, rect.top - 1);
            this.ctx.lineTo(rect.right + 1, rect.bottom + 2); this.ctx.lineTo(rect.left - 1, rect.bottom + 1);
            this.ctx.fill();
        }
        this.ctx.strokeStyle = this.colors[colorKey] || this.colors['graphite'];
        this.ctx.lineWidth = 2; this.ctx.lineCap = 'round';
        const pT = Math.min(1, p * 4); const pR = Math.max(0, Math.min(1, (p * 4) - 1));
        const pB = Math.max(0, Math.min(1, (p * 4) - 2)); const pL = Math.max(0, Math.min(1, (p * 4) - 3));

        if (pT > 0) this.drawRoughLine(rect.left, rect.top, rect.right, rect.top, passes, roughness, pT);
        if (pR > 0) this.drawRoughLine(rect.right, rect.top, rect.right, rect.bottom, passes, roughness, pR);
        if (pB > 0) this.drawRoughLine(rect.right, rect.bottom, rect.left, rect.bottom, passes, roughness, pB);
        if (pL > 0) this.drawRoughLine(rect.left, rect.bottom, rect.left, rect.top, passes, roughness, pL);
    }

    renderLoop() {
        this.rafId = requestAnimationFrame(() => this.renderLoop());

        const now = performance.now();
        const elapsed = now - this.then;

        if (elapsed > this.fpsInterval) {
            this.then = now - (elapsed % this.fpsInterval);
            this.time += 0.1;

            if(!this.ctx || !this.canvas) return;
            this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

            for (let item of this.drawables) {
                if(!document.contains(item.node)) {
                    continue; // node removed
                }
                const rect = item.node.getBoundingClientRect();
                item.rect = rect;
                if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                if (rect.width === 0 || rect.height === 0) continue; // Skip hidden
                if (item.progress < 1) item.progress += 0.08;

                const passes = parseInt(item.node.getAttribute('data-sketch-passes') || "2");
                const roughness = parseInt(item.node.getAttribute('data-sketch-roughness') || "4");

                const boxColorKey = item.node.getAttribute('data-sketch-box');
                if (boxColorKey) {
                    const expanded = { left: rect.left - 8, right: rect.right + 8, top: rect.top - 8, bottom: rect.bottom + 8 } as any;
                    this.drawRoughBox(expanded, boxColorKey, passes, roughness, item.node.getAttribute('data-sketch-bg'), item.progress);
                }

                // If it's a song card, fake it
                let isBtnHovered = false;
                let isHovered = (this.hoveredElement === item.node) || item.node.contains(this.hoveredElement);
                 
                const btnColorKey = item.node.getAttribute('data-sketch-btn') || (item.node.classList.contains('song-card-main') ? 'graphite' : null);
                if (btnColorKey && item.node.matches('button, .song-card-main, .setup-choice, .add-card')) {
                    const btnColor = this.colors[btnColorKey] || this.colors['graphite'];
                    if (isHovered) this.drawCrossHatch(rect.left + 2, rect.top + 2, rect.width - 4, rect.height - 4, btnColor);
                    this.drawRoughBox(rect, btnColorKey, passes, isHovered ? roughness + 2 : roughness, null, item.progress);
                }

                const underColorKey = item.node.getAttribute('data-sketch-underline');
                if (underColorKey) {
                    const isFocused = document.activeElement === item.node;
                    this.ctx.strokeStyle = this.colors[underColorKey] || this.colors['graphite'];
                    this.ctx.lineWidth = isFocused ? 3 : 2;
                    this.drawRoughLine(rect.left, rect.bottom, rect.right, rect.bottom, isFocused ? passes+1 : passes, isFocused ? roughness+2 : roughness, item.progress);
                }

                const highColorKey = item.node.getAttribute('data-sketch-highlight');
                if (highColorKey) {
                    this.ctx.strokeStyle = this.colors[highColorKey] || this.colors['highlighter'];
                    this.ctx.lineWidth = rect.height * 0.8;
                    this.ctx.globalCompositeOperation = 'multiply';
                    this.drawRoughLine(rect.left - 5, rect.top + rect.height/2, rect.right + 5, rect.top + rect.height/2, 2, 8, item.progress);
                    this.ctx.globalCompositeOperation = 'source-over';
                }
            }
        }
    }
}
