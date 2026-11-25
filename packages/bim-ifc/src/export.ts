import {
  BUILDING_FALLBACK_CLASS_ID,
  DERIVED_ZONE_RULE_POINT,
  ZONE_PURPOSE_POINT,
  activeClassRegistry,
  activeServiceRegistry,
  classSolidsOf,
  gridAxisFamily,
  fieldProviderRegistry,
  hostLineOf,
  hostVoidsOf,
  ifcRelationRowsFor,
  spaceBoundaryFacts,
  withPackParameters,
  buildClassIndex,
  ceilingRole,
  ceilingSlope,
  columnVerticalSpan,
  wallBaseAtMm,
  fittingBody,
  fittingMesh,
  ifcOrganizationProperties,
  linkAdapterId,
  loadAnchorOf,
  localBounds,
  mountedPositions,
  organizationOf,
  parameterOfParamDef,
  partGeometryReady,
  partMesh,
  phaseStatusAt,
  placementOf,
  rawRegistryWords,
  resolveConnectors,
  resolveGeometry,
  siteMapConversion,
  siteOf,
  spaceAreaM2,
  spaceOutlines,
  trueNorthInPlan,
  typicalOfGroup,
  zoneBoundsOf,
  type BimElement,
  type GridLine,
  type Level,
  type LoadPointElement,
  type MepSystem,
  type ModelState,
  type ParamValue,
  type PartInstance,
  type PartTypeElement,
  type PortRef,
  type Registry,
  type RunSize,
  type ServiceLink,
  type ServiceRegistry,
  type ServiceRow,
  type Space,
  type Zone,
} from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { elementTypeOf, elementTypeValue } from "@permitzip/bim-kernel/elements";
import { LEGACY_QUANTITY_KEYS, QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { GeometryWriter, type Section, type Vec3 } from "./geometry";
import { derivedIfcGuid, isIfcGuid, isUuid, projectNamespace, relationshipIfcGuid, uuidToIfcGuid } from "./guid";
import { PROXY, primaryClass, resolveIfcClass, type ResolvedIfcClass } from "./mapping";
import { ParameterHomes, PropertyBag, baselineParameterHomes, registryParameterHomes, writeSets, type ParameterHome, type PropertyInput } from "./properties";
import { ownAttributes, predefinedTypes } from "./schema-ifc4x3";
import { $, bool, en, int, list, opt, real, str, serializeStep, StepGraph, StepValueError, type StepRef, type StepValue } from "./step";
import { UnitSet } from "./units";

/**
 * Kernel model → IFC 4.3 ADD2 (KERNEL-FOUNDATION §4.3).
 *
 * Everything trade-specific is read from registries: element entities from
 * the class registry, systems from the service registry, parameters from
 * the registry's fields and the baseline parameter sets, units from
 * bim-units. The exporter itself knows only kernel element kinds (where a
 * thing is, how big it is, what it hosts) and the IFC schema.
 *
 * Deterministic: elements are visited in id order, the file's time stamp is
 * the caller's, and every GlobalId is derived from stable ids, so the same
 * model and options give the same bytes.
 */

export const IFC_SCHEMA = "IFC4X3_ADD2";
export const BIM_IFC_VERSION = "0.1.0";

export interface IfcZoneHome {
  readonly entity: "IfcZone" | "IfcSpatialZone";
  /** IfcSpatialZoneTypeEnum member for spatial zones, or USERDEFINED. */
  readonly predefinedType?: string;
  readonly objectType?: string;
}

export interface IfcExportOptions {
  readonly model: ModelState;
  readonly project: { readonly id: string; readonly name: string; readonly number?: string; readonly description?: string };
  /** Classes and fields, layered with packs and the firm library. Absent: the kernel's classes plus the pack set in force. */
  readonly registry?: Registry;
  /** Absent: the built-in service rows plus the pack set in force. */
  readonly services?: ServiceRegistry;
  /** Extra parameter homes, before the registry's and the baseline sets'. */
  readonly parameterHomes?: readonly ParameterHome[];
  /** A zone purpose's IFC home when a pack or firm states one; absent or null: the built-in table, then USERDEFINED. */
  readonly zonePurposeIfc?: (purpose: string) => IfcZoneHome | null;
  /** ISO 8601. The writer never reads a clock. */
  readonly timeStamp: string;
  readonly fileName?: string;
  readonly author?: string;
  readonly organization?: string;
}

export interface IfcExportCounts {
  readonly storeys: number;
  /** Engineers' spaces and architects' rooms. */
  readonly spaces: number;
  readonly zones: number;
  readonly systems: number;
  readonly circuits: number;
  /** Building elements (not spaces, zones, systems or ports). */
  readonly elements: number;
  readonly planned: number;
  readonly ports: number;
  readonly types: number;
  readonly assemblies: number;
  readonly propertySets: number;
  readonly quantitySets: number;
}

export interface IfcExportReport {
  readonly schema: typeof IFC_SCHEMA;
  readonly counts: IfcExportCounts;
  /** Building elements by IFC entity. */
  readonly byEntity: Readonly<Record<string, number>>;
  /** Kernel records not written (drawings, views, definitions), by kind. */
  readonly skipped: Readonly<Record<string, number>>;
  /** Plain words: proxies and why, adjusted predefined types, duplicate imported ids. */
  readonly warnings: readonly string[];
  /** The GlobalId each exported model record got, by its id. */
  readonly globalIds: Readonly<Record<string, string>>;
}

export interface IfcExportResult {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly report: IfcExportReport;
}

/** Records that are drawings, definitions or settings, never IFC products. */
const NOT_EXPORTED_KINDS = new Set(["part_type", "element_type", "view", "sheet", "tag", "dimension", "viewport", "drawing_item", "drawing_underlay", "question", "service_catalog", "mounting_plane"]);
/** Records the exporter writes in their own way (spatial tree, groups, ports). */
const STRUCTURE_KINDS = new Set(["organization", "site", "level", "space", "room", "zone", "mep_system", "service_link", "load_point"]);

/** A ceiling's board, drawn up from its height: the thickness the 3D view draws (the kernel states none). */
const CEILING_BOARD_MM = 20;

/** A run's section as a swept profile: a rectangle for rect and oval duct, a circle for round duct, pipe and conduit. */
function sectionOf(s: RunSize): Section {
  return s.shape === "rect" || s.shape === "oval" ? { width: s.width, height: s.height } : s.shape === "round" ? { diameter: s.diameter } : s.shape === "pipe" ? { diameter: s.nominalMm } : { diameter: s.tradeSizeMm };
}

const ZONE_PURPOSE_SPATIAL: Readonly<Record<string, string>> = {
  thermal: "THERMAL",
  ventilation: "VENTILATION",
  fire_area: "FIRESAFETY",
  smoke: "FIRESAFETY",
  sprinkler_hazard: "FIRESAFETY",
  lighting_control: "LIGHTING",
  code_clearance: "RESERVATION",
};

const PHASE_STATUS: Readonly<Record<string, string>> = { new: "NEW", existing: "EXISTING", demolished: "DEMOLISH", temporary: "TEMPORARY" };
const PORT_DOMAIN: Readonly<Record<string, string>> = { duct: "DUCT", pipe: "PIPE", electrical: "CABLE", conduit: "CABLECARRIER" };
const FLOW_DIRECTION: Readonly<Record<string, string>> = { in: "SINK", out: "SOURCE", bidirectional: "SOURCEANDSINK" };

function push<V>(m: Map<string, V[]>, k: string, v: V): void {
  const items = m.get(k);
  if (items) items.push(v);
  else m.set(k, [v]);
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function str255(s: string): StepValue {
  return s === "" ? $ : str(s.length > 255 ? s.slice(0, 255) : s);
}

function stringField(el: BimElement, key: string): string | null {
  const v: unknown = Reflect.get(el, key);
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function zoneHomeOf(v: unknown): IfcZoneHome | null {
  if (typeof v !== "object" || v === null) return null;
  const entity: unknown = Reflect.get(v, "entity");
  if (entity !== "IfcZone" && entity !== "IfcSpatialZone") return null;
  const pt: unknown = Reflect.get(v, "predefinedType");
  const ot: unknown = Reflect.get(v, "objectType");
  return { entity, ...(typeof pt === "string" ? { predefinedType: pt } : {}), ...(typeof ot === "string" ? { objectType: ot } : {}) };
}

function finite(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numberField(el: BimElement, key: string): number | null {
  const v: unknown = Reflect.get(el, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The GlobalId an element was imported with (`provenance.ifcGlobalId`; levels: their storey's). */
function importedGlobalId(el: BimElement): string | null {
  const prov: unknown = Reflect.get(el, "provenance");
  const fromProv: unknown = typeof prov === "object" && prov !== null ? Reflect.get(prov, "ifcGlobalId") : undefined;
  if (isIfcGuid(fromProv)) return fromProv;
  if (el.kind === "level" && isIfcGuid(el.source?.storeyId)) return el.source.storeyId;
  return null;
}

/** What a record is called in a message: its kind in words and, when it has one, its mark, name, label or number. */
function recordWords(el: { readonly kind: string }): string {
  const entry: unknown = Reflect.get(el, "entry");
  const named: object = typeof entry === "object" && entry !== null ? entry : el;
  const type: unknown = named === el ? el.kind : Reflect.get(named, "type");
  const kind = typeof type === "string" && type !== "" ? type.replace(/_/g, " ") : "record";
  for (const key of ["mark", "name", "label", "number"]) {
    const v: unknown = Reflect.get(named, key);
    if (typeof v === "string" && v.trim() !== "") return `${kind} "${v.trim().slice(0, 80)}"`;
  }
  return kind;
}

/** Stored fields (three deep, the first three found) that hold no value or a number that isn't one: where to look first. */
function suspectFields(el: object): string[] {
  const found: string[] = [];
  const walk = (v: object, at: string, depth: number): void => {
    for (const [k, x] of Object.entries(v)) {
      if (found.length >= 3) return;
      const path = at ? `${at}.${k}` : k;
      if (x === null || x === undefined || (typeof x === "number" && !Number.isFinite(x))) found.push(path);
      else if (typeof x === "object" && depth < 2) walk(x, path, depth + 1);
    }
  };
  walk(el, "", 0);
  return found;
}

/** Why a record's writer failed, in plain words: its own reason, else what kind of value was missing, with the stored fields to look at first. */
function whyNotWritten(el: object, err: unknown): string {
  const suspects = suspectFields(el);
  const look = suspects.length > 0 ? ` (look first at ${suspects.map((f) => `"${f}"`).join(", ")}: no value, or not a number)` : "";
  if (err instanceof StepValueError) return `${err.wanted === "text" ? "a text it needs (a name, number or mark) is missing or is not text" : err.wanted === "enum" ? "a choice it stores is not one IFC has a word for" : "a number it needs is missing or is not a number"}${look}`;
  if (err instanceof TypeError || err instanceof RangeError) return `part of its stored record is missing or is not what the exporter expects there${look}`;
  return `the exporter could not write it (${err instanceof Error ? err.message : String(err)})`;
}

class Guids {
  private readonly used = new Set<string>();
  readonly byRecord: Record<string, string> = {};
  /** While one record is being written (`begin` to `keep` or `undo`): what it claimed, so a failed record gives it all back. */
  private readonly claimed: string[] = [];
  private readonly recorded: string[] = [];
  private open = false;
  constructor(
    readonly ns: string,
    private readonly warn: (s: string) => void,
  ) {}

  begin(): void {
    this.claimed.length = 0;
    this.recorded.length = 0;
    this.open = true;
  }

  keep(): void {
    this.open = false;
  }

  undo(): void {
    for (const guid of this.claimed) this.used.delete(guid);
    for (const id of this.recorded) delete this.byRecord[id];
    this.open = false;
  }

  private claim(guid: string, what: string): string {
    if (this.used.has(guid)) throw new Error(`IFC export made the GlobalId ${guid} twice (${what})`);
    this.used.add(guid);
    if (this.open) this.claimed.push(guid);
    return guid;
  }

  derived(name: string): string {
    return this.claim(derivedIfcGuid(this.ns, name), name);
  }

  rel(type: string, ends: readonly string[]): string {
    return this.claim(relationshipIfcGuid(this.ns, type, ends), `${type} ${ends.join(",")}`);
  }

  /** Imported id, else the UUID id compressed, else derived from the id. */
  record(el: BimElement): string {
    const imported = importedGlobalId(el);
    let guid: string;
    if (imported && !this.used.has(imported)) guid = this.claim(imported, el.id);
    else {
      if (imported) this.warn(`${el.id} was imported with GlobalId ${imported}, which another record already has; it gets a new one`);
      const compressed = isUuid(el.id) ? uuidToIfcGuid(el.id) : null;
      guid = compressed && !this.used.has(compressed) ? this.claim(compressed, el.id) : this.derived(`element:${el.id}`);
    }
    this.byRecord[el.id] = guid;
    if (this.open) this.recorded.push(el.id);
    return guid;
  }
}

interface Product {
  readonly ref: StepRef;
  readonly guid: string;
  /** Its own placement, for ports and children. Null when planned. */
  readonly placement: StepRef | null;
  /** The class it was counted under as missing from the registry, when it was. */
  readonly missingClass: string | null;
}

/** Export a model to IFC 4.3 ADD2 STEP text. Throws only on a writer defect; anything odd in the model is a warning in the report. */
export function exportIfc(opts: IfcExportOptions): IfcExportResult {
  const { model } = opts;
  const registry = opts.registry ?? activeClassRegistry();
  const fields = opts.registry ?? fieldProviderRegistry();
  const services = opts.services ?? activeServiceRegistry();
  const derivedRules = new Map(activePackSet().items(DERIVED_ZONE_RULE_POINT).map((r) => [r.id, r]));
  // A zone purpose row may state its IFC home (`ifc`, read tolerantly: the purpose point's v1 shape has no such field yet).
  const purposeHomes = new Map<string, IfcZoneHome>();
  for (const p of activePackSet().items(ZONE_PURPOSE_POINT)) {
    const home = zoneHomeOf(Reflect.get(p, "ifc"));
    if (home) purposeHomes.set(p.id, home);
  }
  const parameterRegistry = withPackParameters(registry);
  const homes = new ParameterHomes([...(opts.parameterHomes ?? []), ...registryParameterHomes(parameterRegistry), ...baselineParameterHomes()]);
  const parameterUnits = new Map<string, string>();
  for (const cls of parameterRegistry.listClasses({ includeAbstract: true })) {
    for (const field of parameterRegistry.fieldsFor(cls.id)) {
      if (!field.storedUnit) continue;
      for (const key of [field.key ?? field.path, field.path, ...(field.aliases ?? [])]) {
        if (!parameterUnits.has(key)) parameterUnits.set(key, field.storedUnit);
      }
    }
  }
  const warnings: string[] = [];
  const missingProxyClasses = new Map<string, number>();
  const warn = (s: string) => warnings.push(s);
  const ns = projectNamespace(opts.project.id);
  const guids = new Guids(ns, warn);
  const g = new StepGraph();
  const units = new UnitSet();
  let index: ReturnType<typeof buildClassIndex>;
  try {
    index = buildClassIndex(registry, model);
  } catch (err) {
    // The kernel's class pass reads every part's type, so one stored part type with no definition stops it for the
    // whole model. Classes are then read without those part types; their parts say why they are left out below.
    const sound: Record<string, BimElement> = {};
    const broken: string[] = [];
    for (const el of Object.values(model.elements)) {
      const definition: unknown = el.kind === "part_type" ? el.definition : undefined;
      if (el.kind === "part_type" && (typeof definition !== "object" || definition === null)) broken.push(el.id);
      else sound[el.id] = el;
    }
    if (broken.length === 0) throw err;
    console.error("[bim-ifc] the class index could not be built with every part type; built without the part types that have no definition", { partTypeIds: broken.slice(0, 10), err });
    index = buildClassIndex(registry, { elements: sound });
    for (const id of broken.sort()) warn(`${id}: this part type has no definition stored, so parts of this type can't be written. Load the part type again, then export again.`);
  }
  const org = organizationOf(model);
  const lastPhase = Math.max(0, org.phases.length - 1);

  const elements: BimElement[] = Object.values(model.elements).sort(byId);
  const els = model.elements;
  const skipped: Record<string, number> = {};
  const byEntity: Record<string, number> = {};
  const counts = { storeys: 0, spaces: 0, zones: 0, systems: 0, circuits: 0, elements: 0, planned: 0, ports: 0, types: 0, assemblies: 0, propertySets: 0, quantitySets: 0 };

  // ---------------------------------------------------------------- one record at a time
  // A store can hold a record no command would write (an older file, a script, a peer on another release). Each
  // record's writer runs under `guarded`: when it throws, that record is left out and named in the report, and every
  // other record is still written.
  let guarding = false;
  let dropped = false;
  /** Records whose own writer failed: later passes (relationships, ports) skip them instead of reporting them again. */
  const leftOut = new Set<string>();
  const tallied: string[] = [];
  const tally = (entity: string) => {
    byEntity[entity] = (byEntity[entity] ?? 0) + 1;
    if (guarding) tallied.push(entity);
  };
  /**
   * Runs one record's writer, all or nothing. On a throw: the entities it had added are dropped from the graph (their
   * handles are never given out again), its GlobalIds, counts and warnings are taken back, the failure is logged and
   * the report says which record and why. False then; the caller takes back whatever the writer had put in a list of
   * its own. `what` reads after the record's name: "is" for the record itself, "has its ports" for a part of it.
   */
  const guarded = <T extends { readonly id: string; readonly kind: string }>(el: T, write: (el: T) => void, what = "is"): boolean => {
    const from = g.size;
    const warned = warnings.length;
    const before = { ...counts };
    tallied.length = 0;
    guarding = true;
    guids.begin();
    try {
      write(el);
      guids.keep();
      guarding = false;
      return true;
    } catch (err) {
      guarding = false;
      console.error(`[bim-ifc] a record's writer threw; the record ${what} left out of the file`, { elementId: el.id, kind: el.kind, err });
      g.dropFrom(from);
      guids.undo();
      warnings.length = warned;
      Object.assign(counts, before);
      for (const entity of tallied) {
        const n = (byEntity[entity] ?? 0) - 1;
        if (n > 0) byEntity[entity] = n;
        else delete byEntity[entity];
      }
      dropped = true;
      if (what === "is") leftOut.add(el.id);
      warn(`${el.id}: this ${recordWords(el)} ${what} left out of the file because ${whyNotWritten(el, err)}. Fix it in the model or draw it again, then export again.`);
      return false;
    }
  };

  // ---------------------------------------------------------------- project, contexts, site
  const projectHandle = g.reserve();
  const projectGuid = isUuid(opts.project.id) ? uuidToIfcGuid(opts.project.id) : guids.derived("project");
  const world = g.add("IFCAXIS2PLACEMENT3D", [g.add("IFCCARTESIANPOINT", [list([real(0), real(0), real(0)])]), $, $]);
  const site = siteOf(model);
  const statedNorth = trueNorthInPlan(site);
  const northKnown = Number.isFinite(statedNorth.x) && Number.isFinite(statedNorth.y);
  const north = northKnown ? statedNorth : { x: 0, y: 1 };
  const context = g.add("IFCGEOMETRICREPRESENTATIONCONTEXT", [$, str("Model"), { int: 3 }, real(1e-5), world, g.add("IFCDIRECTION", [list([real(north.x), real(north.y)])])]);
  const bodyContext = g.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", [str("Body"), str("Model"), { derived: true }, { derived: true }, { derived: true }, { derived: true }, context, $, en("MODEL_VIEW"), $]);
  const geo = new GeometryWriter(g, bodyContext);
  const siteRecord = els["site"];
  if (siteRecord?.kind === "site") {
    if (!northKnown) warn(`${siteRecord.id}: the site's true north is not a number, so the file is written with plan north as true north. Set true north again, then export again.`);
    guarded(
      siteRecord,
      () => {
        const mc = siteMapConversion(site);
        const metre = g.add("IFCSIUNIT", [{ derived: true }, en("LENGTHUNIT"), $, en("METRE")]);
        const crs = g.add("IFCPROJECTEDCRS", [str("MutinyBIM shared site"), str("The project's shared coordinates (survey point and true north as set in MutinyBIM)"), $, $, $, $, metre]);
        // Eastings and northings are in the CRS unit (metres); Scale takes the file's millimetres to metres.
        g.add("IFCMAPCONVERSION", [context, crs, real(mc.eastings), real(mc.northings), real(mc.orthogonalHeight), real(mc.xAxisAbscissa), real(mc.xAxisOrdinate), real(0.001)]);
      },
      "has its shared coordinates",
    );
  }

  const siteGuid = els["site"] ? guids.record(els["site"]) : guids.derived("site");
  const sitePlacement = geo.placement(null, geo.axis({ x: 0, y: 0, z: 0 }));
  const siteRef = g.add("IFCSITE", [str(siteGuid), $, str("Site"), $, $, sitePlacement, $, $, en("ELEMENT"), $, $, $, $, $]);
  const buildingGuid = guids.derived("building");
  const buildingPlacement = geo.placement(sitePlacement, geo.axis({ x: 0, y: 0, z: 0 }));
  const buildingName = [opts.project.number, opts.project.name].filter((s): s is string => !!s && s.trim() !== "").join(" ") || "Building";
  const buildingRef = g.add("IFCBUILDING", [str(buildingGuid), $, str255(buildingName), $, $, buildingPlacement, $, $, en("ELEMENT"), $, $, $]);
  const aggregate = (relating: StepRef, relatingGuid: string, related: readonly StepRef[]) => {
    if (related.length === 0) return;
    g.add("IFCRELAGGREGATES", [str(guids.rel("IfcRelAggregates", [relatingGuid])), $, $, $, relating, list(related)]);
  };
  aggregate(projectHandle, projectGuid, [siteRef]);
  aggregate(siteRef, siteGuid, [buildingRef]);

  // ---------------------------------------------------------------- storeys
  const levels = elements.filter((e): e is Level => e.kind === "level").sort((a, b) => a.elevationMm - b.elevationMm || byId(a, b));
  const storeys = new Map<string, { readonly ref: StepRef; readonly guid: string; readonly placement: StepRef }>();
  const levelByName = new Map<string, string>();
  const writeStorey = (lv: Level): void => {
    const guid = guids.record(lv);
    const placement = geo.placement(buildingPlacement, geo.axis({ x: 0, y: 0, z: lv.elevationMm }));
    const ref = g.add("IFCBUILDINGSTOREY", [str(guid), $, str255(lv.name), $, $, placement, $, $, en("ELEMENT"), real(lv.elevationMm)]);
    storeys.set(lv.id, { ref, guid, placement });
    if (!levelByName.has(lv.name)) levelByName.set(lv.name, lv.id);
    counts.storeys++;
  };
  // What stood on a level that is left out is written in the building instead.
  for (const lv of levels) guarded(lv, writeStorey);
  aggregate(buildingRef, buildingGuid, levels.map((l) => storeys.get(l.id)?.ref).filter((r): r is StepRef => !!r));

  const levelOf = (el: BimElement): string | null => {
    if (el.kind === "part" && el.planned) return el.planned.levelHint && storeys.has(el.planned.levelHint) ? el.planned.levelHint : null;
    const direct = stringField(el, "levelId");
    if (direct && storeys.has(direct)) return direct;
    const named = el.partition?.level;
    if (named) return storeys.has(named) ? named : (levelByName.get(named) ?? null);
    return null;
  };
  const frameOf = (levelId: string | null): StepRef => (levelId ? (storeys.get(levelId)?.placement ?? buildingPlacement) : buildingPlacement);

  const parameterValues = (bag: PropertyBag, values: Readonly<Record<string, ParamValue>>, fallbackSet?: string) => {
    for (const [key, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const input: PropertyInput = typeof value === "number" ? { kind: "number", name: key, value, unit: parameterUnits.get(key) } : typeof value === "boolean" ? { kind: "bool", name: key, value } : { kind: "text", name: key, value };
      bag.put(homes.find([key]), input, fallbackSet);
    }
  };

  // Properties attach after the object exists; collected here and written per object.
  const attachSets = (objectRef: StepRef, objectGuid: string, key: string, bag: PropertyBag) => {
    const element = els[key];
    // Parts and load points have their own value schemas and exporters.
    if (element && element.kind !== "part" && element.kind !== "load_point" && "values" in element && element.values) parameterValues(bag, element.values);
    if (bag.empty) return [];
    const written = writeSets(g, units, bag, (name) => guids.derived(`set:${key}:${name}`));
    for (const w of written) {
      const setGuid = derivedIfcGuid(ns, `set:${key}:${w.name}`);
      g.add("IFCRELDEFINESBYPROPERTIES", [str(guids.rel("IfcRelDefinesByProperties", [objectGuid, setGuid])), $, $, $, list([objectRef]), w.ref]);
    }
    counts.propertySets += bag.psets.size;
    counts.quantitySets += bag.qtos.size;
    return written;
  };
  const organizationSets = (bag: PropertyBag, el: BimElement) => {
    const props = ifcOrganizationProperties(model, el);
    if (!props) return;
    for (const [name, value] of Object.entries(props.propertySet.properties)) bag.set(props.propertySet.name, { kind: "text", name, value });
    const status = phaseStatusAt(org, el, lastPhase);
    const word = PHASE_STATUS[status];
    if (word) bag.set(props.propertySet.name, { kind: "text", name: "Status", value: word });
  };

  // ---------------------------------------------------------------- spaces and rooms
  const spaceRefs = new Map<string, { readonly ref: StepRef; readonly guid: string; readonly levelId: string | null }>();
  const storeyChildren = new Map<string | null, StepRef[]>();
  const pushChild = (levelId: string | null, ref: StepRef) => {
    const list0 = storeyChildren.get(levelId) ?? [];
    list0.push(ref);
    storeyChildren.set(levelId, list0);
  };
  const roomsInSpaces = new Map<string, string>();
  const spaces = elements.filter((e): e is Space => e.kind === "space");
  /** The rooms a space says it is made of; none when its bounds can't be read (its own writer then says so). */
  const roomIdsOf = (sp: Space): readonly string[] => {
    const bounds: unknown = sp.bounds;
    const ids: unknown = typeof bounds === "object" && bounds !== null && Reflect.get(bounds, "kind") === "rooms" ? Reflect.get(bounds, "roomIds") : null;
    return Array.isArray(ids) ? ids.filter((r): r is string => typeof r === "string") : [];
  };
  for (const sp of spaces) for (const r of roomIdsOf(sp)) if (!roomsInSpaces.has(r)) roomsInSpaces.set(r, sp.id);
  const writeRoom = (room: Extract<BimElement, { readonly kind: "room" }>): void => {
    const guid = guids.record(room);
    const levelId = levelOf(room);
    const placement = geo.placement(frameOf(levelId), geo.axis({ x: 0, y: 0, z: 0 }));
    const cls = resolveIfcClass(registry, index, room);
    const pt = cls.entity === "IfcSpace" && cls.predefinedType && predefinedTypes("IfcSpace").has(cls.predefinedType) ? cls.predefinedType : "INTERNAL";
    const ref = g.add("IFCSPACE", [str(guid), $, str255(room.number), $, $, placement, $, str255(room.name), en("ELEMENT"), en(pt), $]);
    spaceRefs.set(room.id, { ref, guid, levelId });
    counts.spaces++;
    const bag = new PropertyBag();
    bag.set("Pset_SpaceCommon", { kind: "text", name: "Reference", value: room.number });
    const area = Number.isFinite(room.areaSqM) && room.areaSqM > 0 ? room.areaSqM : null;
    if (area !== null) bag.quantity("Qto_SpaceBaseQuantities", { kind: "number", name: "NetFloorArea", value: area, unit: "m2" });
    bag.set("MutinyBIM_Space", { kind: "text", name: "Source", value: "Architect's room" });
    attachSets(ref, guid, room.id, bag);
    if (!roomsInSpaces.has(room.id)) pushChild(levelId, ref);
  };
  for (const room of elements) if (room.kind === "room" && !guarded(room, writeRoom)) spaceRefs.delete(room.id);
  const writeSpace = (sp: Space): void => {
    const guid = guids.record(sp);
    const levelId = sp.levelId && storeys.has(sp.levelId) ? sp.levelId : null;
    const placement = geo.placement(frameOf(levelId), geo.axis({ x: 0, y: 0, z: 0 }));
    const outlines = spaceOutlines(els, sp);
    const height = sp.ceilingHeightMm ?? null;
    const body = outlines.length === 1 && outlines[0] && height ? geo.prism(outlines[0], 0, height) : null;
    const ref = g.add("IFCSPACE", [str(guid), $, str255(sp.number), $, $, placement, body ?? $, str255(sp.name), en("ELEMENT"), en("SPACE"), $]);
    spaceRefs.set(sp.id, { ref, guid, levelId });
    counts.spaces++;
    const rooms = sp.bounds.kind === "rooms" ? sp.bounds.roomIds.filter((r) => roomsInSpaces.get(r) === sp.id).map((r) => spaceRefs.get(r)?.ref).filter((r): r is StepRef => !!r) : [];
    aggregate(ref, guid, rooms);
    const bag = new PropertyBag();
    bag.set("Pset_SpaceCommon", { kind: "text", name: "Reference", value: sp.number });
    const area = spaceAreaM2(els, sp);
    if (area !== null) bag.quantity("Qto_SpaceBaseQuantities", { kind: "number", name: "NetFloorArea", value: area, unit: "m2" });
    if (height) bag.quantity("Qto_SpaceBaseQuantities", { kind: "number", name: "Height", value: height, unit: "mm" });
    if (sp.occupants !== undefined) bag.set("Pset_SpaceOccupancyRequirements", { kind: "number", name: "OccupancyNumber", value: sp.occupants, unit: "ea" });
    if (sp.use?.name) bag.set("Pset_SpaceOccupancyRequirements", { kind: "text", name: "OccupancyType", value: sp.use.name });
    if (sp.use) bag.set("MutinyBIM_Space", { kind: "text", name: "Use", value: `${sp.use.libraryId}/${sp.use.useId}` });
    bag.set("MutinyBIM_Space", { kind: "text", name: "Origin", value: sp.origin.kind });
    if (sp.block !== undefined) bag.set("MutinyBIM_Space", { kind: "bool", name: "BlockLoad", value: sp.block });
    attachSets(ref, guid, sp.id, bag);
    pushChild(levelId, ref);
  };
  for (const sp of spaces) {
    if (guarded(sp, writeSpace)) continue;
    spaceRefs.delete(sp.id);
    // Its rooms are still in the file: they go under their storey instead of under the space.
    for (const r of roomIdsOf(sp)) {
      if (roomsInSpaces.get(r) !== sp.id) continue;
      roomsInSpaces.delete(r);
      const room = spaceRefs.get(r);
      if (room) pushChild(room.levelId, room.ref);
    }
  }

  // ---------------------------------------------------------------- building elements
  const products = new Map<string, Product>();
  const contained = new Map<string, { readonly structure: StepRef; readonly structureGuid: string; readonly items: StepRef[] }>();
  const contain = (structureKey: string, structure: StepRef, structureGuid: string, item: StepRef) => {
    const c = contained.get(structureKey) ?? { structure, structureGuid, items: [] };
    c.items.push(item);
    contained.set(structureKey, c);
  };
  const containIn = (levelId: string | null, spaceId: string | null, item: StepRef) => {
    const space = spaceId ? spaceRefs.get(spaceId) : undefined;
    if (space) return contain(`space:${spaceId}`, space.ref, space.guid, item);
    const storey = levelId ? storeys.get(levelId) : undefined;
    if (storey) return contain(`storey:${levelId}`, storey.ref, storey.guid, item);
    contain("building", buildingRef, buildingGuid, item);
  };

  const typeObjects = new Map<string, { readonly ref: StepRef; readonly guid: string; readonly members: StepRef[] }>();
  const typicalMembers = new Map<string, { readonly levelId: string | null; readonly items: StepRef[] }>();
  const groupMembers = new Map<string, StepRef[]>();

  const writeType = (key: string, entity: string, predefined: string | null, name: string, elementType: string | null, bag: PropertyBag | null, extraEnums: Readonly<Record<string, string>> = {}): { ref: StepRef; guid: string; members: StepRef[] } => {
    const existing = typeObjects.get(key);
    if (existing) return existing;
    const guid = guids.derived(`type:${key}`);
    const sets = bag && !bag.empty ? writeSets(g, units, bag, (n) => guids.derived(`set:type:${key}:${n}`)) : [];
    if (bag) {
      counts.propertySets += bag.psets.size;
      counts.quantitySets += bag.qtos.size;
    }
    const members = predefinedTypes(entity);
    const tail = ownAttributes(entity).map((a): StepValue => {
      if (a === "PredefinedType") return en(predefined && members.has(predefined) ? predefined : "NOTDEFINED");
      if (a === "OperationType" || a === "PartitioningType") return en(extraEnums[a] ?? "NOTDEFINED");
      return $;
    });
    const ref = g.add(entity.toUpperCase(), [str(guid), $, str255(name), $, $, sets.length > 0 ? list(sets.map((s) => s.ref)) : $, $, $, elementType ? str255(elementType) : $, ...tail]);
    const entry = { ref, guid, members: [] as StepRef[] };
    typeObjects.set(key, entry);
    counts.types++;
    return entry;
  };

  const writeElement = (el: BimElement, cls: ResolvedIfcClass, name: string | null, tag: string | null, placement: StepRef | null, body: StepRef | null, extra: Readonly<Record<string, number | string>> = {}): Product => {
    const guid = guids.record(el);
    const tail = ownAttributes(cls.entity).map((a): StepValue => {
      if (a === "PredefinedType") return cls.predefinedType ? en(cls.predefinedType) : $;
      const v = extra[a];
      if (typeof v === "string" && v.trim() !== "") return en(v);
      return typeof v === "number" && v > 0 ? real(v) : $;
    });
    const ref = g.add(cls.entity.toUpperCase(), [str(guid), $, opt(name), $, opt(cls.objectType), placement ?? $, body ?? $, opt(tag), ...tail]);
    tally(cls.entity);
    counts.elements++;
    let missingClass: string | null = null;
    if (cls.entity === PROXY && cls.classId === BUILDING_FALLBACK_CLASS_ID && "classId" in el && el.classId && !registry.getClass(el.classId)) {
      missingClass = el.classId;
      missingProxyClasses.set(el.classId, (missingProxyClasses.get(el.classId) ?? 0) + 1);
    }
    if (cls.note && cls.entity === PROXY) warn(`${el.id}: written as ${PROXY} (${cls.note})`);
    else if (cls.note) warn(`${el.id}: ${cls.note}`);
    const p = { ref, guid, placement, missingClass };
    products.set(el.id, p);
    return p;
  };

  const grids: GridLine[] = [];

  const partTypeOf = (part: PartInstance): PartTypeElement | null => {
    const t = els[part.typeId];
    return t?.kind === "part_type" ? t : null;
  };

  const partValues = (bag: PropertyBag, def: PartTypeElement["definition"], values: Readonly<Record<string, number | string | boolean>>, scope: "instance" | "type") => {
    const params = scope === "type" ? def.typeParams : def.instanceParams;
    for (const p of [...params].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const v = values[p.name];
      if (v === undefined) continue;
      const q = parameterOfParamDef(p, scope);
      const home = homes.find([q.key, `param.${p.name}`]);
      const input: PropertyInput =
        typeof v === "number" ? (q.valueType === "quantity" ? { kind: "number", name: p.label, value: v, ...(q.storedUnit ? { unit: q.storedUnit } : {}) } : { kind: "number", name: p.label, value: v }) : typeof v === "boolean" ? { kind: "bool", name: p.label, value: v } : { kind: "text", name: p.label, value: v };
      bag.put(home, input);
    }
  };

  const writeBuildingElement = (el: BimElement): void => {
    const resolved = resolveIfcClass(registry, index, el);
    // A separation line bounds rooms and is never built.
    const cls: ResolvedIfcClass = el.kind === "space_separator" ? { ...resolved, entity: "IfcVirtualElement", predefinedType: "BOUNDARY", note: null } : resolved;
    const levelId = levelOf(el);
    const frame = frameOf(levelId);
    const bag = new PropertyBag();
    let product: Product;
    let spaceHint: string | null = null;
    let hostSpace: string | null = null;
    let planned = false;

    if (el.kind === "part") {
      const type = partTypeOf(el);
      const where = placementOf(el);
      const mark = el.mark.trim() || null;
      const name = mark ?? type?.definition.typeName ?? null;
      if (where.state === "planned") {
        planned = true;
        spaceHint = where.spaceHint && spaceRefs.has(where.spaceHint) ? where.spaceHint : null;
        product = writeElement(el, cls, name, mark, null, null);
        bag.set("MutinyBIM_Placement", { kind: "text", name: "State", value: "PLANNED" });
        if (where.note) bag.set("MutinyBIM_Placement", { kind: "text", name: "Note", value: where.note });
        counts.planned++;
      } else {
        const placement = geo.placement(frame, geo.turned({ x: where.position.x, y: where.position.y, z: where.offsetMm }, where.rotationDeg));
        let body: StepRef | null = null;
        if (type) {
          try {
            if (type.definition.model && partGeometryReady()) {
              // The same solid the screen, sheets and clash read; its feature boxes are for picking only.
              const local = partMesh(type.definition, el.values, "fine");
              body = geo.mesh(mountedPositions(local.positions, el.mount), local.indices, true);
            } else {
              if (type.definition.model) warn(`${el.id}: the geometry engine isn't loaded, so its modeled body is written as its box`);
              const box = localBounds(resolveGeometry(type.definition, el.values));
              body = geo.box({ x: box.min[0], y: box.min[1], z: box.min[2] }, { x: box.max[0], y: box.max[1], z: box.max[2] });
            }
          } catch (err) {
            console.error("[bim-ifc] part geometry did not resolve; exported without a body", { partId: el.id, err });
            warn(`${el.id}: its part geometry did not resolve, so it has no body in the file`);
          }
        }
        product = writeElement(el, cls, name, mark, placement, body);
        bag.set("MutinyBIM_Placement", { kind: "text", name: "State", value: "PLACED" });
      }
      if (type) {
        const t = writeType(`${type.id}|${cls.entity}`, cls.typeEntity ?? "IfcBuildingElementProxyType", cls.predefinedType, type.definition.typeName, type.definition.familyName, (() => {
          const tb = new PropertyBag();
          partValues(tb, type.definition, type.definition.typeValues, "type");
          return tb;
        })());
        t.members.push(product.ref);
        partValues(bag, type.definition, el.values, "instance");
      } else warn(`${el.id}: its part type ${el.typeId} is not in the model`);
    } else if (el.kind === "wall") {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const placement = geo.placement(frame, geo.turned({ x: el.start.x, y: el.start.y, z: wallBaseAtMm(el, 0) }, (Math.atan2(dy, dx) * 180) / Math.PI));
      product = writeElement(el, cls, el.wallType || null, null, placement, geo.strip(Math.hypot(dx, dy), el.thickness, el.height));
      if (cls.typeEntity && el.wallType && !elementTypeOf(els, el)) writeType(`wall:${el.wallType}|${cls.entity}`, cls.typeEntity, cls.predefinedType, el.wallType, null, null).members.push(product.ref);
    } else if (el.kind === "slab") {
      const placement = geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 }));
      product = writeElement(el, cls, null, null, placement, geo.prism(el.outline, -el.thickness, el.thickness));
    } else if (el.kind === "opening") {
      // Turned with its host and boxed through it, from its sill to its head, so a reader sees the door's own shape.
      const hostEl = els[el.hostId];
      const line = hostEl ? hostLineOf(hostEl, els) : null;
      const v = hostVoidsOf(els, el.hostId).find((x) => x.elementId === el.id);
      const sill = v ? Math.min(...v.profile.map((q) => q.y)) : 0;
      const hostBase = hostEl ? wallBaseAtMm(hostEl, el.offset) : 0;
      const angle = line ? (Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x) * 180) / Math.PI : 0;
      const depth = line?.widthMm ?? 0;
      const placement = geo.placement(frame, geo.turned({ x: el.position.x, y: el.position.y, z: hostBase + sill }, angle));
      const body = el.width > 0 && el.height > 0 && depth > 0 ? geo.box({ x: -el.width / 2, y: -depth / 2, z: 0 }, { x: el.width / 2, y: depth / 2, z: el.height }) : null;
      const resolveIfcDoorOp = (): string => {
        const op = elementTypeValue(els, el, "architecture.door_operation");
        if (typeof op === "string" && op.trim()) return op.trim().toUpperCase();
        const hand = elementTypeValue(els, el, "architecture.door_handing");
        if (typeof hand === "string") {
          const h = hand.trim().toUpperCase();
          if (h === "RH" || h === "RHR") return "SINGLE_SWING_RIGHT";
          if (h === "LH" || h === "LHR") return "SINGLE_SWING_LEFT";
        }
        return "SINGLE_SWING_LEFT";
      };
      const rawWinPart = el.openingType === "window" ? elementTypeValue(els, el, "architecture.window_partitioning") : undefined;
      const extraOpening: Record<string, number | string> = {
        OverallWidth: el.width,
        OverallHeight: el.height,
        ...(el.openingType === "door" ? { OperationType: resolveIfcDoorOp() } : {}),
        ...(typeof rawWinPart === "string" && rawWinPart.trim() ? { PartitioningType: rawWinPart.trim().toUpperCase() } : {}),
      };
      product = writeElement(el, cls, el.mark.trim() || null, el.mark.trim() || null, placement, body, extraOpening);
    } else if (el.kind === "run_segment") {
      const placement = geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 }));
      const s = el.size;
      const section = sectionOf(s);
      const system = els[el.systemId];
      const systemName = system?.kind === "mep_system" ? system.name.trim() : "";
      const dimensions = `${Object.values(section).map((value) => Math.round(value * 10) / 10).join("x")} mm`;
      const shapeName = s.shape === "oval" || s.shape === "round" ? ` ${s.shape}` : "";
      const name = `${dimensions}${shapeName} ${systemName || cls.classLabel || el.domain}`;
      product = writeElement(el, cls, name, null, placement, geo.sweep(el.start, el.end, section));
      for (const [dimension, value] of Object.entries(section)) {
        if (!(value > 0)) continue;
        const path = `run.${dimension}`;
        const declared = cls.classId ? registry.field(cls.classId, path) : undefined;
        const provided = cls.classId && fields.getClass(cls.classId) ? fields.field(cls.classId, path) : undefined;
        bag.put((declared ?? provided)?.ifc ?? null, { kind: "number", name: dimension, value, unit: "mm", measure: "IFCPOSITIVELENGTHMEASURE" }, "MutinyBIM_Run");
      }
    } else if (el.kind === "run_fitting") {
      // Placed at its own point; the body is the library shape the 3D view draws, or a leg to each port when the library has none.
      const at = el.position;
      const placement = geo.placement(frame, geo.axis(at));
      let body: StepRef | null = null;
      let unresolved = false;
      try {
        const mesh = fittingMesh(fittingBody(els, el));
        body = geo.mesh(mesh.positions.map((v, i) => v - (i % 3 === 0 ? at.x : i % 3 === 1 ? at.y : at.z)), mesh.indices, false);
      } catch (err) {
        console.error("[bim-ifc] fitting geometry did not resolve; exported as a leg to each port", { fittingId: el.id, err });
        unresolved = true;
      }
      // A stored port with no size has no section to sweep: its leg is left out and the report says so.
      const sized = el.ports.filter((port) => typeof port.size === "object" && port.size !== null);
      if (!body && sized.length < el.ports.length) warn(`${el.id}: ${el.ports.length - sized.length} of this fitting's ports ${el.ports.length - sized.length === 1 ? "has" : "have"} no size, so no leg is drawn to ${el.ports.length - sized.length === 1 ? "it" : "them"}. Draw the fitting again, then export again.`);
      body ??= geo.legs(sized.map((port) => ({ start: { x: 0, y: 0, z: 0 }, end: { x: port.position.x - at.x, y: port.position.y - at.y, z: port.position.z - at.z }, section: sectionOf(port.size) })));
      if (!body) warn(unresolved ? `${el.id}: its fitting shape did not resolve and it has no ports with length, so it has no body in the file` : `${el.id}: its fitting has no library body and no ports with length, so it has no body in the file`);
      else if (unresolved) warn(`${el.id}: its fitting shape did not resolve, so it is written as a leg to each port`);
      product = writeElement(el, cls, stringField(el, "mark") ?? stringField(el, "label"), stringField(el, "mark"), placement, body);
    } else if (el.kind === "ceiling") {
      // The board the 3D view draws: its outline, less its holes, from its height up. In its room when it has one.
      const placement = geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 }));
      if (ceilingSlope(el)) warn(`${el.id}: a sloped ceiling is written flat at its stated height, so its body is only right where that height is measured`);
      product = writeElement(el, cls, ceilingRole(el).label, null, placement, geo.prism(el.outline, el.heightMm, CEILING_BOARD_MM, Array.isArray(el.holes) ? el.holes : []));
      hostSpace = el.spaceId && spaceRefs.has(el.spaceId) ? el.spaceId : null;
    } else if (el.kind === "column") {
      const baseLevel = levelId ? els[levelId] : undefined;
      const floorMm = baseLevel?.kind === "level" ? baseLevel.elevationMm : 0;
      const span = columnVerticalSpan(els, el, floorMm);
      const rotation = el.placement?.kind === "point" && el.placement.rotationDeg ? el.placement.rotationDeg : 0;
      const placement = geo.placement(frame, geo.turned({ x: el.position.x, y: el.position.y, z: span.baseZMm - floorMm }, rotation));
      const body = el.size.x > 0 && el.size.y > 0 && span.heightMm > 0 ? geo.box({ x: -el.size.x / 2, y: -el.size.y / 2, z: 0 }, { x: el.size.x / 2, y: el.size.y / 2, z: span.heightMm }) : null;
      const mark = stringField(el, "mark") ?? (typeof el.values?.mark === "string" && el.values.mark.trim() ? el.values.mark.trim() : null);
      const name = mark ?? (typeof el.values?.["struct.section"] === "string" ? el.values["struct.section"] : null) ?? el.material;
      product = writeElement(el, cls, name, mark, placement, body);
    } else if (el.kind === "beam") {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const len = Math.hypot(dx, dy);
      const p = el.placement?.kind === "line" ? el.placement : null;
      let depth = 400;
      let width = 180;
      const classParts = classSolidsOf(el, { elements: els, floorMm: 0 }, activeClassRegistry());
      if (classParts && classParts.length > 0 && len > 1e-3) {
        const nx = -dy / len;
        const ny = dx / len;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let minW = Infinity;
        let maxW = -Infinity;
        for (const part of classParts) {
          const blocks = part.shape.form === "prisms" ? part.shape.blocks : part.shape.form === "prism" ? [part.shape] : [];
          for (const b of blocks) {
            minZ = Math.min(minZ, b.z0);
            maxZ = Math.max(maxZ, b.z1);
            for (const q of b.outline) {
              const proj = (q.x - el.start.x) * nx + (q.y - el.start.y) * ny;
              minW = Math.min(minW, proj);
              maxW = Math.max(maxW, proj);
            }
          }
        }
        if (Number.isFinite(minZ) && Number.isFinite(maxZ) && maxZ - minZ > 1) depth = maxZ - minZ;
        if (Number.isFinite(minW) && Number.isFinite(maxW) && maxW - minW > 1) width = maxW - minW;
      }
      const startOff = p?.startOffsetMm ?? 0;
      const endOff = p?.endOffsetMm ?? 0;
      const vAlign = p?.vertical ?? "top";
      const zShift = vAlign === "bottom" ? depth : vAlign === "center" ? depth / 2 : 0;
      const isSloped = Math.abs(endOff - startOff) > 1e-3;
      const placement = isSloped
        ? geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 }))
        : geo.placement(frame, geo.turned({ x: el.start.x, y: el.start.y, z: startOff + zShift - depth }, (Math.atan2(dy, dx) * 180) / Math.PI));
      const body =
        len > 0
          ? isSloped
            ? geo.sweep(
                { x: el.start.x, y: el.start.y, z: startOff + zShift - depth / 2 },
                { x: el.end.x, y: el.end.y, z: endOff + zShift - depth / 2 },
                { width, height: depth },
              )
            : geo.strip(len, width, depth)
          : null;
      const mark = stringField(el, "mark") ?? (typeof el.values?.mark === "string" && el.values.mark.trim() ? el.values.mark.trim() : null);
      const name = mark ?? (el.sectionName.trim() || null);
      product = writeElement(el, cls, name, mark, placement, body);
    } else {
      // Every other kind: placed at its stated point, with a body where the kernel states a box (e.g. pad footings).
      const pos: unknown = Reflect.get(el, "position");
      const p = typeof pos === "object" && pos !== null ? { x: finite(Reflect.get(pos, "x")), y: finite(Reflect.get(pos, "y")), z: finite(Reflect.get(pos, "z")) } : null;
      const rotation = numberField(el, "rotationDeg") ?? 0;
      const offsetZ = el.kind === "component" && el.placement?.kind === "point" ? el.placement.offsetMm : 0;
      const placement = p ? geo.placement(frame, geo.turned({ x: p.x, y: p.y, z: p.z + offsetZ }, rotation)) : null;
      let body: StepRef | null = null;
      if (el.kind === "component" && el.category === "footing" && el.size.x > 0 && el.size.y > 0) {
        const rawThick = elementTypeValue(els, el, "struct.footing_thickness_mm");
        const thickMm = typeof rawThick === "number" && Number.isFinite(rawThick) && rawThick > 0 ? rawThick : 18 * 25.4;
        body = geo.box({ x: -el.size.x / 2, y: -el.size.y / 2, z: -thickMm }, { x: el.size.x / 2, y: el.size.y / 2, z: 0 });
      }
      const mark = stringField(el, "mark") ?? (el.kind !== "load_point" && "values" in el && el.values && typeof el.values.mark === "string" && el.values.mark.trim() ? el.values.mark.trim() : null);
      const name = mark ?? stringField(el, "label") ?? stringField(el, "typeName") ?? stringField(el, "sectionName");
      product = writeElement(el, cls, name, mark, placement, body);
    }

    const elementType = el.kind === "part" ? null : elementTypeOf(els, el);
    if (elementType) {
      const tb = new PropertyBag();
      parameterValues(tb, elementType.values ?? {}, "MutinyBIM_Type");
      const rawOp = elementType.values?.["architecture.door_operation"];
      const rawPart = elementType.values?.["architecture.window_partitioning"];
      const extraEnums: Record<string, string> = {
        ...(typeof rawOp === "string" && rawOp.trim() ? { OperationType: rawOp.trim().toUpperCase() } : {}),
        ...(typeof rawPart === "string" && rawPart.trim() ? { PartitioningType: rawPart.trim().toUpperCase() } : {}),
      };
      writeType(`etype:${elementType.id}|${cls.entity}`, cls.typeEntity ?? "IfcBuildingElementProxyType", cls.predefinedType, elementType.name, null, tb, extraEnums).members.push(product.ref);
    }
    organizationSets(bag, el);
    attachSets(product.ref, product.guid, el.id, bag);
    // Nothing below can throw: an element that fails above is in no list, so leaving it out leaves no trace of it.
    const typical = typicalOfGroup(els, el.groupId);
    const groupName = ifcOrganizationProperties(model, el)?.group.name;
    if (typical) {
      const t = typicalMembers.get(typical.groupId) ?? { levelId, items: [] };
      t.items.push(product.ref);
      typicalMembers.set(typical.groupId, t);
    } else containIn(levelId, planned ? spaceHint : hostSpace, product.ref);
    if (groupName) push(groupMembers, groupName, product.ref);
  };
  for (const el of elements) {
    if (NOT_EXPORTED_KINDS.has(el.kind)) {
      skipped[el.kind] = (skipped[el.kind] ?? 0) + 1;
      continue;
    }
    if (STRUCTURE_KINDS.has(el.kind)) continue;
    if (el.kind === "grid") {
      grids.push(el);
      continue;
    }
    const from = g.size;
    if (guarded(el, writeBuildingElement)) continue;
    // Take back what its writer had registered: the product, its missing-class count, a type it made or joined.
    const product = products.get(el.id);
    if (product) {
      products.delete(el.id);
      const n = product.missingClass === null ? 0 : (missingProxyClasses.get(product.missingClass) ?? 0);
      if (product.missingClass !== null && n > 1) missingProxyClasses.set(product.missingClass, n - 1);
      else if (product.missingClass !== null) missingProxyClasses.delete(product.missingClass);
    }
    for (const [key, t] of typeObjects) {
      if (t.ref.ref > from) typeObjects.delete(key);
      else while ((t.members[t.members.length - 1]?.ref ?? 0) > from) t.members.pop();
    }
  }

  for (const [, t] of [...typeObjects].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (t.members.length === 0) continue;
    g.add("IFCRELDEFINESBYTYPE", [str(guids.rel("IfcRelDefinesByType", [t.guid])), $, $, $, list(t.members), t.ref]);
  }

  // ---------------------------------------------------------------- relationships (`kernel.ifc_relation`)
  // Openings between hosts and their doors, a roof's slab part, a stair's flight: synthetic objects and the relationships the rows ask for.
  const synthetic = new Map<string, { readonly ref: StepRef; readonly guid: string }>();
  const endOf = (key: string): { readonly ref: StepRef; readonly guid: string } | null => products.get(key) ?? synthetic.get(key) ?? null;
  const relationRef = (entity: string, a: { readonly guid: string }, b: { readonly guid: string }): StepValue => str(guids.rel(entity, [a.guid, b.guid]));
  const writeRelations = (el: BimElement): void => {
    const owner = products.get(el.id);
    for (const row of ifcRelationRowsFor(el.kind)) {
      let out: ReturnType<typeof row.relations>;
      try {
        out = row.relations(el, els);
      } catch (err) {
        console.error("[bim-ifc] an IFC relation row failed; its relationships are left out", { row: row.id, elementId: el.id, err });
        warn(`${el.id}: the ${row.label} relationships couldn't be written`);
        continue;
      }
      for (const o of out.objects) {
        if (synthetic.has(o.key)) continue;
        const guid = guids.derived(`synthetic:${o.key}`);
        const members = predefinedTypes(o.entity);
        const tail = ownAttributes(o.entity).map((a): StepValue => {
          if (a === "PredefinedType") return o.predefinedType && members.has(o.predefinedType) ? en(o.predefinedType) : $;
          const v = o.attributes?.[a];
          if (v === undefined || !Number.isFinite(v)) return $;
          return a.startsWith("NumberOf") ? int(Math.round(v)) : real(v);
        });
        const placement = owner?.placement ? geo.placement(owner.placement, geo.axis({ x: 0, y: 0, z: 0 })) : null;
        const ref = g.add(o.entity.toUpperCase(), [str(guid), $, opt(o.name), $, $, placement ?? $, $, $, ...tail]);
        synthetic.set(o.key, { ref, guid });
        tally(o.entity);
      }
      for (const r of out.relations) {
        const relating = endOf(r.relating);
        const related = r.related.map(endOf).filter((x): x is { readonly ref: StepRef; readonly guid: string } => x !== null);
        if (!relating || related.length === 0) {
          warn(`${el.id}: a ${r.entity} names something not in the file`);
          continue;
        }
        if (r.entity === "IfcRelVoidsElement" || r.entity === "IfcRelFillsElement") {
          for (const x of related) g.add(r.entity.toUpperCase(), [relationRef(r.entity, relating, x), $, $, $, relating.ref, x.ref]);
        } else if (r.entity === "IfcRelAggregates") {
          aggregate(relating.ref, relating.guid, related.map((x) => x.ref));
        } else if (r.entity === "IfcRelSpaceBoundary") {
          for (const x of related) g.add("IFCRELSPACEBOUNDARY", [relationRef(r.entity, relating, x), $, $, $, relating.ref, x.ref, $, en(r.physicalOrVirtual ?? "NOTDEFINED"), en(r.internalOrExternal ?? "NOTDEFINED")]);
        } else warn(`${el.id}: ${r.entity} from a relation row isn't written by this exporter`);
        tally(r.entity);
      }
    }
  };
  for (const el of elements) {
    if (leftOut.has(el.id) || ifcRelationRowsFor(el.kind).length === 0) continue;
    const from = g.size;
    if (guarded(el, writeRelations, "has its relationships")) continue;
    for (const [key, made] of synthetic) if (made.ref.ref > from) synthetic.delete(key);
  }

  // ---------------------------------------------------------------- space boundaries (2nd level, from each bounded space's facts)
  const writeBoundaries = (sp: Space): void => {
    if (sp.bounds.kind !== "bounded") return;
    const space = spaceRefs.get(sp.id);
    const facts = spaceBoundaryFacts(model, sp.id);
    if (!space || !Array.isArray(facts)) return;
    for (const f of facts) {
      const element = products.get(f.elementId);
      if (!element) continue;
      const side = f.otherSide.kind === "space" ? "INTERNAL" : f.otherSide.kind === "outside" ? "EXTERNAL" : "NOTDEFINED";
      g.add("IFCRELSPACEBOUNDARY", [str(guids.rel("IfcRelSpaceBoundary", [space.guid, element.guid])), $, $, $, space.ref, element.ref, $, en(f.virtual ? "VIRTUAL" : "PHYSICAL"), en(side)]);
      tally("IfcRelSpaceBoundary");
    }
  };
  for (const sp of spaces) if (spaceRefs.has(sp.id)) guarded(sp, writeBoundaries, "has its boundaries");

  // ---------------------------------------------------------------- grids: one IfcGrid, U and V axes with their tags
  if (grids.length > 0) {
    const point = (p: { readonly x: number; readonly y: number }): StepRef => g.add("IFCCARTESIANPOINT", [list([real(p.x), real(p.y)])]);
    const axis = (gl: GridLine): StepRef => g.add("IFCGRIDAXIS", [str255(gl.label.trim() || gl.id), g.add("IFCPOLYLINE", [list([point(gl.start), point(gl.end)])]), bool(true)]);
    // U axes first, then V, each in id order. A grid line that can't be written is left out of both.
    const axesOf = (family: "U" | "V"): StepRef[] => {
      const out: StepRef[] = [];
      for (const gl of grids) {
        if (leftOut.has(gl.id)) continue;
        guarded(gl, (line) => {
          if (gridAxisFamily(line.start, line.end) === family) out.push(axis(line));
        });
      }
      return out;
    };
    const axesFrom = g.size;
    const u = axesOf("U");
    const v = axesOf("V");
    const lost = grids.filter((gl) => leftOut.has(gl.id)).length;
    if (lost > 0 && (u.length === 0 || v.length === 0)) {
      // An IfcGrid needs an axis each way. The lines left out were the only ones one way, so the rest can't stand as a grid.
      g.dropFrom(axesFrom);
      dropped = true;
      if (u.length + v.length > 0) warn(`The ${u.length + v.length} grid line${u.length + v.length === 1 ? " that could be written is" : "s that could be written are"} left out of the file too, because the grid has no line left in the other direction. Fix the grid lines named above, then export again.`);
    } else {
      const lowest = levels[0]?.id ?? null;
      const guid = guids.derived("grid");
      const ref = g.add("IFCGRID", [str(guid), $, str("Grid"), $, $, geo.placement(frameOf(lowest), geo.axis({ x: 0, y: 0, z: 0 })), $, list(u), list(v), $, en("RECTANGULAR")]);
      byEntity.IfcGrid = (byEntity.IfcGrid ?? 0) + 1;
      byEntity.IfcGridAxis = (byEntity.IfcGridAxis ?? 0) + u.length + v.length;
      containIn(lowest, null, ref);
    }
  }

  // ---------------------------------------------------------------- typicals as assemblies
  const writeTypical = (groupId: string, t: { readonly levelId: string | null; readonly items: StepRef[] }): void => {
    const ref = typicalOfGroup(els, groupId);
    if (!ref) return;
    const { spec } = ref;
    const frame = frameOf(t.levelId);
    const typeGuid = guids.derived(`typical-type:${groupId}`);
    const assemblyType = g.add("IFCELEMENTASSEMBLYTYPE", [str(typeGuid), $, str255(spec.label), $, $, $, $, $, $, en("NOTDEFINED")]);
    counts.types++;
    const instances: StepRef[] = [];
    const originalGuid = guids.derived(`typical:${groupId}`);
    const original = g.add("IFCELEMENTASSEMBLY", [str(originalGuid), $, str255(`${spec.label} ${spec.mark}`), $, str255(spec.label), geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 })), $, str255(spec.mark), $, $]);
    aggregate(original, originalGuid, t.items);
    instances.push(original);
    const bagOf = (mark: string, copyOf: string | null) => {
      const bag = new PropertyBag();
      bag.set("MutinyBIM_Typical", { kind: "text", name: "Mark", value: mark });
      bag.set("MutinyBIM_Typical", { kind: "text", name: "Typical", value: spec.label });
      if (copyOf) bag.set("MutinyBIM_Typical", { kind: "text", name: "CopyOf", value: copyOf });
      return bag;
    };
    attachSets(original, originalGuid, `typical:${groupId}`, bagOf(spec.mark, null));
    for (const copy of [...spec.copies].sort(byId)) {
      const a = (copy.rotationDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const b = spec.basePoint;
      const origin = { x: b.x + copy.offset.x - (c * b.x - s * b.y), y: b.y + copy.offset.y - (s * b.x + c * b.y), z: 0 };
      const guid = guids.derived(`typical:${groupId}:copy:${copy.id}`);
      const inst = g.add("IFCELEMENTASSEMBLY", [str(guid), $, str255(`${spec.label} ${copy.mark}`), $, str255(spec.label), geo.placement(frame, geo.turned(origin, copy.rotationDeg)), $, str255(copy.mark), $, $]);
      attachSets(inst, guid, `typical:${groupId}:copy:${copy.id}`, bagOf(copy.mark, spec.mark));
      instances.push(inst);
    }
    g.add("IFCRELDEFINESBYTYPE", [str(guids.rel("IfcRelDefinesByType", [typeGuid])), $, $, $, list(instances), assemblyType]);
    counts.assemblies += instances.length;
    for (const inst of instances) containIn(t.levelId, null, inst);
  };
  for (const [groupId, t] of [...typicalMembers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const record = els[groupId];
    if (!record) continue;
    // Its members are in the file already: without their assembly they stand on their level like any other element.
    if (!guarded(record, () => writeTypical(groupId, t), "has its assembly and copies")) for (const item of t.items) containIn(t.levelId, null, item);
  }

  // ---------------------------------------------------------------- ports and connections
  const ports = new Map<string, { readonly ref: StepRef; readonly guid: string }>();
  const nests = new Map<string, { readonly host: Product; readonly items: StepRef[] }>();
  const writePort = (hostId: string, portId: string, name: string, flow: string | undefined, domain: string | undefined, systemKind: string | undefined, placement: StepRef | null): StepRef | null => {
    const host = products.get(hostId);
    if (!host) return null;
    const key = `${hostId}|${portId}`;
    if (ports.has(key)) return ports.get(key)?.ref ?? null;
    const guid = guids.derived(`port:${key}`);
    const sys = systemKind ? services.byId.get(systemKind)?.ifc : undefined;
    const sysType = sys && sys.system === "IfcDistributionSystem" && predefinedTypes("IfcDistributionSystem").has(sys.predefinedType) ? en(sys.predefinedType) : $;
    const ref = g.add("IFCDISTRIBUTIONPORT", [str(guid), $, str255(name), $, $, placement ?? $, $, en(FLOW_DIRECTION[flow ?? ""] ?? "NOTDEFINED"), en(PORT_DOMAIN[domain ?? ""] ?? "NOTDEFINED"), sysType]);
    ports.set(key, { ref, guid });
    const n = nests.get(hostId) ?? { host, items: [] };
    n.items.push(ref);
    nests.set(hostId, n);
    counts.ports++;
    return ref;
  };
  const systemKindOf = (systemId: string): string | undefined => {
    const s = els[systemId];
    return s?.kind === "mep_system" ? s.systemKind : undefined;
  };
  const connections: Array<readonly [string, string]> = [];
  const writePorts = (el: BimElement): void => {
    const host = products.get(el.id);
    if (!host) return;
    if (el.kind === "part") {
      const type = partTypeOf(el);
      if (!type) return;
      for (const c of resolveConnectors(type.definition, el.values)) {
        const placement = host.placement ? geo.placement(host.placement, geo.axis({ x: c.position[0], y: c.position[1], z: c.position[2] })) : null;
        const flow = type.definition.connectors.find((d) => d.id === c.id)?.flowDirection;
        writePort(el.id, c.id, c.label, flow, c.domain, c.systemKind, placement);
      }
      for (const [connector, link] of Object.entries(el.links ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) connections.push([`${el.id}|${connector}`, `${link.elementId}|${link.port}`]);
    } else if (el.kind === "run_segment") {
      const sk = systemKindOf(el.systemId);
      const at = (p: Vec3) => (host.placement ? geo.placement(host.placement, geo.axis(p)) : null);
      writePort(el.id, "start", "Start", undefined, el.domain, sk, at(el.start));
      writePort(el.id, "end", "End", undefined, el.domain, sk, at(el.end));
      const ends: Array<readonly ["start" | "end", PortRef | undefined]> = [
        ["start", el.links.start],
        ["end", el.links.end],
      ];
      for (const [end, link] of ends) if (link) connections.push([`${el.id}|${end}`, `${link.elementId}|${link.port}`]);
    } else if (el.kind === "run_fitting") {
      const sk = systemKindOf(el.systemId);
      for (const port of [...el.ports].sort(byId)) {
        writePort(el.id, port.id, port.id, undefined, el.domain, sk, host.placement ? geo.placement(frameOf(levelOf(el)), geo.axis(port.position)) : null);
        if (port.link) connections.push([`${el.id}|${port.id}`, `${port.link.elementId}|${port.link.port}`]);
      }
    }
  };
  for (const el of elements) {
    if ((el.kind !== "part" && el.kind !== "run_segment" && el.kind !== "run_fitting") || !products.has(el.id)) continue;
    const from = g.size;
    const linked = connections.length;
    if (guarded(el, writePorts, "has its ports")) continue;
    connections.length = linked;
    nests.delete(el.id);
    for (const [key, port] of ports) if (port.ref.ref > from) ports.delete(key);
  }
  const seenPairs = new Set<string>();
  for (const [a, b] of connections) {
    const [first, second] = a < b ? [a, b] : [b, a];
    const pairKey = `${first}~${second}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const pa = ports.get(first);
    const pb = ports.get(second);
    if (!pa || !pb) continue;
    g.add("IFCRELCONNECTSPORTS", [str(guids.rel("IfcRelConnectsPorts", [pa.guid, pb.guid])), $, $, $, pa.ref, pb.ref, $]);
  }

  // Load points: a port for what is connected where no fixture is modelled.
  const writeLoadPoint = (lp: LoadPointElement): void => {
    const anchor = loadAnchorOf(lp);
    const hostId = lp.attachedPartId && products.has(lp.attachedPartId) ? lp.attachedPartId : anchor.kind === "run_end" && products.has(anchor.hostId) ? anchor.hostId : anchor.kind === "part" && products.has(anchor.partId) ? anchor.partId : null;
    const name = lp.mark ?? (lp.connectionType || lp.id);
    const guid = guids.record(lp);
    const service = lp.service ? services.byId.get(lp.service) : undefined;
    const carried = service?.carriedBy ? services.byId.get(service.carriedBy) : service;
    const sysType = carried?.ifc.system === "IfcDistributionSystem" && predefinedTypes("IfcDistributionSystem").has(carried.ifc.predefinedType) ? en(carried.ifc.predefinedType) : $;
    const ref = g.add("IFCDISTRIBUTIONPORT", [str(guid), $, str255(name), $, str("Load point"), $, $, en("SINK"), en(PORT_DOMAIN[carried?.connector ?? ""] ?? "NOTDEFINED"), sysType]);
    counts.ports++;
    const bag = new PropertyBag();
    for (const key of [...LEGACY_QUANTITY_KEYS].sort()) {
      const v = lp.values[key];
      if (typeof v !== "number") continue;
      bag.put(homes.find([`load.${key}`]), { kind: "number", name: key, value: v, unit: QUANTITY_BINDINGS[key].unit }, "MutinyBIM_Loads");
    }
    for (const c of lp.values.custom ?? []) bag.set("MutinyBIM_Loads", { kind: "number", name: c.name, value: c.value, unit: c.unit });
    if (lp.connectionType) bag.set("MutinyBIM_Load", { kind: "text", name: "ConnectionType", value: lp.connectionType });
    if (lp.mark) bag.set("MutinyBIM_Load", { kind: "text", name: "Mark", value: lp.mark });
    if (lp.note) bag.set("MutinyBIM_Load", { kind: "text", name: "Note", value: lp.note });
    if (lp.service) bag.set("MutinyBIM_Load", { kind: "text", name: "Service", value: lp.service });
    attachSets(ref, guid, lp.id, bag);
    // Last, and nothing here can throw: a load point that fails above is in no list.
    const host = hostId ? products.get(hostId) : undefined;
    if (host && hostId) {
      const n = nests.get(hostId) ?? { host, items: [] };
      n.items.push(ref);
      nests.set(hostId, n);
    } else if (anchor.kind === "space") containIn(spaceRefs.get(anchor.id)?.levelId ?? null, anchor.id, ref);
    else if (anchor.kind === "point") containIn(storeys.has(anchor.levelId) ? anchor.levelId : null, null, ref);
    else containIn(null, null, ref);
  };
  for (const lp of elements) if (lp.kind === "load_point") guarded(lp, writeLoadPoint);
  for (const [, n] of [...nests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    g.add("IFCRELNESTS", [str(guids.rel("IfcRelNests", [n.host.guid, "ports"])), $, $, $, n.host.ref, list(n.items)]);
  }

  // ---------------------------------------------------------------- zones
  const zoneOf = (purpose: string): IfcZoneHome => {
    const stated = opts.zonePurposeIfc?.(purpose) ?? purposeHomes.get(purpose);
    if (stated) return stated;
    const spatial = ZONE_PURPOSE_SPATIAL[purpose];
    return spatial ? { entity: "IfcSpatialZone", predefinedType: spatial } : { entity: "IfcSpatialZone", predefinedType: "USERDEFINED", objectType: rawRegistryWords(purpose) };
  };
  const referenced = new Map<string, { readonly structure: StepRef; readonly structureGuid: string; readonly items: StepRef[] }>();
  const writeZone = (z: Zone): void => {
    const guid = guids.record(z);
    const bounds = zoneBoundsOf(z);
    const home = zoneOf(z.purpose);
    const bag = new PropertyBag();
    bag.set("MutinyBIM_Zone", { kind: "text", name: "Purpose", value: z.purpose });
    const server = z.servedBy ? els[z.servedBy] : undefined;
    if (server) bag.set("MutinyBIM_Zone", { kind: "text", name: "ServedBy", value: stringField(server, "mark") ?? server.id });
    counts.zones++;
    if (bounds.kind === "spaces") {
      const ref = g.add("IFCZONE", [str(guid), $, str255(z.name), $, str255(rawRegistryWords(z.purpose)), $]);
      const members = bounds.spaceIds.map((id) => spaceRefs.get(id)?.ref).filter((r): r is StepRef => !!r);
      if (members.length > 0) g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
      attachSets(ref, guid, z.id, bag);
      return;
    }
    // A derived zone's rule states its own IFC type (a pack's rule too); others go by purpose.
    const rulePt = bounds.kind === "derived" ? derivedRules.get(bounds.rule)?.ifcPredefinedType : undefined;
    const statedPt = rulePt ?? (home.entity === "IfcSpatialZone" ? home.predefinedType : undefined);
    const pt = statedPt && predefinedTypes("IfcSpatialZone").has(statedPt) ? statedPt : "USERDEFINED";
    const objectType = pt === "USERDEFINED" ? (home.objectType ?? rawRegistryWords(z.purpose)) : null;
    let levelId: string | null = null;
    let placement: StepRef | null = null;
    let body: StepRef | null = null;
    if (bounds.kind === "outline") {
      levelId = storeys.has(bounds.levelId) ? bounds.levelId : null;
      placement = geo.placement(frameOf(levelId), geo.axis({ x: 0, y: 0, z: 0 }));
      const bottom = bounds.bottom ?? 0;
      if (bounds.top !== undefined) body = geo.prism(bounds.outline, bottom, bounds.top - bottom);
    } else if (bounds.kind === "derived") {
      const host = els[bounds.hostId];
      levelId = host ? levelOf(host) : null;
      bag.set("MutinyBIM_Zone", { kind: "text", name: "Rule", value: bounds.rule });
      bag.set("MutinyBIM_Zone", { kind: "text", name: "Host", value: host ? (stringField(host, "mark") ?? host.id) : bounds.hostId });
    } else warn(`${z.id}: zone bounds of kind "${bounds.storedKind}" are not known to this exporter; written without a shape`);
    const ref = g.add("IFCSPATIALZONE", [str(guid), $, str255(z.name), $, opt(objectType), placement ?? $, body ?? $, $, en(pt)]);
    attachSets(ref, guid, z.id, bag);
    const storey = levelId ? storeys.get(levelId) : undefined;
    const key = storey ? `storey:${levelId}` : "building";
    const r = referenced.get(key) ?? { structure: storey?.ref ?? buildingRef, structureGuid: storey?.guid ?? buildingGuid, items: [] };
    r.items.push(ref);
    referenced.set(key, r);
  };
  for (const z of elements) if (z.kind === "zone") guarded(z, writeZone);

  // ---------------------------------------------------------------- systems and circuits
  const zonesServedBy = new Map<string, string[]>();
  for (const z of elements) {
    if (z.kind !== "zone" || leftOut.has(z.id) || !z.servedBy) continue;
    const b = zoneBoundsOf(z);
    if (b.kind === "spaces") zonesServedBy.set(z.servedBy, [...(zonesServedBy.get(z.servedBy) ?? []), ...b.spaceIds]);
  }
  const writeSystem = (guid: string, name: string, row: ServiceRow | undefined, fallbackType: string, circuit: boolean): StepRef => {
    const ifc = row?.ifc;
    if (circuit || !ifc || ifc.system === "IfcDistributionSystem") {
      const entity = circuit ? "IFCDISTRIBUTIONCIRCUIT" : "IFCDISTRIBUTIONSYSTEM";
      const valid = ifc && ifc.system === "IfcDistributionSystem" && predefinedTypes("IfcDistributionSystem").has(ifc.predefinedType);
      const pt = valid ? ifc.predefinedType : "USERDEFINED";
      const objectType = pt === "USERDEFINED" ? (ifc?.objectType ?? fallbackType) : null;
      return g.add(entity, [str(guid), $, str255(name), $, opt(objectType), $, en(pt)]);
    }
    if (ifc.system === "IfcBuiltSystem") {
      const pt = predefinedTypes("IfcBuiltSystem").has(ifc.predefinedType) ? ifc.predefinedType : "USERDEFINED";
      return g.add("IFCBUILTSYSTEM", [str(guid), $, str255(name), $, opt(pt === "USERDEFINED" ? (ifc.objectType ?? fallbackType) : null), en(pt), $]);
    }
    return g.add("IFCSTRUCTURALANALYSISMODEL", [str(guid), $, str255(name), $, opt(ifc.objectType ?? null), en(/^[A-Z_0-9]+$/.test(ifc.predefinedType) ? ifc.predefinedType : "NOTDEFINED"), $, $, $, $]);
  };
  const servesSpaces = (sysRef: StepRef, sysGuid: string, spaceIds: Iterable<string>) => {
    const refs = [...new Set(spaceIds)].sort().map((id) => spaceRefs.get(id)?.ref).filter((r): r is StepRef => !!r);
    if (refs.length > 0) g.add("IFCRELSERVICESBUILDINGS", [str(guids.rel("IfcRelServicesBuildings", [sysGuid])), $, $, $, sysRef, list(refs)]);
  };
  const plannedSpaceOf = (id: string): string | null => {
    const e = els[id];
    return e?.kind === "part" && e.planned?.spaceHint ? e.planned.spaceHint : null;
  };
  // System members in one pass: runs by their system, parts by the runs they connect to.
  const runsBySystem = new Map<string, string[]>();
  const partsByRun = new Map<string, string[]>();
  for (const e of elements) {
    if ((e.kind === "run_segment" || e.kind === "run_fitting") && products.has(e.id)) push(runsBySystem, e.systemId, e.id);
    if (e.kind !== "part" || !products.has(e.id)) continue;
    // Read as stored: a part whose links can't be read has said so where its ports are written.
    const links: unknown = e.links;
    for (const l of typeof links === "object" && links !== null ? Object.values(links) : []) {
      const runId: unknown = typeof l === "object" && l !== null ? Reflect.get(l, "elementId") : null;
      if (typeof runId === "string") push(partsByRun, runId, e.id);
    }
  }
  const writeMepSystem = (sys: MepSystem): void => {
    const guid = guids.record(sys);
    const row = services.byId.get(sys.systemKind);
    if (!row) warn(`${sys.id}: system kind "${sys.systemKind}" is not in the service registry; written as a USERDEFINED distribution system`);
    const ref = writeSystem(guid, sys.name, row, rawRegistryWords(sys.systemKind), false);
    counts.systems++;
    const runs = runsBySystem.get(sys.id) ?? [];
    const memberIds = new Set<string>([...runs, ...runs.flatMap((r) => partsByRun.get(r) ?? [])]);
    const members = [...memberIds].sort().map((id) => products.get(id)?.ref).filter((r): r is StepRef => !!r);
    if (members.length > 0) g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
    servesSpaces(ref, guid, [...memberIds].flatMap((id) => [...(zonesServedBy.get(id) ?? []), ...(plannedSpaceOf(id) ? [plannedSpaceOf(id) ?? ""] : [])]));
  };
  for (const sys of elements) if (sys.kind === "mep_system") guarded(sys, writeMepSystem);
  const writeCircuit = (link: ServiceLink): void => {
    const guid = guids.record(link);
    const adapter = linkAdapterId(link);
    const row = services.rows.find((r) => r.asSystem && r.adapter === adapter);
    const ref = writeSystem(guid, link.description || link.id, row, rawRegistryWords(adapter), true);
    counts.circuits++;
    const ids = [link.source.elementId, ...link.members.map((m) => m.elementId)];
    const members = [...new Set(ids)].map((id) => products.get(id)?.ref).filter((r): r is StepRef => !!r);
    if (members.length > 0) g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
    const bag = new PropertyBag();
    bag.set("MutinyBIM_Circuit", { kind: "text", name: "Role", value: link.role });
    bag.set("MutinyBIM_Circuit", { kind: "text", name: "Adapter", value: adapter });
    if (link.source.positions.length > 0) bag.set("MutinyBIM_Circuit", { kind: "text", name: "Positions", value: link.source.positions.join(",") });
    // Which member feeds the rest: the source product's GlobalId in this file, and its output. Left out when the source is not in the file.
    const source = products.get(link.source.elementId);
    if (source) {
      bag.set("MutinyBIM_Circuit", { kind: "text", name: "Source", value: source.guid });
      // The source's own name for its output (a board's bus), not an IfcDistributionPort: left out when a stored link has none.
      if (typeof link.source.port === "string" && link.source.port !== "") bag.set("MutinyBIM_Circuit", { kind: "text", name: "SourcePort", value: link.source.port });
    }
    const cls = primaryClass(registry, index, link);
    for (const field of cls && fields.getClass(cls.id) ? fields.fieldsFor(cls.id) : []) {
      if (!field.ifc || !field.read) continue;
      const value = field.read(link, { elements: els });
      if (typeof value === "number" && Number.isFinite(value)) {
        bag.put(field.ifc, { kind: "number", name: field.label, value, unit: field.unit });
      } else if (typeof value === "boolean") {
        bag.put(field.ifc, { kind: "bool", name: field.label, value });
      } else if (typeof value === "string") {
        bag.put(field.ifc, { kind: "text", name: field.label, value });
      }
    }
    attachSets(ref, guid, link.id, bag);
    servesSpaces(ref, guid, link.members.flatMap((m) => [...(zonesServedBy.get(m.elementId) ?? []), ...(plannedSpaceOf(m.elementId) ? [plannedSpaceOf(m.elementId) ?? ""] : [])]));
  };
  for (const link of elements) if (link.kind === "service_link") guarded(link, writeCircuit);

  // ---------------------------------------------------------------- groups, containment, units, project
  for (const [name, members] of [...groupMembers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const guid = guids.derived(`group:${name}`);
    const ref = g.add("IFCGROUP", [str(guid), $, str255(name), $, $]);
    g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
  }
  for (const [levelId, children] of [...storeyChildren].sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : 1))) {
    const storey = levelId ? storeys.get(levelId) : undefined;
    if (storey) aggregate(storey.ref, storey.guid, children);
    else aggregate(buildingRef, `${buildingGuid}:spaces`, children);
  }
  for (const [, c] of [...contained].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    g.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", [str(guids.rel("IfcRelContainedInSpatialStructure", [c.structureGuid])), $, $, $, list(c.items), c.structure]);
  }
  for (const [, r] of [...referenced].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    g.add("IFCRELREFERENCEDINSPATIALSTRUCTURE", [str(guids.rel("IfcRelReferencedInSpatialStructure", [r.structureGuid])), $, $, $, list(r.items), r.structure]);
  }
  // A record left out took its entities with it. Nothing still in the file may point at one of them.
  if (dropped) {
    const missing = g.missingReferences();
    if (missing.length > 0) throw new Error(`IFC export left out a record that the file still points at (#${missing.slice(0, 5).join(", #")})`);
  }
  const unitAssignment = units.write(g);
  g.fill(projectHandle, "IFCPROJECT", [str(projectGuid), $, str255(opts.project.name || "Project"), opt(opts.project.description), $, opt(opts.project.number), $, list([context]), unitAssignment]);

  const text = serializeStep(
    {
      description: ["ViewDefinition [ReferenceView]"],
      implementationLevel: "2;1",
      fileName: opts.fileName ?? `${model.modelId}.ifc`,
      timeStamp: opts.timeStamp,
      author: [opts.author ?? ""],
      organization: [opts.organization ?? ""],
      preprocessor: `MutinyBIM bim-ifc ${BIM_IFC_VERSION}`,
      originatingSystem: "MutinyBIM",
      authorization: "",
      schemas: [IFC_SCHEMA],
    },
    g,
  );
  for (const [classId, count] of missingProxyClasses) {
    warn(`IFC export used ${PROXY} for ${count} building element${count === 1 ? "" : "s"} because class "${classId}" is unavailable. Check that the export host has the add-on or library that provides this class.`);
  }
  return {
    text,
    bytes: new TextEncoder().encode(text),
    report: { schema: IFC_SCHEMA, counts, byEntity, skipped, warnings, globalIds: guids.byRecord },
  };
}

