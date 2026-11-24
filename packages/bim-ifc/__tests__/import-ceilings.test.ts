/**
 * @jest-environment node
 *
 * importIfc brings a flat ceiling back as a ceiling (#59). exportIfc writes a
 * ceiling as its outline pushed up from its height; the kernel had no import
 * rule for the kind, so a reader said "Ceilings can't be edited here yet" and
 * left every one on the linked model. A ceiling's underside is now read as
 * its height above its level. One whose shape isn't a single flat outline
 * (holes, a slope written by another tool, a hollow, rolled or round
 * section) stays linked, with the reason, and so does one the ceiling
 * commands would refuse (at or below its level's floor, too many corners).
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, landImport, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc, readIfcSource } from "../src";
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

  /** One ceiling board, 20 mm thick with its underside `z` above the storey, drawn from `profile`. */
  const board = (t: IfcText, profile: number, z = 2700): number => t.product("Level 1", "IFCCOVERING", "Ceiling", [0, 0, 0], t.body([t.extrude(profile, 20, t.axis3([0, 0, z]))]), ".CEILING.");
  const read = (t: IfcText, disciplines: readonly string[] = ["architecture"]) => importIfc(t.text(), { model: hostModel(), referenceId: "ref", sourceKey: "f", sourceId: "v1", label: "Other tool", disciplines: [...disciplines] });
  const linked = (reason: string) => ({ classId: "arch.ceiling", label: "Ceilings", converted: 0, linked: [{ reason, count: 1 }] });

  it("takes a plain rectangle section as the outline it is", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    board(t, t.rect(4000, 3000, [2000, 1500]));
    const plan = read(t);
    expect(ofKind(plan.records, "ceiling").map((c) => c.outline)).toEqual([[{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }]]);
  });

  it.each([
    ["a hollow rectangle", (t: IfcText) => t.add("IFCRECTANGLEHOLLOWPROFILEDEF", `.AREA.,$,#${t.axis2([2000, 1500])},4000.,3000.,500.,$,$`), "its shape is a hollow or rolled section, and only the outside edge of those is read from the file"],
    ["a hollow circle", (t: IfcText) => t.add("IFCCIRCLEHOLLOWPROFILEDEF", `.AREA.,$,#${t.axis2([2000, 2000])},2000.,500.`), "its outline is a circle, and a ceiling here has straight edges"],
    ["a rounded rectangle", (t: IfcText) => t.add("IFCROUNDEDRECTANGLEPROFILEDEF", `.AREA.,$,#${t.axis2([2000, 1500])},4000.,3000.,400.`), "its shape is a hollow or rolled section, and only the outside edge of those is read from the file"],
    ["a rolled I section", (t: IfcText) => t.add("IFCISHAPEPROFILEDEF", `.AREA.,$,#${t.axis2([2000, 1500])},4000.,3000.,100.,150.,$,$,$`), "its shape is a hollow or rolled section, and only the outside edge of those is read from the file"],
    ["a circle", (t: IfcText) => t.circle(2000), "its outline is a circle, and a ceiling here has straight edges"],
  ] as const)("leaves a ceiling drawn from %s on the linked model, and says why", (_name, profile, reason) => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    board(t, profile(t));
    const plan = read(t);
    expect(ofKind(plan.records, "ceiling")).toEqual([]);
    expect(ceilingsLine(plan.report)).toEqual(linked(reason));
  });

  it("still reads a hollow section by its size where that is what the kind is: a column", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const hollow = t.add("IFCRECTANGLEHOLLOWPROFILEDEF", `.AREA.,$,#${t.axis2([0, 0])},300.,300.,12.,$,$`);
    t.product("Level 1", "IFCCOLUMN", "C1", [1000, 1000, 0], t.body([t.extrude(hollow, 3000)]), ".COLUMN.");
    const plan = read(t, ["architecture", "structure"]);
    expect(ofKind(plan.records, "column")).toHaveLength(1);
  });

  it.each([
    ["below its level's floor", -500, "it sits at or below the floor of its level, and a ceiling here is above it"],
    ["on its level's floor", 0, "it sits at or below the floor of its level, and a ceiling here is above it"],
    ["higher than a ceiling can be", 100_000.1, "it is more than 100 m above its level, higher than a ceiling here can be"],
  ] as const)("leaves a ceiling %s on the linked model: the ceiling commands would refuse it", (_name, z, reason) => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    board(t, t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), z);
    const plan = read(t);
    expect(ofKind(plan.records, "ceiling")).toEqual([]);
    expect(ceilingsLine(plan.report)).toEqual(linked(reason));
  });

  it("takes an outline of 2000 corners and leaves one of 2001 on the linked model", () => {
    const ring = (n: number): (readonly [number, number])[] => Array.from({ length: n }, (_, i) => [Math.round(20000 * Math.cos((2 * Math.PI * i) / n)), Math.round(20000 * Math.sin((2 * Math.PI * i) / n))] as const);
    const plan = (n: number) => {
      const t = IfcText.start();
      t.storey("Level 1", 0);
      board(t, t.polygon(ring(n)));
      return read(t);
    };
    const most = plan(2000);
    expect(ofKind(most.records, "ceiling").map((c) => c.outline.length)).toEqual([2000]);
    expect(landImport(hostModel(), most.records).dropped).toEqual([]);
    const over = plan(2001);
    expect(ofKind(over.records, "ceiling")).toEqual([]);
    expect(ceilingsLine(over.report)).toEqual(linked("its outline has 2001 corners, and a ceiling here takes 2000 at most"));
  });

  /** Whether the ceiling commands take the very ceiling the import made, and what they say when they don't. */
  const commandsTake = (plan: ReturnType<typeof read>): string => {
    const [c] = ofKind(plan.records, "ceiling");
    if (!c) return "left on the linked model";
    const made = new Log(landImport(hostModel(), plan.records).model).submit({ type: "create_ceiling", ceilings: [{ ceilingId: "again", levelId: c.levelId, outline: c.outline, ...(c.holes ? { holes: c.holes } : {}), heightMm: c.heightMm }] });
    return made.ok ? "a ceiling the commands make" : `imported, but create_ceiling refuses it: ${made.message}`;
  };

  it.each([
    ["crosses itself (a bow tie)", [[0, 0], [4000, 3000], [4000, 0], [0, 3000]], "its outline crosses itself"],
    ["has no area (three points in a line)", [[0, 0], [4000, 0], [8000, 0]], "its outline covers almost nothing (under 1 sq ft)"],
    ["is under a square foot", [[0, 0], [200, 0], [200, 300], [0, 300]], "its outline covers almost nothing (under 1 sq ft)"],
  ] as const)("leaves a ceiling whose outline %s on the linked model: the ceiling commands would refuse it", (_name, outer, reason) => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    board(t, t.polygon(outer));
    const plan = read(t);
    expect(commandsTake(plan)).toBe("left on the linked model");
    expect(ceilingsLine(plan.report)).toEqual(linked(reason));
  });

  it("takes a ceiling whose outline repeats a corner as the outline the ceiling commands keep", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    board(t, t.polygon([[0, 0], [4000, 0], [4000, 0], [4000, 3000], [0, 3000]]));
    const plan = read(t);
    expect(ofKind(plan.records, "ceiling").map((c) => c.outline)).toEqual([[{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }]]);
    expect(commandsTake(plan)).toBe("a ceiling the commands make");
  });

  it.each([
    ["FLOORING", 0, 15],
    ["ROOFING", 3000, 150],
    ["INSULATION", 2750, 100],
  ] as const)("doesn't take a covering whose type says %s (its own predefined type unset) as a ceiling", (typed, z, thick) => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const id = t.product("Level 1", "IFCCOVERING", `${typed} piece`, [0, 0, 100], t.body([t.extrude(t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), thick, t.axis3([0, 0, z]))]), "$");
    t.type("IFCCOVERINGTYPE", `${typed} type`, [id], typed);
    const plan = read(t);
    expect(ofKind(plan.records, "ceiling")).toEqual([]);
    expect(ceilingsLine(plan.report)).toBeUndefined();
  });

  it.each([
    ["unset", "$"],
    ["NOTDEFINED", ".NOTDEFINED."],
  ] as const)("takes a covering whose own predefined type is %s and whose type says CEILING as a ceiling", (_name, own) => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const id = t.product("Level 1", "IFCCOVERING", "Board", [0, 0, 0], t.body([t.extrude(t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), 20, t.axis3([0, 0, 2700]))]), own);
    t.type("IFCCOVERINGTYPE", "Board type", [id], "CEILING");
    const plan = read(t);
    expect(ofKind(plan.records, "ceiling")).toHaveLength(1);
    expect(ceilingsLine(plan.report)).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: 1, linked: [] });
  });

  it("keeps a covering's own predefined type over its type's", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const id = t.product("Level 1", "IFCCOVERING", "Board", [0, 0, 0], t.body([t.extrude(t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), 20, t.axis3([0, 0, 2700]))]), ".CEILING.");
    t.type("IFCCOVERINGTYPE", "Mislabelled type", [id], "FLOORING");
    expect(ofKind(read(t).records, "ceiling")).toHaveLength(1);
  });

  it("reads a kind named only on the type (USERDEFINED and its ElementType) as the product's own", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const id = t.product("Level 1", "IFCCOVERING", "Baffle", [0, 0, 0], t.body([t.extrude(t.polygon([[0, 0], [4000, 0], [4000, 3000], [0, 3000]]), 20, t.axis3([0, 0, 2700]))]), "$");
    const type = t.add("IFCCOVERINGTYPE", `${t.guid()},$,'Baffle type',$,$,$,$,$,'Acoustic baffle',.USERDEFINED.`);
    t.add("IFCRELDEFINESBYTYPE", `${t.guid()},$,$,$,(#${id}),#${type}`);
    const [product] = readIfcSource(t.text(), { sourceId: "v1", label: "Other tool", disciplines: ["architecture"] }).products;
    expect([product?.predefinedType, product?.objectType]).toEqual(["USERDEFINED", "Acoustic baffle"]);
    expect(ofKind(read(t).records, "ceiling")).toEqual([]);
  });
});
