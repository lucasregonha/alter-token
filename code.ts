"use strict";

// ============================================================
// TYPES
// ============================================================

interface VariableBinding {
  nodeId: string;
  nodeName: string;
  property: string;
  paintSubProp?: string;
  paintIndex?: number;
  variableId: string;
  variableName: string;
  collectionName: string;
}

type SubstitutionStatus = "success" | "failed" | "skipped_instance";

interface SubstitutionResult {
  status: SubstitutionStatus;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  property: string;
  paintSubProp?: string;
  paintIndex?: number;
  oldVariableName: string;
  newVariableName?: string;
}

type PipelinePhase =
  | "collecting"
  | "phase1_components"
  | "phase2_instances"
  | "done";

// Typography scalar props that Figma exposes via boundVariables on TextNode
const FONT_BOUND_PROPS = new Set([
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
]);

// Accepted top-level target node types
type TargetNode = ComponentSetNode | ComponentNode | InstanceNode;

// ============================================================
// UI
// ============================================================

figma.showUI(__html__, { width: 420, height: 1200 });

// ============================================================
// HELPERS
// ============================================================

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

function postPhase(phase: PipelinePhase, message: string): void {
  figma.ui.postMessage({ type: "phase", phase, message });
}

// ============================================================
// TREE TRAVERSAL
// ============================================================

/**
 * Walks a subtree depth-first.
 * - Calls onInstance for every InstanceNode and does NOT recurse further into it.
 * - Calls onRegular for every other node type and recurses into its children.
 *
 * This guarantees no node is silently skipped.
 */
async function traverseNodeTree(
  root: SceneNode,
  onInstance: (node: InstanceNode) => Promise<void>,
  onRegular:  (node: SceneNode)   => Promise<void>
): Promise<void> {
  if (root.type === "INSTANCE") {
    await onInstance(root as InstanceNode);
    return;
  }
  await onRegular(root);
  if ("children" in root) {
    for (const child of root.children) {
      if (isSceneNode(child)) {
        await traverseNodeTree(child, onInstance, onRegular);
      }
    }
  }
}

/**
 * Walks every node in a subtree, including inside instances.
 * Used only for collecting variable bindings from reference frames.
 */
async function walkAll(
  root: SceneNode,
  callback: (node: SceneNode) => Promise<void>
): Promise<void> {
  await callback(root);
  if ("children" in root) {
    for (const child of root.children) {
      if (isSceneNode(child)) await walkAll(child, callback);
    }
  }
}

// ============================================================
// VARIABLE BINDING EXTRACTION
// ============================================================

/**
 * Extracts all variable bindings present on a node.
 *
 * Handles:
 *   - Scalar boundVariables (spacing, opacity, radius, typography tokens…)
 *   - Fills paint boundVariables
 *   - Strokes paint boundVariables
 *   - Effects boundVariables
 *
 * NOTE on typography variables in TextNode:
 *   Figma stores font-related variable bindings (fontSize, lineHeight, etc.)
 *   directly in node.boundVariables as VARIABLE_ALIAS entries, the same way
 *   it stores spacing/opacity. They are covered by the scalar section below.
 *   No special extraction is needed — the key fix is in applySubstitution:
 *   we must load fonts BEFORE calling setBoundVariable on any TEXT node.
 */
async function extractVariableBindings(node: SceneNode): Promise<VariableBinding[]> {
  const bindings: VariableBinding[] = [];

  // ── 1. Scalar / typography boundVariables ─────────────────────────────
  if ("boundVariables" in node && node.boundVariables) {
    const bv = node.boundVariables as Record<string, any>;
    for (const prop of Object.keys(bv)) {
      // fills / strokes / effects are arrays — handled separately below
      if (prop === "fills" || prop === "strokes" || prop === "effects") continue;

      const alias = bv[prop] as any;
      if (!alias) continue;

      // boundVariables may hold a single alias or an array (for mixed text ranges)
      const aliases: any[] = Array.isArray(alias) ? alias : [alias];
      for (const a of aliases) {
        if (!a || a.type !== "VARIABLE_ALIAS" || !a.id) continue;
        try {
          const variable = await figma.variables.getVariableByIdAsync(a.id);
          if (!variable) continue;
          const collection = await figma.variables.getVariableCollectionByIdAsync(
            variable.variableCollectionId
          );
          bindings.push({
            nodeId: node.id, nodeName: node.name, property: prop,
            variableId: variable.id, variableName: variable.name,
            collectionName: collection?.name ?? "",
          });
        } catch { /* variable inaccessible (external library) */ }
      }
    }
  }

  // ── 2. Fills ───────────────────────────────────────────────────────────
  if ("fills" in node && Array.isArray(node.fills)) {
    for (let i = 0; i < node.fills.length; i++) {
      const paint = node.fills[i] as any;
      if (!paint?.boundVariables) continue;
      for (const subProp of Object.keys(paint.boundVariables)) {
        const alias = paint.boundVariables[subProp] as any;
        if (!alias || alias.type !== "VARIABLE_ALIAS" || !alias.id) continue;
        try {
          const variable = await figma.variables.getVariableByIdAsync(alias.id);
          if (!variable) continue;
          const collection = await figma.variables.getVariableCollectionByIdAsync(
            variable.variableCollectionId
          );
          bindings.push({
            nodeId: node.id, nodeName: node.name,
            property: "fills", paintSubProp: subProp, paintIndex: i,
            variableId: variable.id, variableName: variable.name,
            collectionName: collection?.name ?? "",
          });
        } catch { /* skip */ }
      }
    }
  }

  // ── 3. Strokes ─────────────────────────────────────────────────────────
  if ("strokes" in node && Array.isArray(node.strokes)) {
    for (let i = 0; i < node.strokes.length; i++) {
      const paint = node.strokes[i] as any;
      if (!paint?.boundVariables) continue;
      for (const subProp of Object.keys(paint.boundVariables)) {
        const alias = paint.boundVariables[subProp] as any;
        if (!alias || alias.type !== "VARIABLE_ALIAS" || !alias.id) continue;
        try {
          const variable = await figma.variables.getVariableByIdAsync(alias.id);
          if (!variable) continue;
          const collection = await figma.variables.getVariableCollectionByIdAsync(
            variable.variableCollectionId
          );
          bindings.push({
            nodeId: node.id, nodeName: node.name,
            property: "strokes", paintSubProp: subProp, paintIndex: i,
            variableId: variable.id, variableName: variable.name,
            collectionName: collection?.name ?? "",
          });
        } catch { /* skip */ }
      }
    }
  }

  // ── 4. Effects ─────────────────────────────────────────────────────────
  if ("effects" in node && Array.isArray(node.effects)) {
    for (let i = 0; i < node.effects.length; i++) {
      const effect = node.effects[i] as any;
      if (!effect?.boundVariables) continue;
      for (const subProp of Object.keys(effect.boundVariables)) {
        const alias = effect.boundVariables[subProp] as any;
        if (!alias || alias.type !== "VARIABLE_ALIAS" || !alias.id) continue;
        try {
          const variable = await figma.variables.getVariableByIdAsync(alias.id);
          if (!variable) continue;
          const collection = await figma.variables.getVariableCollectionByIdAsync(
            variable.variableCollectionId
          );
          bindings.push({
            nodeId: node.id, nodeName: node.name,
            property: "effects", paintSubProp: subProp, paintIndex: i,
            variableId: variable.id, variableName: variable.name,
            collectionName: collection?.name ?? "",
          });
        } catch { /* skip */ }
      }
    }
  }

  return bindings;
}

// ============================================================
// FRAME VARIABLE MAP
// ============================================================

/**
 * Walks all reference frames and builds a normalizedName → Variable lookup map.
 * This is the source of truth for what substitutions should be applied.
 */
async function buildFrameVariableMap(frames: FrameNode[]): Promise<Map<string, Variable>> {
  const map = new Map<string, Variable>();
  for (const frame of frames) {
    await walkAll(frame, async (node) => {
      const bindings = await extractVariableBindings(node);
      for (const b of bindings) {
        const key = normalizeName(b.variableName);
        if (!map.has(key)) {
          try {
            const v = await figma.variables.getVariableByIdAsync(b.variableId);
            if (v) map.set(key, v);
          } catch { /* skip */ }
        }
      }
    });
  }
  return map;
}

// ============================================================
// FONT LOADING
// ============================================================

/**
 * Loads all fonts used by a TextNode before any setBoundVariable call.
 * Figma requires fonts to be loaded before modifying text properties —
 * including variable-bound typography tokens.
 */
async function ensureFontsLoaded(node: TextNode): Promise<void> {
  try {
    if (node.fontName === figma.mixed) {
      const fontSet = new Set<string>();
      for (let i = 0; i < node.characters.length; i++) {
        const fn = node.getRangeFontName(i, i + 1);
        if (fn !== figma.mixed) fontSet.add(`${(fn as FontName).family}::${(fn as FontName).style}`);
      }
      await Promise.all(
        Array.from(fontSet).map((key) => {
          const [family, style] = key.split("::");
          return figma.loadFontAsync({ family, style });
        })
      );
    } else {
      await figma.loadFontAsync(node.fontName as FontName);
    }
  } catch (err) {
    console.warn(`ensureFontsLoaded: could not load font for "${node.name}":`, err);
  }
}

// ============================================================
// SUBSTITUTION APPLICATION
// ============================================================

/**
 * Applies a single variable binding substitution to a node.
 * Must never be called on an InstanceNode.
 */
async function applySubstitution(
  node: SceneNode,
  binding: VariableBinding,
  newVariable: Variable
): Promise<boolean> {
  if (node.type === "INSTANCE") return false; // hard guard

  try {
    const { property, paintIndex, paintSubProp } = binding;
    const idx = paintIndex ?? 0;

    // ── Fills ────────────────────────────────────────────────────────────
    if (property === "fills" && "fills" in node && Array.isArray(node.fills)) {
      const paints = [...node.fills] as any[];
      const paint  = paints[idx];
      if (!paint) return false;
      if (paintSubProp === "color" && paint.type === "SOLID") {
        paints[idx] = figma.variables.setBoundVariableForPaint(
          paint as SolidPaint, "color", newVariable
        );
      } else if (paintSubProp) {
        paints[idx] = {
          ...paint,
          boundVariables: { ...paint.boundVariables, [paintSubProp]: { type: "VARIABLE_ALIAS", id: newVariable.id } },
        };
      } else { return false; }
      (node as any).fills = paints;
      return true;
    }

    // ── Strokes ──────────────────────────────────────────────────────────
    if (property === "strokes" && "strokes" in node && Array.isArray(node.strokes)) {
      const paints = [...node.strokes] as any[];
      const paint  = paints[idx];
      if (!paint) return false;
      if (paintSubProp === "color" && paint.type === "SOLID") {
        paints[idx] = figma.variables.setBoundVariableForPaint(
          paint as SolidPaint, "color", newVariable
        );
      } else if (paintSubProp) {
        paints[idx] = {
          ...paint,
          boundVariables: { ...paint.boundVariables, [paintSubProp]: { type: "VARIABLE_ALIAS", id: newVariable.id } },
        };
      } else { return false; }
      (node as any).strokes = paints;
      return true;
    }

    // ── Effects ──────────────────────────────────────────────────────────
    if (property === "effects" && "effects" in node && Array.isArray(node.effects)) {
      const effects = [...node.effects] as any[];
      const effect  = effects[idx];
      if (!effect || !paintSubProp) return false;
      effects[idx] = {
        ...effect,
        boundVariables: { ...effect.boundVariables, [paintSubProp]: { type: "VARIABLE_ALIAS", id: newVariable.id } },
      };
      (node as any).effects = effects;
      return true;
    }

    // ── Typography (TextNode) ────────────────────────────────────────────
    // MUST load fonts before any setBoundVariable call on a TextNode,
    // even for non-character properties like fontSize, lineHeight, etc.
    if (node.type === "TEXT") {
      await ensureFontsLoaded(node as TextNode);
      (node as any).setBoundVariable(property, newVariable);
      return true;
    }

    // ── Generic scalar (spacing, radius, opacity, …) ─────────────────────
    if ("setBoundVariable" in node) {
      (node as any).setBoundVariable(property, newVariable);
      return true;
    }

    return false;
  } catch (err) {
    console.error(`applySubstitution failed on "${node.name}" [${binding.property}]:`, err);
    return false;
  }
}

/**
 * Extracts all bindings from a node and applies any substitution whose
 * variable name matches an entry in frameVarMap (and is actually different).
 */
async function applySubstitutionsToNode(
  node: SceneNode,
  frameVarMap: Map<string, Variable>
): Promise<SubstitutionResult[]> {
  const results: SubstitutionResult[] = [];
  const bindings = await extractVariableBindings(node);

  for (const binding of bindings) {
    const frameVar = frameVarMap.get(normalizeName(binding.variableName));
    if (!frameVar) continue;
    if (frameVar.id === binding.variableId) continue; // already the correct variable

    const ok = await applySubstitution(node, binding, frameVar);
    results.push({
      status: ok ? "success" : "failed",
      nodeId: binding.nodeId, nodeName: binding.nodeName, nodeType: node.type,
      property: binding.property, paintSubProp: binding.paintSubProp, paintIndex: binding.paintIndex,
      oldVariableName: binding.variableName, newVariableName: frameVar.name,
    });
  }

  return results;
}

// ============================================================
// TARGET RESOLUTION
// ============================================================

/**
 * Resolves the list of ComponentNodes to walk from the raw target selection.
 *
 * ComponentSet  → all direct ComponentNode children (variants)
 * ComponentNode → itself
 * InstanceNode  → resolves its main component (so we modify the source, not the instance)
 *
 * Returns both the component list AND the set of their IDs.
 * The ID set is used in Phase 2 to decide whether a discovered instance
 * is "in scope" (main component was selected → skip silently) or
 * "external" (main component not selected → report as ignored).
 */
async function resolveComponentNodes(targets: TargetNode[]): Promise<{
  components: ComponentNode[];
  selectedComponentIds: Set<string>;
}> {
  const components: ComponentNode[] = [];
  const selectedComponentIds = new Set<string>();
  const seen = new Set<string>();

  for (const target of targets) {
    if (target.type === "COMPONENT_SET") {
      for (const child of target.children) {
        if (child.type === "COMPONENT" && !seen.has(child.id)) {
          seen.add(child.id);
          components.push(child);
          selectedComponentIds.add(child.id);
        }
      }
    } else if (target.type === "COMPONENT") {
      if (!seen.has(target.id)) {
        seen.add(target.id);
        components.push(target);
        selectedComponentIds.add(target.id);
      }
    } else if (target.type === "INSTANCE") {
      const main = await target.getMainComponentAsync();
      if (main && !seen.has(main.id)) {
        seen.add(main.id);
        components.push(main);
        selectedComponentIds.add(main.id);
      }
    }
  }

  return { components, selectedComponentIds };
}

// ============================================================
// PHASE 1 — PROCESS COMPONENT NODES
// ============================================================

/**
 * Walks every ComponentNode's subtree.
 *
 * - Non-instance nodes: apply substitutions immediately.
 * - InstanceNodes: collect for Phase 2 classification. Never modify.
 *
 * All instances found are deduplicated by nodeId (the same instance can
 * appear as a child of multiple variants).
 */
async function processComponentNodes(
  components: ComponentNode[],
  frameVarMap: Map<string, Variable>
): Promise<{
  phase1Results:  SubstitutionResult[];
  foundInstances: InstanceNode[];
}> {
  const phase1Results:  SubstitutionResult[] = [];
  const foundInstances: InstanceNode[]       = [];
  const seenInstanceIds = new Set<string>();

  for (const component of components) {
    await traverseNodeTree(
      component,
      // onInstance — queue for Phase 2, never touch
      async (inst) => {
        if (seenInstanceIds.has(inst.id)) return;
        seenInstanceIds.add(inst.id);
        foundInstances.push(inst);
      },
      // onRegular — apply substitutions
      async (node) => {
        const results = await applySubstitutionsToNode(node, frameVarMap);
        phase1Results.push(...results);
      }
    );
  }

  return { phase1Results, foundInstances };
}

// ============================================================
// PHASE 2 — CLASSIFY & REPORT INSTANCES
// ============================================================

/**
 * Classifies each instance found during Phase 1.
 *
 * RULE: An instance is only reported as "ignored" if its main component
 * is NOT in the selectedComponentIds set (i.e. it's an external component
 * whose source we don't control in this run).
 *
 * If the main component IS in scope, the substitutions have already been
 * applied to it in Phase 1 — the instance will inherit them automatically
 * through Figma's normal override propagation. We do NOT report those.
 *
 * This prevents the false-positive "ignored" entries that confused the user.
 */
async function processInstanceNodes(
  instances: InstanceNode[],
  selectedComponentIds: Set<string>
): Promise<SubstitutionResult[]> {
  const results: SubstitutionResult[] = [];

  for (const node of instances) {
    let mainComponent: ComponentNode | null = null;
    try {
      mainComponent = await node.getMainComponentAsync();
    } catch { /* external / inaccessible */ }

    const mainId   = mainComponent?.id ?? null;
    const inScope  = mainId !== null && selectedComponentIds.has(mainId);

    // If the main component was processed in Phase 1 → skip silently.
    // The instance will inherit the changes automatically.
    if (inScope) continue;

    // Only external / out-of-scope instances are reported.
    results.push({
      status: "skipped_instance",
      nodeId: node.id,
      nodeName: node.name,
      nodeType: "INSTANCE",
      property: "—",
      oldVariableName: "—",
      newVariableName: undefined,
    });
  }

  return results;
}

// ============================================================
// REPORT ASSEMBLY
// ============================================================

interface PipelineReport {
  phase1Results: SubstitutionResult[];
  phase2Results: SubstitutionResult[];  // kept for UI compatibility (instances)
  successCount:  number;
  failedCount:   number;
  skippedCount:  number;
  total:         number;
}

function generateReport(
  phase1Results: SubstitutionResult[],
  instanceResults: SubstitutionResult[]
): PipelineReport {
  const successCount = phase1Results.filter(r => r.status === "success").length;
  const failedCount  = phase1Results.filter(r => r.status === "failed").length;
  const skippedCount = instanceResults.length;

  return {
    phase1Results,
    phase2Results: instanceResults,  // UI reads from phase2Results for the skip panel
    successCount,
    failedCount,
    skippedCount,
    total: successCount + failedCount + skippedCount,
  };
}

// ============================================================
// PIPELINE ORCHESTRATOR
// ============================================================

async function runPipeline(
  targets: TargetNode[],
  frames: FrameNode[]
): Promise<PipelineReport> {

  // ── Collect frame variable map ──────────────────────────────────────────
  postPhase("collecting", "Coletando variáveis dos frames de referência...");
  const frameVarMap = await buildFrameVariableMap(frames);
  postPhase("collecting", `${frameVarMap.size} variável(eis) encontrada(s) nos frames.`);

  // ── Resolve component nodes ─────────────────────────────────────────────
  const { components, selectedComponentIds } = await resolveComponentNodes(targets);

  // ── Phase 1: Apply substitutions to component subtrees ─────────────────
  postPhase("phase1_components",
    `Fase 1 — Aplicando substituições em ${components.length} componente(s)...`);

  const { phase1Results, foundInstances } =
    await processComponentNodes(components, frameVarMap);

  const p1Success = phase1Results.filter(r => r.status === "success").length;
  postPhase("phase1_components",
    `Fase 1 concluída — ${p1Success} substituição(ões) aplicada(s).`);

  // ── Phase 2: Classify instances ─────────────────────────────────────────
  postPhase("phase2_instances",
    `Fase 2 — Classificando ${foundInstances.length} instância(s)...`);

  const instanceResults = await processInstanceNodes(foundInstances, selectedComponentIds);

  postPhase("done",
    `Concluído — ${instanceResults.length} instância(s) externa(s) ignorada(s).`);

  return generateReport(phase1Results, instanceResults);
}

// ============================================================
// SELECTION ANALYSIS
// ============================================================

async function analyzeSelection(): Promise<void> {
  const selection = figma.currentPage.selection;
  const targets: TargetNode[] = [];
  const frames:  FrameNode[]  = [];

  for (const node of selection) {
    if (
      node.type === "COMPONENT_SET" ||
      node.type === "COMPONENT" ||
      node.type === "INSTANCE"
    ) {
      targets.push(node as TargetNode);
    } else if (node.type === "FRAME") {
      frames.push(node);
    }
  }

  const targetInfos = await Promise.all(
    targets.map(async (t) => {
      if (t.type === "COMPONENT_SET") {
        const variantCount = t.children.filter(c => c.type === "COMPONENT").length;
        return { id: t.id, name: t.name, type: t.type, variantCount };
      }
      if (t.type === "INSTANCE") {
        const main = await t.getMainComponentAsync();
        return {
          id: t.id, name: t.name, type: t.type, variantCount: 1,
          mainName: main?.name ?? "(componente não encontrado)",
        };
      }
      return { id: t.id, name: t.name, type: t.type, variantCount: 1 };
    })
  );

  figma.ui.postMessage({
    type: "selection",
    targets: targetInfos,
    frames: frames.map(f => ({ id: f.id, name: f.name })),
  });
}

// ============================================================
// EVENT HANDLERS
// ============================================================

figma.on("selectionchange", () => { analyzeSelection(); });

figma.ui.onmessage = async (msg) => {

  // ── RUN ──────────────────────────────────────────────────────────────────
  if (msg.type === "run") {
    const selection = figma.currentPage.selection;
    const targets: TargetNode[] = [];
    const frames:  FrameNode[]  = [];

    for (const node of selection) {
      if (
        node.type === "COMPONENT_SET" ||
        node.type === "COMPONENT" ||
        node.type === "INSTANCE"
      ) {
        targets.push(node as TargetNode);
      } else if (node.type === "FRAME") {
        frames.push(node);
      }
    }

    if (targets.length === 0) {
      figma.ui.postMessage({ type: "error",
        message: "Selecione pelo menos um Component Set, Component ou Instance como destino." });
      return;
    }
    if (frames.length === 0) {
      figma.ui.postMessage({ type: "error",
        message: "Selecione pelo menos um Frame como origem das variáveis." });
      return;
    }

    try {
      const report = await runPipeline(targets, frames);
      figma.ui.postMessage({ type: "done", ...report });
    } catch (err) {
      console.error("Pipeline error:", err);
      figma.ui.postMessage({ type: "error", message: String(err) });
    }
  }

  // ── ANALYZE ───────────────────────────────────────────────────────────────
  if (msg.type === "analyze") {
    await analyzeSelection();
  }

  // ── SELECT NODES ──────────────────────────────────────────────────────────
  if (msg.type === "select-nodes") {
    const ids: string[] = msg.nodeIds ?? [];
    const nodes: SceneNode[] = [];
    for (const id of ids) {
      try {
        const node = await figma.getNodeByIdAsync(id);
        if (node && isSceneNode(node)) nodes.push(node);
      } catch { /* node removed */ }
    }
    figma.currentPage.selection = nodes;
    if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);
  }
};

// ============================================================
// INIT
// ============================================================

(async () => { await analyzeSelection(); })();

console.log("Variable Substitution Plugin iniciado ✅");