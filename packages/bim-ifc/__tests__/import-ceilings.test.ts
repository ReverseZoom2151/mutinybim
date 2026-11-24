/**
 * @jest-environment node
 *
 * importIfc brings a flat ceiling back as a ceiling (#59). exportIfc writes a
 * ceiling as its outline pushed up from its height; the kernel had no import
 * rule for the kind, so a reader said "Ceilings can't be edited here yet" and
 * left every one on the linked model. A ceiling's underside is now read as
 * its height above its level, and the holes in its outline come with it.
 * One whose shape isn't a single flat outline (a slope written by another
 * tool, a hole with a curved edge) stays linked, with the reason.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, landImport, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import smallOffice from "../../bim-script/examples/small-office";
import { IfcText, hostModel } from "./i9-fixtures";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";

/** Runs a script on an empty model and commits its edits through the kernel. */
async function build(def: ScriptDefinition): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:import-ceilings" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

const ofKind = <K extends BimElement["kind"]>(els: ModelState | readonly BimElement[], kind: K) =>
  ("elements" in els ? Object.values(els.elements) : els).filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);

/** The same model with one element replaced. */
const withElement = (model: ModelState, el: BimElement): ModelState => ({ ...model, elements: { ...model.elements, [el.id]: el } });

const emptyModel = (): ModelState => ({ modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });

/** exportIfc, then importIfc into an empty model; `of` finds the record a model element became. */
function roundTrip(model: ModelState) {
  const { text, report } = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const result = importIfc(text, { model: emptyModel(), referenceId: "ref", sourceKey: "rt", sourceId: "rt", label: "Round trip", disciplines: ["architecture"] });
  const byGuid = new Map<string, BimElement>();
  for (const r of result.records) if ("provenance" in r && r.provenance?.ifcGlobalId) byGuid.set(r.provenance.ifcGlobalId, r);
  return { ...result, of: (el: BimElement) => byGuid.get(report.globalIds[el.id] ?? "") };
}

const ceilingsLine = (report: ReturnType<typeof roundTrip>["report"]) => report.classes.find((c) => c.label === "Ceilings");

describe("importIfc: ceilings (#59)", () => {
  it("brings every small-office ceiling back with its outline and height, on its level", async () => {
    const model = await build(smallOffice);
    const ceilings = ofKind(model, "ceiling");
    expect(ceilings.length).toBeGreaterThan(0);
    const back = roundTrip(model);

    expect(ceilingsLine(back.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: ceilings.length, linked: [] });
    const levelNames = new Map(ofKind(model, "level").map((l) => [l.id, l.name]));
    const backLevels = new Map(ofKind(back.records, "level").map((l) => [l.id, l.name]));
    for (const stored of ceilings) {
      const got = back.of(stored);
      if (got?.kind !== "ceiling") throw new Error(`${stored.id} did not come back as a ceiling`);
      expect(got.outline).toEqual(stored.outline);
      expect(got.heightMm).toBe(stored.heightMm);
      expect(got.form).toBe("flat");
      expect(backLevels.get(got.levelId)).toBe(levelNames.get(stored.levelId));
      expect(got.provenance?.source).toBe("rt");
    }

    // The model takes them: nothing is dropped on landing.
    const landed = landImport(emptyModel(), back.records);
    expect(landed.dropped).toEqual([]);
    expect(ofKind(landed.model, "ceiling")).toHaveLength(ceilings.length);
  });

  it("measures the height from the ceiling's own level, not from the ground", () => {
    const t = IfcText.start();
    t.storey("Level 2", 3657.6);
    // A 4 m x 3 m board, 20 mm thick, 2743.2 mm above a storey that is itself 3657.6 mm up.
    const shape = t.body([t.extrude(t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), 20, t.axis3([0, 0, 2743.2]))]);
    t.product("Level 2", "IFCCOVERING", "Ceiling", [1000, 500, 0], shape, ".CEILING.");
    const plan = importIfc(t.text(), { model: hostModel([]), referenceId: "ref", sourceKey: "up", sourceId: "v1", label: "Upper floor", disciplines: ["architecture"] });

    const [got] = ofKind(plan.records, "ceiling");
    const [level] = ofKind(plan.records, "level");
    expect(ofKind(plan.records, "ceiling")).toHaveLength(1);
    expect(level?.elevationMm).toBeCloseTo(3657.6, 6);
    expect(got?.levelId).toBe(level?.id);
    expect(got?.heightMm).toBe(2743.2);
    expect(got?.outline).toEqual([{ x: 1000, y: 500 }, { x: 5000, y: 500 }, { x: 5000, y: 3500 }, { x: 1000, y: 3500 }]);
  });

  it("leaves a ceiling cut by an opening element on the linked model, and says why", () => {
    const build = (cut: boolean) => {
      const t = IfcText.start();
      t.storey("Level 1", 0);
      // A 4 m x 3 m board; the opening is a separate element joined to it, so the board's own outline has no hole.
      const board = t.product("Level 1", "IFCCOVERING", "Ceiling", [0, 0, 0], t.body([t.extrude(t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), 20, t.axis3([0, 0, 2700]))]), ".CEILING.");
      if (cut) {
        const hole = t.body([t.extrude(t.rect(1000, 1000), 20, t.axis3([0, 0, 2700]))]);
        const opening = t.add("IFCOPENINGELEMENT", `${t.guid()},$,'Opening',$,$,#${t.place(t.storeyPlacements.get("Level 1") ?? null, t.axis3([2000, 1500, 0]))},#${hole},$,.OPENING.`);
        t.add("IFCRELVOIDSELEMENT", `${t.guid()},$,$,$,#${board},#${opening}`);
      }
      return importIfc(t.text(), { model: hostModel(), referenceId: "ref", sourceKey: "cut", sourceId: "v1", label: "Other tool", disciplines: ["architecture"] });
    };

    const whole = build(false);
    expect(ofKind(whole.records, "ceiling")).toHaveLength(1);
    expect(ceilingsLine(whole.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: 1, linked: [] });

    const cut = build(true);
    expect(ofKind(cut.records, "ceiling")).toEqual([]);
    expect(ceilingsLine(cut.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: 0, linked: [{ reason: "it has openings cut through it, and those aren't read from the file yet", count: 1 }] });
  });

  it("brings a ceiling's holes back with it", async () => {
    const model = await build(smallOffice);
    const ceilings = ofKind(model, "ceiling");
    const [first] = ceilings;
    const [a] = first?.outline ?? [];
    if (!first || !a) throw new Error("small-office has no ceiling");
    const holes = [
      [{ x: a.x + 1000, y: a.y + 1000 }, { x: a.x + 2000, y: a.y + 1000 }, { x: a.x + 2000, y: a.y + 2000 }, { x: a.x + 1000, y: a.y + 2000 }],
      [{ x: a.x + 3000, y: a.y + 1000 }, { x: a.x + 3600, y: a.y + 1000 }, { x: a.x + 3300, y: a.y + 1800 }],
    ];
    const back = roundTrip(withElement(model, { ...first, holes }));

    expect(ceilingsLine(back.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: ceilings.length, linked: [] });
    const got = back.of(first);
    if (got?.kind !== "ceiling") throw new Error("the ceiling with holes did not come back as a ceiling");
    expect(got.outline).toEqual(first.outline);
    expect(got.holes).toEqual(holes);
    expect(got.heightMm).toBe(first.heightMm);
    // A ceiling without holes still has none, not an empty list.
    const plain = ceilings[1] ? back.of(ceilings[1]) : undefined;
    expect(plain?.kind === "ceiling" ? "holes" in plain : null).toBe(false);

    const landed = landImport(emptyModel(), back.records);
    expect(landed.dropped).toEqual([]);
    expect(ofKind(landed.model, "ceiling").find((c) => c.id === got.id)?.holes).toEqual(holes);
  });

  /** A 4 m x 3 m outline with one hole, as an `IfcArbitraryProfileDefWithVoids`; `arc` writes the hole with a curved edge. */
  const holedProfile = (t: IfcText, arc = false): number => {
    const line = (points: readonly (readonly [number, number])[]) => t.add("IFCPOLYLINE", `(${[...points, points[0] ?? [0, 0]].map(([x, y]) => `#${t.pt(x, y)}`).join(",")})`);
    const outer = line([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]);
    const corners: readonly (readonly [number, number])[] = [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]];
    const inner = arc
      ? t.add("IFCINDEXEDPOLYCURVE", `#${t.add("IFCCARTESIANPOINTLIST2D", `(${corners.map(([x, y]) => `(${x}.,${y}.)`).join(",")}),$`)},(IFCLINEINDEX((1,2)),IFCARCINDEX((2,3,4)),IFCLINEINDEX((4,1))),$`)
      : line(corners);
    return t.add("IFCARBITRARYPROFILEDEFWITHVOIDS", `.AREA.,$,#${outer},(#${inner})`);
  };
  const from = (t: IfcText) => importIfc(t.text(), { model: hostModel(), referenceId: "ref", sourceKey: "holes", sourceId: "v1", label: "Other tool", disciplines: ["architecture"] });

  it("leaves a ceiling on the linked model when a hole has a curved edge, and says why", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    t.product("Level 1", "IFCCOVERING", "Ceiling", [0, 0, 0], t.body([t.extrude(holedProfile(t, true), 20, t.axis3([0, 0, 2700]))]), ".CEILING.");
    const plan = from(t);
    expect(ofKind(plan.records, "ceiling")).toEqual([]);
    expect(ceilingsLine(plan.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: 0, linked: [{ reason: "its shape is an outline with holes", count: 1 }] });
  });

  it("still leaves a floor with a hole on the linked model: only a ceiling takes holes", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    t.product("Level 1", "IFCSLAB", "Floor", [0, 0, -250], t.body([t.extrude(holedProfile(t), 250)]), ".FLOOR.");
    t.product("Level 1", "IFCCOVERING", "Ceiling", [0, 0, 0], t.body([t.extrude(holedProfile(t), 20, t.axis3([0, 0, 2700]))]), ".CEILING.");
    const plan = from(t);
    expect(ofKind(plan.records, "slab")).toEqual([]);
    expect(plan.report.classes.flatMap((c) => c.linked.map((l) => l.reason))).toEqual(["its shape is an outline with holes"]);
    const [ceiling] = ofKind(plan.records, "ceiling");
    expect(ceiling?.holes).toEqual([[{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 2000 }, { x: 1000, y: 2000 }]]);
  });
});
