/**
 * @jest-environment node
 *
 * importIfc brings run fittings back and re-joins the runs through them
 * (#59, #66, the shape agreed in #135). An exported elbow, transition, cap or
 * tap came back as nothing ("no class in this model takes it"), and every
 * straight piece came back with no links. A fitting now converts from what
 * the file joins its openings to, and each join the file states between two
 * converted pieces is made on both sides. What can't convert stays on the
 * linked model with its reason, and a join that can't be made is listed in
 * the report.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, importChunks, landImport, planIfcImport, validateModel, type BimElement, type IfcImportPlan, type ImportProduct, type ImportSource, type ModelState, type PortRef, type RunFitting, type RunSegment } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc, readIfcSource, readStep } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import { IfcText, hostModel } from "./i9-fixtures";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";
const FT = 304.8;

/** Runs a script on an empty model and commits its edits; returns the log so a test can add commands. */
async function build(def: ScriptDefinition): Promise<Log> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:import-run-fittings" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m;
}

const ofKind = <K extends BimElement["kind"]>(elements: readonly BimElement[], kind: K) => elements.filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);
const empty = (): ModelState => ({ modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
const READ = { sourceId: "rt", label: "Round trip", disciplines: ["mechanical"] };
const PLAN = { referenceId: "ref", sourceKey: "rt" };

function twins(model: ModelState, globalIds: Readonly<Record<string, string>>, plan: IfcImportPlan) {
  const byId = new Map(plan.records.map((r) => [r.id as string, r]));
  /** The record an original element came back as, or undefined when it stayed linked. */
  const twin = (id: string): BimElement | undefined => byId.get(plan.converted.get(globalIds[id] ?? "") ?? "");
  /** A link on an original element, as it should read on the imported side. */
  const twinRef = (ref: PortRef | undefined): PortRef | undefined => {
    const t = ref ? twin(ref.elementId) : undefined;
    return ref && t ? { elementId: t.id, port: ref.port } : undefined;
  };
  const original = Object.values(model.elements);
  return { twin, twinRef, fittings: ofKind(original, "run_fitting"), segments: ofKind(original, "run_segment") };
}

/** The model exported and read back: the plan, and each original element's imported twin (through its GlobalId). */
function roundTrip(model: ModelState) {
  const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const plan = importIfc(out.text, { model: empty(), ...PLAN, ...READ });
  return { ifc: out.text, globalIds: out.report.globalIds, plan, ...twins(model, out.report.globalIds, plan) };
}

const fittingLine = (plan: IfcImportPlan) => plan.report.classes.find((c) => c.classId === "mep.run_fitting");
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const joinNotes = (plan: IfcImportPlan) => plan.report.notes.filter((n) => /joins? in the file/.test(n));

/** Every join among the records is on both records: a link points at a record that points back, a branch fitting is listed by the run it sits on. Returns how many link ends there are. */
function expectLinksMutual(records: readonly BimElement[]) {
  const byId = new Map(records.map((r) => [r.id as string, r]));
  const linkAt = (ref: PortRef): PortRef | undefined => {
    const el = byId.get(ref.elementId);
    if (el?.kind === "run_segment") return ref.port === "start" ? el.links.start : ref.port === "end" ? el.links.end : undefined;
    if (el?.kind === "run_fitting") return el.ports.find((p) => p.id === ref.port)?.link;
    return undefined;
  };
  let seen = 0;
  for (const r of records) {
    const mine: Array<readonly [string, PortRef | undefined]> = r.kind === "run_segment" ? [["start", r.links.start], ["end", r.links.end]] : r.kind === "run_fitting" ? r.ports.map((p) => [p.id, p.link] as const) : [];
    for (const [port, link] of mine) {
      if (!link) continue;
      seen += 1;
      expect(linkAt(link)).toEqual({ elementId: r.id, port });
    }
    if (r.kind === "run_fitting" && r.host) {
      const host = byId.get(r.host.segmentId);
      expect(host?.kind === "run_segment" && host.branches.includes(r.id)).toBe(true);
    }
    if (r.kind === "run_segment") {
      for (const id of r.branches) {
        const b = byId.get(id);
        expect(b?.kind === "run_fitting" ? b.host?.segmentId : null).toBe(r.id);
      }
    }
  }
  return seen;
}

/** No chunk holds one side of a join without the other, so every revision an import commits is whole. */
function expectChunksWhole(records: readonly BimElement[], size?: number) {
  const chunks = importChunks(records, size);
  expect(chunks.flat().map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort());
  for (const chunk of chunks) {
    const here = new Set(chunk.map((r) => r.id as string));
    for (const r of chunk) {
      const far = r.kind === "run_segment" ? [r.links.start?.elementId, r.links.end?.elementId, ...r.branches] : r.kind === "run_fitting" ? [...r.ports.map((p) => p.link?.elementId), r.host?.segmentId] : [];
      for (const id of far) if (id) expect(here.has(id)).toBe(true);
    }
  }
  return chunks;
}

function runIssues(model: ModelState) {
  const runIds = new Set(Object.values(model.elements).filter((e) => e.kind === "run_fitting" || e.kind === "run_segment").map((e) => e.id as string));
  return validateModel(model).filter((i) => i.elementIds.some((id) => runIds.has(id)));
}

/** rooftop-unit with a transition and cap on the supply, the return carried straight on, and a round tap off the return's side. */
async function withBranch() {
  const log = await build(rooftopUnit);
  const open = (name: string): RunSegment => {
    const system = Object.values(log.head.elements).find((e) => e.kind === "mep_system" && e.name === name);
    const seg = ofKind(Object.values(log.head.elements), "run_segment").find((s) => s.systemId === system?.id && !s.links.end);
    if (!seg) throw new Error(`no open end on ${name}`);
    return seg;
  };
  const supply = open("Supply air");
  const ret = open("Return air");
  const sa = log.head.elements[supply.systemId];
  const ra = log.head.elements[ret.systemId];
  if (sa?.kind !== "mep_system" || ra?.kind !== "mep_system") throw new Error("no systems");
  log.ok({ type: "route_run", idPrefix: "narrow", levelId: supply.levelId, domain: "duct", size: { shape: "rect", width: 609.6, height: 305 }, system: { id: sa.id, kind: sa.systemKind }, from: { kind: "run_end", elementId: supply.id, port: "end" }, points: [{ x: supply.end.x - 6 * FT, y: supply.end.y }], capEnd: true });
  log.ok({ type: "route_run", idPrefix: "on", levelId: ret.levelId, domain: "duct", size: ret.size, system: { id: ra.id, kind: ra.systemKind }, from: { kind: "run_end", elementId: ret.id, port: "end" }, points: [{ x: ret.end.x + 6 * FT, y: ret.end.y }] });
  const tapX = ret.start.x + 8 * FT;
  log.ok({ type: "route_run", idPrefix: "branch", levelId: ret.levelId, domain: "duct", size: { shape: "round", diameter: 254 }, system: { id: ra.id, kind: ra.systemKind }, from: { kind: "run_branch", segmentId: ret.id }, points: [{ x: tapX, y: ret.start.y }, { x: tapX, y: ret.start.y + 8 * FT }] });
  const model = log.head;
  const fittings = ofKind(Object.values(model.elements), "run_fitting");
  const transition = fittings.find((f) => f.fittingType === "transition");
  const cap = fittings.find((f) => f.fittingType === "cap");
  const tap = fittings.find((f) => f.host !== undefined);
  if (!transition || !cap || !tap) throw new Error(`fixture: ${fittings.map((f) => f.fittingType).join(", ")}`);
  const trunk = model.elements[ret.id];
  const level = model.elements[tap.levelId];
  if (trunk?.kind !== "run_segment" || level?.kind !== "level") throw new Error("fixture: trunk");
  /** Where the tap sits on the trunk's centre line, from the model's zero. */
  const onTrunk = { x: tap.position.x, y: tap.position.y, z: tap.position.z + level.elevationMm };
  return { model, transition, cap, tap, trunk, onTrunk };
}

const NO_PLACE = "it branches off the side of a run, and the file doesn't say where on that run";

describe("importIfc: run fittings and the joins through them (#59, #66)", () => {
  it("brings rooftop-unit's elbows back as fittings joined to the duct on both sides", async () => {
    const model = (await build(rooftopUnit)).head;
    const { ifc, plan, twin, twinRef, fittings, segments } = roundTrip(model);
    expect(fittings).toHaveLength(2);
    expect(segments).toHaveLength(4);
    expect(ifc.match(/IFCRELCONNECTSPORTS\(/g)).toHaveLength(6);

    // Both elbows convert; nothing about them stays behind.
    expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 2, linked: [] });
    expect(plan.report.summary).toMatch(/2 fittings/);

    for (const f of fittings) {
      const back = twin(f.id);
      if (back?.kind !== "run_fitting") throw new Error(`${f.id} did not come back as a fitting`);
      expect(back.fittingType).toBe("elbow");
      expect(back.label).toBe(f.label);
      expect(back.angleDeg).toBe(90);
      expect(back.domain).toBe("duct");
      expect(back.position).toEqual(f.position);
      expect(back.provenance).toEqual({ ifcGlobalId: expect.any(String), source: "rt" });
      // In the system its duct is in, on the level it sits on.
      const joined = twin(f.ports[0]?.link?.elementId ?? "");
      expect(joined?.kind === "run_segment" ? joined.systemId : "?").toBe(back.systemId);
      const system = plan.records.find((r) => r.id === back.systemId);
      const was = model.elements[f.systemId];
      expect(system?.kind === "mep_system" ? [system.name, system.systemKind] : null).toEqual(was?.kind === "mep_system" ? [was.name, was.systemKind] : undefined);
      expect(plan.records.find((r) => r.id === back.levelId)?.kind).toBe("level");
      // Each opening: where it is, which way it faces, its size, and the piece it joins.
      expect(back.ports.map((p) => p.id)).toEqual(f.ports.map((p) => p.id));
      for (const port of f.ports) {
        const p = back.ports.find((x) => x.id === port.id);
        expect(p?.position).toEqual(port.position);
        expect(near(p?.direction ?? { x: NaN, y: NaN, z: NaN }, port.direction)).toBeLessThan(1e-9);
        expect(p?.size).toEqual(port.size);
        expect(p?.link).toEqual(twinRef(port.link));
        expect(p?.link).toBeDefined();
      }
    }

    // Of the file's six joins, the four between duct and elbow are on both records. The two onto the rooftop unit wait for a part's connection points (#65), and the report says so.
    for (const s of segments) {
      const back = twin(s.id);
      if (back?.kind !== "run_segment") throw new Error(`${s.id} did not come back as a run segment`);
      for (const end of ["start", "end"] as const) {
        const link = s.links[end];
        const onFitting = link !== undefined && model.elements[link.elementId]?.kind === "run_fitting";
        expect(back.links[end]).toEqual(onFitting ? twinRef(link) : undefined);
      }
    }
    expect(expectLinksMutual(plan.records)).toBe(8);
    expect(joinNotes(plan)).toEqual(["2 joins in the file weren't made (one side is a part, and a part's connection points aren't brought in yet); the ends there are open, so join them by hand"]);
  });

  it("lands in a model whose checks find the runs joined, whole at every revision, at the usual chunk size and at 3", async () => {
    const model = (await build(rooftopUnit)).head;
    const { plan } = roundTrip(model);
    const landed = landImport(empty(), plan.records);
    expect(landed.dropped).toEqual([]);
    expect(ofKind(Object.values(landed.model.elements), "run_fitting")).toHaveLength(2);
    expect(expectLinksMutual(Object.values(landed.model.elements))).toBe(8);
    expect(runIssues(landed.model)).toEqual([]);
    expectChunksWhole(plan.records);

    // A join is two records; cut every 3 records, the plan would split pairs, so joined pieces land together (a run of 3 joined pieces is one chunk).
    const chunks = expectChunksWhole(plan.records, 3);
    expect(chunks.length).toBeGreaterThan(2);
    const small = landImport(empty(), plan.records, { size: 3 });
    expect(small.dropped).toEqual([]);
    expect(small.revisions).toBe(chunks.length);
    expect(expectLinksMutual(Object.values(small.model.elements))).toBe(8);
    expect(runIssues(small.model)).toEqual([]);
  });

  it("brings back a transition, an end cap and a straight join; a branch fitting written without its place on the trunk stays linked with the reason", async () => {
    const { model, transition, cap, tap, trunk } = await withBranch();
    const { plan, twin, twinRef } = roundTrip(model);

    // Today's writer joins the tap to its branch only, so the file doesn't say where on the trunk it sits.
    expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 4, linked: [{ reason: NO_PLACE, count: 1 }] });

    for (const f of [transition, cap]) {
      const back = twin(f.id);
      if (back?.kind !== "run_fitting") throw new Error(`${f.fittingType} did not come back as a fitting`);
      expect(back.fittingType).toBe(f.fittingType);
      expect(back.label).toBe(f.label);
      expect(back.position).toEqual(f.position);
      expect(back.ports).toHaveLength(f.ports.length);
      for (const port of f.ports) {
        const p = back.ports.find((x) => x.id === port.id);
        expect(near(p?.direction ?? { x: NaN, y: NaN, z: NaN }, port.direction)).toBeLessThan(1e-9);
        expect(p?.size).toEqual(port.size);
        expect(p?.link).toEqual(twinRef(port.link));
        expect(p?.link).toBeDefined();
      }
    }
    // The two trunk pieces joined end to end are joined again, each to the other.
    const back = twin(trunk.id);
    const on = twin("on-s1");
    if (back?.kind !== "run_segment" || on?.kind !== "run_segment") throw new Error("the return trunk did not come back");
    expect(trunk.links.end).toEqual({ elementId: "on-s1", port: "start" });
    expect(back.links.end).toEqual({ elementId: on.id, port: "start" });
    expect(on.links.start).toEqual({ elementId: back.id, port: "end" });
    // The branch's own duct came in; its end on the tap is open, the trunk lists no branch, and the report says a join was left out.
    expect(twin(tap.id)).toBeUndefined();
    const branch = twin(tap.ports[0]?.link?.elementId ?? "");
    expect(branch?.kind === "run_segment" ? branch.links.start : "?").toBeUndefined();
    expect(back.branches).toEqual([]);
    expect(joinNotes(plan)).toContain("1 join in the file wasn't made (one side stayed on the linked model); the end that came in is open there");
    expectLinksMutual(plan.records);

    for (const size of [undefined, 3]) {
      expectChunksWhole(plan.records, size);
      const landed = landImport(empty(), plan.records, size ? { size } : {});
      expect(landed.dropped).toEqual([]);
      expect(runIssues(landed.model)).toEqual([]);
    }
  });

  describe("a branch fitting whose place on its trunk the file states (a connection point on the trunk, joined to the fitting)", () => {
    function expectTapBack(model: ModelState, tap: RunFitting, trunk: RunSegment, plan: IfcImportPlan, t: ReturnType<typeof twins>) {
      expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 5, linked: [] });
      const back = t.twin(tap.id);
      const host = t.twin(trunk.id);
      if (back?.kind !== "run_fitting" || host?.kind !== "run_segment") throw new Error("the tap or its trunk did not come back");
      expect(back.fittingType).toBe(tap.fittingType);
      expect(back.label).toBe(tap.label);
      // On the trunk the file names, as far along it as the trunk's connection point is, leaving from the same side.
      expect(back.host).toEqual({ ...tap.host, segmentId: host.id });
      expect(back.position).toEqual(tap.position);
      expect(back.levelId).toBe(host.levelId);
      expect(back.systemId).toBe(host.systemId);
      expect(host.branches).toEqual([back.id]);
      const [was] = tap.ports;
      const [port] = back.ports;
      if (!was || !port) throw new Error("fixture: the tap's branch");
      expect(back.ports).toHaveLength(1);
      expect(port.id).toBe(was.id);
      expect(port.position).toEqual(was.position);
      expect(near(port.direction, was.direction)).toBeLessThan(1e-9);
      expect(port.size).toEqual(was.size);
      expect(port.link).toEqual(t.twinRef(was.link));
      const branch = t.twin(was.link?.elementId ?? "");
      expect(branch?.kind === "run_segment" ? branch.links.start : null).toEqual({ elementId: back.id, port: port.id });
      // Every join in the file between two runs is made; only the rooftop unit's two are left.
      expect(joinNotes(plan)).toEqual(["2 joins in the file weren't made (one side is a part, and a part's connection points aren't brought in yet); the ends there are open, so join them by hand"]);
      expectLinksMutual(plan.records);
      for (const size of [undefined, 3]) {
        expectChunksWhole(plan.records, size);
        const landed = landImport(empty(), plan.records, size ? { size } : {});
        expect(landed.dropped).toEqual([]);
        expect(runIssues(landed.model)).toEqual([]);
        expect(Object.keys(landed.model.elements)).toHaveLength(plan.records.length);
      }
      expect(model.elements[tap.id]).toBe(tap);
    }

    it("comes back on that trunk at that distance, from a hand-written connection point in the STEP text", async () => {
      const { model, tap, trunk, onTrunk } = await withBranch();
      const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
      const file = readStep(out.text);
      const byGuid = (guid: string | undefined) => [...file.entities.values()].find((e) => e.args[0]?.kind === "string" && e.args[0].value === guid);
      const trunkEntity = byGuid(out.report.globalIds[trunk.id]);
      const tapEntity = byGuid(out.report.globalIds[tap.id]);
      const nest = [...file.entities.values()].find((e) => e.type === "IFCRELNESTS" && e.args[4]?.kind === "ref" && e.args[4].id === tapEntity?.id);
      const ports = nest?.args[5];
      const tapPort = ports?.kind === "list" && ports.items[0]?.kind === "ref" ? ports.items[0].id : undefined;
      if (!trunkEntity || !tapEntity || tapPort === undefined) throw new Error("fixture: the trunk, the tap and its port in the file");
      const n = Math.max(...file.entities.keys());
      // What the agreed convention adds: a port nested on the trunk segment at the branch point, joined to the fitting's port.
      const added = [
        `#${n + 1}=IFCCARTESIANPOINT((${onTrunk.x},${onTrunk.y},${onTrunk.z}));`,
        `#${n + 2}=IFCAXIS2PLACEMENT3D(#${n + 1},$,$);`,
        `#${n + 3}=IFCLOCALPLACEMENT($,#${n + 2});`,
        `#${n + 4}=IFCDISTRIBUTIONPORT('0000000000000000000T01',$,'Branch 1',$,$,#${n + 3},$,.NOTDEFINED.,.DUCT.,$);`,
        `#${n + 5}=IFCRELNESTS('0000000000000000000T02',$,$,$,#${trunkEntity.id},(#${n + 4}));`,
        `#${n + 6}=IFCRELCONNECTSPORTS('0000000000000000000T03',$,$,$,#${n + 4},#${tapPort},$);`,
      ];
      const at = out.text.lastIndexOf("ENDSEC;");
      const text = `${out.text.slice(0, at)}${added.join("\n")}\n${out.text.slice(at)}`;
      const plan = importIfc(text, { model: empty(), ...PLAN, ...READ });
      expectTapBack(model, tap, trunk, plan, twins(model, out.report.globalIds, plan));
    });

    it("comes back the same from a source built directly, with the point on the trunk's face instead of its centre line", async () => {
      const { model, tap, trunk } = await withBranch();
      const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
      const read = readIfcSource(out.text, READ);
      const tapId = out.report.globalIds[tap.id];
      const tapPort = read.products.find((p) => p.sourceId === tapId)?.ports[0];
      if (!tapPort?.position) throw new Error("fixture: the tap's port");
      const source: ImportSource = {
        ...read,
        products: read.products.map((p) =>
          p.sourceId === tapId
            ? { ...p, ports: p.ports.map((port) => ({ ...port, connectedTo: [...port.connectedTo, "trunk-point"] })) }
            : p.sourceId === out.report.globalIds[trunk.id]
              ? { ...p, ports: [...p.ports, { id: "trunk-point", name: null, position: tapPort.position, flow: null, connectedTo: [tapPort.id] }] }
              : p,
        ),
      };
      const plan = planIfcImport(source, { model: empty(), ...PLAN });
      expectTapBack(model, tap, trunk, plan, twins(model, out.report.globalIds, plan));
    });
  });

  it("joins a file from another tool: ports and port joins, no MutinyBIM property sets", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const duct = (name: string, at: readonly [number, number, number], along: "x" | "y", length: number) =>
      t.product("Level 1", "IFCDUCTSEGMENT", name, at, t.body([t.extrude(t.rect(400, 300), length, t.axis3([0, 0, 0], along === "x" ? [1, 0, 0] : [0, 1, 0], along === "x" ? [0, 1, 0] : [1, 0, 0]))]), ".RIGIDSEGMENT.");
    const a = duct("A", [0, 0, 3000], "x", 3000);
    const b = duct("B", [3000, 0, 3000], "y", 3000);
    const c = duct("C", [3000, 3000, 3000], "y", 3000);
    const bend = t.product("Level 1", "IFCDUCTFITTING", "Bend 1", [3000, 0, 3000], t.body([t.extrude(t.rect(400, 400), 300)]), ".BEND.");
    t.assign(t.system("Supply Air 1", "AIRCONDITIONING"), [a, b, c, bend]);
    let n = 0;
    const port = (owner: number, at: readonly [number, number, number]) => {
      const id = t.add("IFCDISTRIBUTIONPORT", `${t.guid()},$,'Port ${++n}',$,$,#${t.place(null, t.axis3(at))},$,.NOTDEFINED.,.DUCT.,$`);
      t.add("IFCRELNESTS", `${t.guid()},$,$,$,#${owner},(#${id})`);
      return id;
    };
    const join = (x: number, y: number) => t.add("IFCRELCONNECTSPORTS", `${t.guid()},$,$,$,#${x},#${y},$`);
    const corner = [3000, 0, 3000] as const;
    const mid = [3000, 3000, 3000] as const;
    join(port(a, corner), port(bend, corner));
    join(port(bend, corner), port(b, corner));
    // Two straight pieces joined end to end, with no fitting between them.
    join(port(b, mid), port(c, mid));
    const text = t.text();
    expect(text).not.toMatch(/MutinyBIM/);

    const plan = importIfc(text, { model: hostModel(), referenceId: "ref", sourceKey: "other", sourceId: "other", label: "Other tool", disciplines: ["mechanical"] });
    expect(plan.report.classes.map((l) => [l.classId, l.converted, l.linked])).toEqual([["mep.duct", 3, []], ["mep.run_fitting", 1, []]]);
    expect(joinNotes(plan)).toEqual([]);
    const [fitting] = ofKind([...plan.records], "run_fitting");
    const pieces = ofKind([...plan.records], "run_segment");
    const piece = (x: number, y: number) => pieces.find((s) => s.start.x === x && s.start.y === y);
    const [pa, pb, pc] = [piece(0, 0), piece(3000, 0), piece(3000, 3000)];
    if (!fitting || !pa || !pb || !pc) throw new Error("the pieces did not come in");
    expect(fitting).toMatchObject({ fittingType: "elbow", angleDeg: 90, label: "Bend 1", position: { x: 3000, y: 0, z: 3000 }, systemId: pa.systemId });
    // The file's port names aren't ids, so the openings are lettered in the file's order.
    expect(fitting.ports.map((p) => [p.id, p.link])).toEqual([["a", { elementId: pa.id, port: "end" }], ["b", { elementId: pb.id, port: "start" }]]);
    expect(pa.links).toEqual({ end: { elementId: fitting.id, port: "a" } });
    expect(pb.links).toEqual({ start: { elementId: fitting.id, port: "b" }, end: { elementId: pc.id, port: "start" } });
    expect(pc.links).toEqual({ start: { elementId: pb.id, port: "end" } });
    expect(expectLinksMutual(plan.records)).toBe(6);
    for (const size of [undefined, 3]) {
      expectChunksWhole(plan.records, size);
      const landed = landImport(hostModel(), plan.records, size ? { size } : {});
      expect(landed.dropped).toEqual([]);
      expect(runIssues(landed.model)).toEqual([]);
    }
  });

  describe("what can't convert stays linked, in plain words", () => {
    /** rooftop-unit as the reader sees it, with its products changed before planning. */
    async function planWith(change: (p: ImportProduct) => ImportProduct | null): Promise<{ plan: IfcImportPlan; source: ImportSource }> {
      const model = (await build(rooftopUnit)).head;
      const read = readIfcSource(exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP }).text, READ);
      const source: ImportSource = { ...read, products: read.products.flatMap((p) => change(p) ?? []) };
      return { plan: planIfcImport(source, { model: empty(), ...PLAN }), source };
    }

    it("a fitting on a run that stays linked stays linked too, and the run's other pieces still land with that end open", async () => {
      // The horizontal supply trunk comes in with a shape the run rule can't read.
      const { plan } = await planWith((p) => (p.entity === "IfcDuctSegment" && /Supply/.test(p.name ?? "") && (p.geometry.bounds?.max.x ?? 0) - (p.geometry.bounds?.min.x ?? 0) > 1000 ? { ...p, geometry: { ...p.geometry, extrusions: [], unread: "a mesh" } } : p));
      expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 1, linked: [{ reason: "something it joins stays on the linked model", count: 1 }] });
      expect(ofKind([...plan.records], "run_fitting")).toHaveLength(1);
      expect(expectLinksMutual(plan.records)).toBe(4);
      expect(joinNotes(plan)).toContain("1 join in the file wasn't made (one side stayed on the linked model); the end that came in is open there");
      expect(landImport(empty(), plan.records).dropped).toEqual([]);
    });

    it("a fitting the file joins to nothing stays linked", async () => {
      const { plan } = await planWith((p) => (p.entity === "IfcDuctFitting" ? { ...p, ports: p.ports.map((port) => ({ ...port, connectedTo: [] })) } : p));
      expect(fittingLine(plan)?.converted).toBe(0);
      expect(fittingLine(plan)?.linked).toEqual([{ reason: "the file doesn't say what its openings join", count: 2 }]);
      expect(expectLinksMutual(plan.records)).toBe(0);
    });

    it("a fitting written as a transition where its runs turn, or of a kind that isn't read yet, stays linked", async () => {
      const kinds = ["TRANSITION", "USERDEFINED"];
      const { plan } = await planWith((p) => (p.entity === "IfcDuctFitting" ? { ...p, predefinedType: kinds.pop() ?? null } : p));
      expect(fittingLine(plan)?.converted).toBe(0);
      expect((fittingLine(plan)?.linked ?? []).map((l) => l.reason).sort()).toEqual(["it is a kind of fitting that isn't read from the file yet", "it is written as a transition, but the runs it joins turn there"]);
      // Neither left a link on the runs it would have joined.
      expect(expectLinksMutual(plan.records)).toBe(0);
    });

    it("says so when the file joins two straight pieces where they turn, with no fitting between them", async () => {
      // No elbows in the file; the supply riser and trunk are joined to each other at the corner instead.
      const { plan, source } = await planWith((p) => (p.entity === "IfcDuctFitting" ? null : p));
      expect(fittingLine(plan)).toBeUndefined();
      const [a, b] = source.products.filter((p) => p.entity === "IfcDuctSegment" && /Supply/.test(p.name ?? ""));
      if (!a || !b) throw new Error("fixture: two supply pieces");
      const meet = a.ports.flatMap((pa) => b.ports.flatMap((pb) => (pa.position && pb.position && near(pa.position, pb.position) < 1 ? [[pa, pb] as const] : [])))[0];
      if (!meet) throw new Error("fixture: the pieces meet");
      const rejoined: ImportSource = {
        ...source,
        products: source.products.map((p) => (p === a || p === b ? { ...p, ports: p.ports.map((port) => (port === meet[0] ? { ...port, connectedTo: [meet[1].id] } : port === meet[1] ? { ...port, connectedTo: [meet[0].id] } : port)) } : p)),
      };
      const joined = planIfcImport(rejoined, { model: empty(), ...PLAN });
      expect(ofKind([...joined.records], "run_segment")).toHaveLength(4);
      expect(expectLinksMutual(joined.records)).toBe(0);
      expect(joinNotes(joined)).toContain("1 join in the file wasn't made (the file joins them where they turn, with no fitting between them); the ends there are open, so join them by hand");
    });
  });
});
