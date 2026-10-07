const dec = new TextDecoder();
const enc = new TextEncoder();

export const ZERO_SHA = "0".repeat(40);

export type Pkt = { kind: "data"; data: Uint8Array } | { kind: "flush" } | { kind: "delim" } | { kind: "end" };

export function encodePkt(s: string): string {
  return (enc.encode(s).length + 4).toString(16).padStart(4, "0") + s;
}

/** Incremental pkt-line reader; buffers partial lines between chunks. */
export class PktReader {
  private buf = new Uint8Array(0);
  private stopped = false;

  push(chunk: Uint8Array, stopAtFlush = false): Pkt[] {
    if (this.stopped) return [];
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: Pkt[] = [];
    let off = 0;
    while (merged.length - off >= 4) {
      const hex = dec.decode(merged.subarray(off, off + 4));
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error(`bad pkt-line length "${hex}"`);
      const len = parseInt(hex, 16);
      if (len <= 2) {
        out.push({ kind: len === 0 ? "flush" : len === 1 ? "delim" : "end" });
        off += 4;
        if (len === 0 && stopAtFlush) {
          this.stopped = true;
          break;
        }
        continue;
      }
      if (len < 4) throw new Error(`bad pkt-line length ${len}`);
      if (merged.length - off < len) break;
      out.push({ kind: "data", data: merged.slice(off + 4, off + len) });
      off += len;
    }
    this.buf = merged.slice(off);
    return out;
  }
}

export type RefCommand = { oldSha: string; newSha: string; ref: string };

/** Reads the receive-pack command list at the start of a push body. */
export class CommandParser {
  private reader = new PktReader();
  commands: RefCommand[] = [];
  capabilities: string[] = [];
  done = false;

  /** Returns true once the command list is complete. */
  push(chunk: Uint8Array): boolean {
    if (this.done) return true;
    for (const pkt of this.reader.push(chunk, true)) {
      if (pkt.kind === "flush") {
        this.done = true;
        return true;
      }
      if (pkt.kind !== "data") continue;
      let line = dec.decode(pkt.data);
      if (line.startsWith("shallow ")) continue;
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        this.capabilities = line.slice(nul + 1).trim().split(" ").filter(Boolean);
        line = line.slice(0, nul);
      }
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line);
      if (!m) throw new Error("bad push command line");
      this.commands.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
    }
    return false;
  }
}

export type RefResult = { ref: string; ok: boolean; reason?: string };

/** Reads report-status from a receive-pack response, optionally inside side-band channel 1. */
export class ReportParser {
  private outer = new PktReader();
  private inner = new PktReader();
  unpackOk: boolean | null = null;
  results: RefResult[] = [];
  done = false;

  constructor(private sideBand: boolean) {}

  push(chunk: Uint8Array): boolean {
    if (this.done) return true;
    for (const pkt of this.outer.push(chunk, true)) {
      if (!this.sideBand) this.handle(pkt);
      else if (pkt.kind === "flush") this.done = true;
      else if (pkt.kind === "data" && pkt.data[0] === 1) {
        for (const p of this.inner.push(pkt.data.subarray(1), true)) this.handle(p);
      }
      if (this.done) return true;
    }
    return this.done;
  }

  private handle(pkt: Pkt) {
    if (pkt.kind === "flush") {
      this.done = true;
      return;
    }
    if (pkt.kind !== "data") return;
    const line = dec.decode(pkt.data).replace(/\n$/, "");
    if (line.startsWith("unpack ")) this.unpackOk = line === "unpack ok";
    else if (line.startsWith("ok ")) this.results.push({ ref: line.slice(3), ok: true });
    else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      this.results.push(sp < 0 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, reason: rest.slice(sp + 1) });
    }
  }
}

/** Parses a v1 upload-pack ref advertisement (info/refs). */
export function parseRefAdvertisement(body: Uint8Array): { refs: Map<string, string>; head: string | null } {
  const refs = new Map<string, string>();
  let head: string | null = null;
  for (const pkt of new PktReader().push(body)) {
    if (pkt.kind !== "data") continue;
    let line = dec.decode(pkt.data).replace(/\n$/, "");
    if (line.startsWith("# service=")) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      const sym = line.slice(nul + 1).split(" ").find((c) => c.startsWith("symref=HEAD:refs/heads/"));
      if (sym) head = sym.slice("symref=HEAD:refs/heads/".length);
      line = line.slice(0, nul);
    }
    const sp = line.indexOf(" ");
    const name = line.slice(sp + 1);
    if (sp > 0 && name !== "capabilities^{}") refs.set(name, line.slice(0, sp));
  }
  return { refs, head };
}

/** Pass-through stream that emits `prefix()` (when not null) once, before the first chunk. */
export function prependOnce(prefix: () => Uint8Array | null): TransformStream<Uint8Array, Uint8Array> {
  let first = true;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (first) {
        first = false;
        const p = prefix();
        if (p) controller.enqueue(p);
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Pass-through stream that shows each chunk to `onChunk` until it returns true.
 * Never tee(): a branch that stops reading would stall the push.
 */
export function tap(onChunk: (chunk: Uint8Array) => boolean, onEnd?: () => void): TransformStream<Uint8Array, Uint8Array> {
  let active = true;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!active) return;
      try {
        if (onChunk(chunk)) active = false;
      } catch (err) {
        active = false;
        console.warn(JSON.stringify({ msg: "git stream parse failed", error: String(err) }));
      }
    },
    flush() {
      onEnd?.();
    },
  });
}

/**
 * Pass-through stream that swaps a known fatal side-band message (band 3) for a readable one.
 * It frames packets itself because PktReader.push throws mid-loop and drops packets it already parsed.
 * Complete packets are forwarded as their original bytes; an incomplete one is held until the rest arrives.
 * After a framing error the rest of the stream passes through raw, unparsed.
 */
export function rewriteFatal(messages: Record<string, string>): TransformStream<Uint8Array, Uint8Array> {
  let pending: Uint8Array = new Uint8Array(0);
  let rawRest = false;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (rawRest) {
        controller.enqueue(chunk);
        return;
      }
      let buf = chunk;
      if (pending.length) {
        buf = new Uint8Array(pending.length + chunk.length);
        buf.set(pending);
        buf.set(chunk, pending.length);
      }
      let off = 0;
      while (buf.length - off >= 4) {
        const hex = dec.decode(buf.subarray(off, off + 4));
        const len = /^[0-9a-f]{4}$/i.test(hex) ? parseInt(hex, 16) : -1;
        if (len < 0 || (len > 0 && len < 4)) {
          rawRest = true;
          break;
        }
        const size = len === 0 ? 4 : len; // 0000 is a flush packet
        if (buf.length - off < size) break;
        const pkt = buf.subarray(off, off + size);
        const text = pkt.length > 4 && pkt[4] === 3 ? dec.decode(pkt.subarray(5)).trim() : null;
        controller.enqueue(text !== null && Object.hasOwn(messages, text) ? enc.encode(encodePkt(`\x03${messages[text]}\n`)) : pkt);
        off += size;
      }
      const rest = buf.subarray(off);
      if (rawRest) {
        controller.enqueue(rest);
        pending = new Uint8Array(0);
      } else pending = rest;
    },
    flush(controller) {
      if (pending.length) controller.enqueue(pending);
    },
  });
}
