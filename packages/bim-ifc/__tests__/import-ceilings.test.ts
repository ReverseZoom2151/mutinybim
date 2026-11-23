/**
 * @jest-environment node
 *
 * importIfc brings a flat ceiling back as a ceiling (#59). exportIfc writes a
 * ceiling as its outline pushed up from its height; the kernel had no import
 * rule for the kind, so a reader said "Ceilings can't be edited here yet" and
 * left every one on the linked model. A ceiling's underside is now read as
 * its height above its level. One whose shape isn't a single flat outline
 * (holes, a slope written by another tool) stays linked, with the reason.
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

  it("leaves a ceiling with holes on the linked model, and says why", async () => {
    const model = await build(smallOffice);
    const ceilings = ofKind(model, "ceiling");
    const [first] = ceilings;
    const [a] = first?.outline ?? [];
    if (!first || !a) throw new Error("small-office has no ceiling");
    const hole = [{ x: a.x + 1000, y: a.y + 1000 }, { x: a.x + 2000, y: a.y + 1000 }, { x: a.x + 2000, y: a.y + 2000 }, { x: a.x + 1000, y: a.y + 2000 }];
    const back = roundTrip(withElement(model, { ...first, holes: [hole] }));

    expect(back.of(first)).toBeUndefined();
    expect(ceilingsLine(back.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: ceilings.length - 1, linked: [{ reason: "its shape is an outline with holes", count: 1 }] });
  });
});
