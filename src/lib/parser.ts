/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { createId, looksLikeJson, looksLikeLooseJson } from "./utils";
import { Segment } from "../types";

export function parseTranscript(text: string, extension: string): { kind: "timed", title?: string, segments: Segment[] } {
  const trimmed = text.trim(); 
  if (!trimmed) return { kind: "timed", segments: [] };
  
  if (extension === "json" || looksLikeJson(trimmed) || looksLikeLooseJson(trimmed)) {
      return parseJsonTranscript(trimmed);
  }
  if (extension === "vtt" || trimmed.startsWith("WEBVTT")) {
      return { kind: "timed", segments: parseCueTranscript(trimmed) };
  }
  if (extension === "srt" || /\d\d:\d\d:\d\d[,.]\d{1,3}\s+-->\s+\d\d:\d\d:\d\d[,.]\d{1,3}/.test(trimmed)) {
      return { kind: "timed", segments: parseCueTranscript(trimmed) };
  }
  
  const looseTimed = parseLooseTimedText(trimmed); 
  if (looseTimed.length) return { kind: "timed", segments: normalizeSegments(looseTimed) };

  return { kind: "timed", segments: parsePlainText(trimmed) };
}

function parseCueTranscript(text: string): Segment[] {
    const clean = text.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n/i, "").trim(); 
    const blocks = clean.split(/\n{2,}/); 
    const segments: any[] = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean); 
      if (!lines.length) continue;
      
      let timeLineIndex = lines.findIndex((line) => line.includes("-->")); 
      if (timeLineIndex < 0) continue;
      
      const timeLine = lines[timeLineIndex]; 
      const [rawStart, rawEnd] = timeLine.split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const start = parseTimestamp(rawStart); 
      const end = parseTimestamp(rawEnd); 
      const body = lines.slice(timeLineIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
      if (body && Number.isFinite(start)) {
          segments.push({ start, end: Number.isFinite(end) ? end : start + estimateTextDuration(body), text: body, raw: body });
      }
    }
    return normalizeSegments(segments);
}

function parseJsonTranscript(text: string) {
    let data; 
    try { data = JSON.parse(text); } catch (e) {
        // try loose fix
        const cleaned = text.trim().replace(/,\s*$/, "");
        data = JSON.parse(cleaned.endsWith("}") ? `{${cleaned}` : `{${cleaned}}`);
    }

    const segments = Array.isArray(data) ? data : data.segments || data.transcript || data.captions || [];
    if (segments.length) {
        const parsed = segments.map((item: any, index: number) => {
          const text = item.text || item.primary || item.content || item.lyric || item.raw || "";
          return {
            id: item.id,
            start: item.start ?? item.startTime ?? item.start_time,
            end: item.end ?? item.endTime ?? item.end_time,
            text,
            raw: item.raw || text,
            primary: item.primary || text,
            translation: item.translation || item.secondary || "",
            secondary: item.secondary || "",
            speaker: item.speaker || "",
            section: item.section || "",
            role: item.role || item.kind || "lyric",
            kind: item.kind || item.role || "lyric",
            words: Array.isArray(item.words) ? item.words : [],
            characterTimeline: Array.isArray(item.characterTimeline) ? item.characterTimeline : [],
            order: item.order ?? index,
            source: item.source || data.source || data.transcriptionSource || "",
            translationSource: item.translationSource || data.translationSource || "",
            language_code: item.language_code || data.language_code || ""
          };
        });
        return { kind: "timed" as any, segments: normalizeSegments(parsed) };
    }
    
    return { kind: "timed" as any, segments: parsePlainText(data.text || data.transcript || "") };
}

function parseLooseTimedText(text: string) {
    const lines = text.replace(/\r/g, "").split("\n"); 
    const segments: any[] = [];
    
    const timeValue = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}(?:[.,]\\d+)?|\\d+(?:\\.\\d+)?";
    const pattern = new RegExp(`^\\[?\\s*(${timeValue})\\s*(?:-->|-|to)\\s*(${timeValue})\\s*\\]?\\s*(?:[:|-]\\s*)?(.*)$`, "i");
    
    for (const line of lines) { 
        const clean = line.trim().replace(/^\d+[.)]\s+/, "").replace(/^[-*]\s+/, ""); 
        if (!clean) continue;
        const match = clean.match(pattern); 
        if (!match) continue;
        const start = parseTimestamp(match[1]); 
        const end = parseTimestamp(match[2]); 
        const body = match[3].trim();
        if (body && Number.isFinite(start)) {
            segments.push({ start, end: Number.isFinite(end) && end > start ? end : start + estimateTextDuration(body), text: body, raw: body, role: "lyric" });
        }
    }
    return segments.length >= 2 ? segments : [];
}

function parsePlainText(text: string) {
    const lines = text.split(/\n+/).map((line, index) => ({ start: NaN, end: NaN, text: line.trim(), raw: line.trim(), order: index })).filter(s => s.text);
    return normalizeSegments(lines);
}

function normalizeSegments(rawSegments: any[]): Segment[] {
    const segments = rawSegments.map((seg, i) => {
        const split = splitBilingualText(seg.text || seg.raw || "");
        const start = Number(seg.start);
        const end = Number(seg.end);
        return {
            id: seg.id || createId("seg"),
            start: Number.isFinite(start) ? start : NaN,
            end: Number.isFinite(end) ? end : NaN,
            primary: seg.primary || split.primary || seg.text || "",
            translation: seg.translation || split.translation || "",
            secondary: seg.secondary || split.secondary || "",
            raw: seg.raw || seg.text || "",
            speaker: seg.speaker || "",
            section: seg.section || "",
            role: seg.role || seg.kind || "lyric",
            kind: seg.kind || seg.role || "lyric",
            words: Array.isArray(seg.words) ? seg.words : [],
            characterTimeline: Array.isArray(seg.characterTimeline) ? seg.characterTimeline : [],
            order: seg.order ?? i,
            source: seg.source || "",
            translationSource: seg.translationSource || "",
            language_code: seg.language_code || ""
        };
    }).filter((s) => s.primary || s.translation || s.raw)
      .sort((a, b) => {
        if (Number.isFinite(a.start) && Number.isFinite(b.start)) {
            if (a.start === b.start) return a.order - b.order;
            return a.start - b.start;
        }
        return a.order - b.order;
    });

    const mergedSegments: Segment[] = [];
    for (const segment of segments) {
        const last = mergedSegments[mergedSegments.length - 1];
        if (last && Number.isFinite(last.start) && last.start === segment.start && Math.abs(last.end - segment.end) < 0.5) {
            if (segment.role === "adlib" || segment.primary.startsWith("(")) {
                last.translation = last.translation ? last.translation + " / " + segment.primary : segment.primary;
            } else if (last.role === "adlib" || last.primary.startsWith("(")) {
                 const temp = last.primary;
                 last.primary = segment.primary;
                 last.translation = last.translation ? segment.translation + " / " + temp : temp;
                 if (segment.role !== "adlib") last.role = segment.role;
            } else {
                 last.primary = last.primary + " " + segment.primary;
            }
        } else {
            mergedSegments.push(segment);
        }
    }

    for (let index = 0; index < mergedSegments.length; index += 1) {
      const segment = mergedSegments[index];
      if (Number.isFinite(segment.start) && !Number.isFinite(segment.end)) {
        const next = mergedSegments[index + 1];
        segment.end = next && Number.isFinite(next.start) ? next.start - 0.06 : segment.start + estimateTextDuration(segment.raw);
      }
      if (Number.isFinite(segment.start) && segment.end <= segment.start) {
        segment.end = segment.start + estimateTextDuration(segment.raw);
      }
    }
    return mergedSegments;
}

export function splitBilingualText(text: string) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return { primary: "", translation: "", secondary: "" };

    const adlib = normalized.match(/^\(([^)]+)\)$/);
    if (adlib) {
      return { primary: stripTrailingDots(adlib[1]), translation: "", secondary: "" };
    }

    const parenthetical = normalized.match(/^(.*?)\s*[\(\[]([^)\]]+)[\)\]]\s*$/);
    if (parenthetical && parenthetical[1].trim()) {
      return {
        primary: parenthetical[1].trim(),
        translation: stripTranslationMarks(parenthetical[2]),
        secondary: ""
      };
    }

    const explicit = normalized.split(/\s+(?:\/|\||=>|->|=)\s+/).map((part) => part.trim()).filter(Boolean);
    if (explicit.length >= 2) {
      return {
        primary: explicit[0],
        translation: explicit.slice(1).join(" / "),
        secondary: ""
      };
    }

    const sentences = normalized.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) || [normalized];
    if (sentences.length >= 2) {
      return {
        primary: sentences[0],
        translation: sentences.slice(1).join(" "),
        secondary: ""
      };
    }

    return { primary: normalized, translation: "", secondary: "" };
}

export function stripTranslationMarks(value: string) {
    return value.replace(/^\s*(translation|english|en)\s*:\s*/i, "").trim();
}

export function stripTrailingDots(value: string) {
    return value.replace(/\s+/g, " ").replace(/\.{3,}$/g, "").trim();
}

function parseTimestamp(value: string | number): number {
    if (typeof value === "number") return value;
    if (!value) return NaN; 
    const cleaned = value.replace(",", ".").trim(); 
    const parts = cleaned.split(":");
    if (parts.length === 1) return Number(cleaned); 
    let seconds = 0;
    for (const part of parts) { 
        seconds = seconds * 60 + Number(part); 
    }
    return seconds;
}

function estimateTextDuration(text: string) {
    const words = (text || "").trim().split(/\s+/).filter(Boolean).length; 
    return Math.min(6.5, Math.max(1.1, words * 0.42 + 0.85)); 
}
