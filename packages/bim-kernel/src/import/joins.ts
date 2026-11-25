import { angleBetween, dist3, sub3 } from "../routing/geometry";
import { sameSize } from "../routing/rules";
import type { RunFitting, RunPoint, RunSegment } from "../routing/types";
import type { BimElement, ElementId, Level } from "../types";
import type { ImportJoin, ImportPoint, ImportPort, ImportProduct, ImportSource } from "./types";

/**
 * Joins between converted records (round 9 I9). A link is two records, each
 * naming the other, so no rule can write one alone: once every rule has run,
 * this pass makes each join the file states on both sides, or leaves both
 * sides open and says why in the report.
 *
 * - A fitting's rule links its openings to the straight pieces they join;
 *   those pieces get the link back here, and the run a branch fitting sits
 *   on lists it.
 * - Two straight pieces the file joins end to end are linked to each other
 *   when they run straight on at one size in one system.
 * - A join whose far side has no connection point here (a part, until parts
 *   keep theirs) or didn't come in is counted, with the reason.
 *
 * Nothing is left half made: a link that can't be written on both sides is
 * taken off the side that had it. Reads each connection point once and keeps
 * one entry per join: O(connection points in the file).
 */

type End = "start" | "end";

export interface JoinRunsInput {
  readonly source: ImportSource;
  /** A record of the plan as it stands now (an earlier join may have replaced it). */
  record(id: ElementId): BimElement | undefined;
  /** Put a record with a link added or taken off in place of the one with its id. */
  replace(record: BimElement): void;
  /** The record a product became. */
  converted(sourceId: string): BimElement | null;
  joinedTo(port: ImportPort): readonly ImportJoin[];
  level(product: ImportProduct): Level | null;
  note(text: string): void;
  /** How near two ends must be to be joined, mm: the model's own limit for a connection, which landing checks. */
  readonly toleranceMm: number;
}

/** Two straight pieces joined end to end run straight on: within this of 180° apart. */
const STRAIGHT_DEG = 0.5;

const CROWDED = "the file joins more than one thing to that end of the run";
const NO_POINT_ON_PART = "one side is a part, and a part's connection points aren't brought in yet";
const NO_POINT = "one side came in as something that has no connection points here";
const NOT_READ = "the fitting came in without that join";

function segmentOf(input: JoinRunsInput, id: ElementId): RunSegment | null {
  const r = input.record(id);
  return r?.kind === "run_segment" ? r : null;
}

function fittingOf(input: JoinRunsInput, id: ElementId): RunFitting | null {
  const r = input.record(id);
  return r?.kind === "run_fitting" ? r : null;
}

/** A straight piece's end with its height from the model's zero. */
function endPoint(seg: RunSegment, end: End, floorMm: number): RunPoint {
  const p = end === "start" ? seg.start : seg.end;
  return { x: p.x, y: p.y, z: p.z + floorMm };
}

/** The end of a straight piece nearest a point of the file. */
function nearestEnd(seg: RunSegment, floorMm: number, at: ImportPoint): End {
  return dist3(endPoint(seg, "start", floorMm), at) <= dist3(endPoint(seg, "end", floorMm), at) ? "start" : "end";
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}~${b}` : `${b}~${a}`);

/**
 * Make a converted fitting's links mutual: each straight piece an opening names gets the link back, and the run a
 * branch fitting sits on lists it. An opening whose piece can't take the link is left open, with the reason kept for
 * the pair.
 */
function closeFittingLinks(input: JoinRunsInput, fittingId: ElementId, unmade: Map<string, string>): void {
  const fitting = fittingOf(input, fittingId);
  if (!fitting) return;
  let changed = false;
  const ports = fitting.ports.map((port) => {
    if (!port.link) return port;
    const seg = segmentOf(input, port.link.elementId);
    const end = port.link.port === "start" || port.link.port === "end" ? port.link.port : null;
    const back = seg && end ? seg.links[end] : undefined;
    if (seg && end && back?.elementId === fitting.id && back.port === port.id) return port;
    if (seg && end && !back) {
      input.replace({ ...seg, links: { ...seg.links, [end]: { elementId: fitting.id, port: port.id } } });
      return port;
    }
    changed = true;
    unmade.set(pairKey(fitting.id, port.link.elementId), seg ? CROWDED : NO_POINT);
    return { id: port.id, position: port.position, direction: port.direction, size: port.size };
  });
  if (changed) input.replace({ ...fitting, ports });
  if (!fitting.host) return;
  const host = segmentOf(input, fitting.host.segmentId);
  if (host && !host.branches.includes(fitting.id)) input.replace({ ...host, branches: [...host.branches, fitting.id] });
}

/** Whether a fitting and a straight piece are joined now: an opening linked to the piece, or the fitting sitting on it. */
function fittingOnSegment(fitting: RunFitting, seg: RunSegment): boolean {
  return fitting.host?.segmentId === seg.id || fitting.ports.some((p) => p.link?.elementId === seg.id);
}

/** Link two straight pieces at the ends the file joins, or say why not. */
function joinSegments(input: JoinRunsInput, aId: ElementId, aProduct: ImportProduct, aPort: ImportPort, bId: ElementId, far: ImportJoin): string | null {
  const a = segmentOf(input, aId);
  const b = segmentOf(input, bId);
  if (!a || !b) return NO_POINT;
  if (a.id === b.id) return "the file joins a run to itself";
  const aFloor = input.level(aProduct)?.elevationMm ?? 0;
  const bFloor = input.level(far.product)?.elevationMm ?? 0;
  const at = aPort.position ?? far.port.position;
  let aEnd: End;
  let bEnd: End;
  if (at) {
    aEnd = nearestEnd(a, aFloor, at);
    bEnd = nearestEnd(b, bFloor, far.port.position ?? at);
  } else {
    // The file doesn't say where: the two ends that are nearest each other.
    const ends: readonly End[] = ["start", "end"];
    let best = Infinity;
    aEnd = "start";
    bEnd = "start";
    for (const x of ends) {
      for (const y of ends) {
        const gap = dist3(endPoint(a, x, aFloor), endPoint(b, y, bFloor));
        if (gap < best) [best, aEnd, bEnd] = [gap, x, y];
      }
    }
  }
  if (dist3(endPoint(a, aEnd, aFloor), endPoint(b, bEnd, bFloor)) > input.toleranceMm) return "their ends don't meet where the file joins them";
  if (a.links[aEnd] || b.links[bEnd]) return "one of those ends is already joined to something else";
  if (a.systemId !== b.systemId) return "the file puts them in different systems";
  const away = (seg: RunSegment, end: End) => (end === "start" ? sub3(seg.end, seg.start) : sub3(seg.start, seg.end));
  if (180 - angleBetween(away(a, aEnd), away(b, bEnd)) > STRAIGHT_DEG) return "the file joins them where they turn, with no fitting between them";
  if (!sameSize(a.size, b.size)) return "the file joins them where they change size, with no fitting between them";
  input.replace({ ...a, links: { ...a.links, [aEnd]: { elementId: b.id, port: bEnd } } });
  input.replace({ ...b, links: { ...b.links, [bEnd]: { elementId: a.id, port: aEnd } } });
  return null;
}

export function joinRuns(input: JoinRunsInput): void {
  // What converted and has connection points the file joins to something: everything else is passed over once.
  const joined: Array<{ readonly product: ImportProduct; readonly id: ElementId }> = [];
  const fittings: ElementId[] = [];
  for (const product of input.source.products) {
    if (product.ports.length === 0) continue;
    const record = input.converted(product.sourceId);
    if (!record) continue;
    if (record.kind === "run_fitting") fittings.push(record.id);
    if (product.ports.some((port) => port.connectedTo.length > 0)) joined.push({ product, id: record.id });
  }
  if (joined.length === 0 && fittings.length === 0) return;

  // Why a fitting's link was taken off again, by the pair of records.
  const stripped = new Map<string, string>();
  for (const id of fittings) closeFittingLinks(input, id, stripped);

  // Every join the file states with at least one side converted, each once.
  let stayed = 0;
  const unmade = new Map<string, number>();
  const count = (why: string) => unmade.set(why, (unmade.get(why) ?? 0) + 1);
  const seen = new Set<string>();
  for (const { product, id } of joined) {
    for (const port of product.ports) {
      if (port.connectedTo.length === 0) continue;
      const far = input.joinedTo(port);
      // A point on a product the reader left out.
      stayed += port.connectedTo.length - far.length;
      for (const other of far) {
        const key = pairKey(port.id, other.port.id);
        if (seen.has(key)) continue;
        seen.add(key);
        const here = input.record(id);
        const there = input.converted(other.product.sourceId);
        if (!here) continue;
        if (!there) {
          stayed += 1;
          continue;
        }
        const run = (r: BimElement): r is RunSegment | RunFitting => r.kind === "run_segment" || r.kind === "run_fitting";
        if (here.kind === "run_segment" && there.kind === "run_segment") {
          const why = joinSegments(input, here.id, product, port, there.id, other);
          if (why) count(why);
        } else if (run(here) && run(there)) {
          const [fitting, seg] = here.kind === "run_fitting" ? [here, there] : [there, here];
          const made = fitting.kind === "run_fitting" && seg.kind === "run_segment" && fittingOnSegment(fitting, seg);
          if (!made) count(stripped.get(pairKey(here.id, there.id)) ?? NOT_READ);
        } else count(here.kind === "part" || there.kind === "part" ? NO_POINT_ON_PART : NO_POINT);
      }
    }
  }
  const lead = (n: number) => (n === 1 ? "1 join in the file wasn't made" : `${n} joins in the file weren't made`);
  for (const [why, n] of unmade) input.note(`${lead(n)} (${why}); the ends there are open, so join them by hand`);
  if (stayed > 0) input.note(`${lead(stayed)} (one side stayed on the linked model); the end that came in is open there`);
}
