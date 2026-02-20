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
  | "phase3_swap"
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

// ── Swap pipeline types ────────────────────────────────────────────────────

type SwapStatus = "swapped" | "not_found" | "already_local" | "no_main";

interface SwapResult {
  status: SwapStatus;
  nodeId: string;
  nodeName: string;
  mainComponentName: string;
  localComponentId?: string;
}

interface SwapReport {
  swapped: SwapResult[];
  ignored: SwapResult[];
  total: number;
}

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

async function traverseNodeTree(
  root: SceneNode,
  onInstance: (node: InstanceNode) => Promise<void>,
  onRegular: (node: SceneNode) => Promise<void>
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

async function extractVariableBindings(node: SceneNode): Promise<VariableBinding[]> {
  const bindings: VariableBinding[] = [];

  // ── 1. Scalar / typography boundVariables ─────────────────────────────
  if ("boundVariables" in node && node.boundVariables) {
    const bv = node.boundVariables as Record<string, any>;
    for (const prop of Object.keys(bv)) {
      if (prop === "fills" || prop === "strokes" || prop === "effects") continue;

      const alias = bv[prop] as any;
      if (!alias) continue;

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
        } catch { /* variable inaccessible */ }
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

  // ── 4b. effectStyleId (Effect Styles from external libraries) ────────────
  // Same pattern as textStyleId: boundVariables is empty, the binding lives in
  // effectStyleId. We resolve the style name and emit a synthetic binding.
  if ("effectStyleId" in node) {
    const styleId = (node as any).effectStyleId as string;
    if (styleId && styleId.length > 0) {
      try {
        const style = await figma.getStyleByIdAsync(styleId);
        if (style && style.name) {
          bindings.push({
            nodeId: node.id, nodeName: node.name,
            property: "effectStyleId",
            variableId: styleId,
            variableName: style.name,
            collectionName: "EffectStyle",
          });
        }
      } catch { /* style inaccessible */ }
    }
  }

  // ── 5. TextNode typography variables — full debug probe ──────────────
  if (node.type === "TEXT") {
    const textNode = node as TextNode;

    // ── Typography via textStyleId ────────────────────────────────────────
    // Figma does NOT expose typography variable bindings in boundVariables
    // for text nodes — especially from external libraries.
    // The only mechanism is: a Text Style is applied (textStyleId), and that
    // style was created/bound to a variable collection in the library.
    // We surface the textStyleId as a synthetic binding keyed by the style name,
    // so the frame-map lookup can match by normalized style name.
    //
    // getStyledTextSegments only accepts these fields: fontSize, lineHeight,
    // letterSpacing, paragraphSpacing, paragraphIndent, fontName, fontWeight,
    // fontStyle, textCase, textDecoration, fills, textStyleId, fillStyleId,
    // boundVariables. fontFamily is NOT valid.
    const VALID_SEGMENT_FIELDS: any[] = [
      "fontSize", "lineHeight", "letterSpacing",
      "paragraphSpacing", "paragraphIndent",
      "fontName", "fontWeight", "fontStyle",
      "textStyleId", "boundVariables",
    ];

    const seenKeys = new Set(bindings.map(b => b.variableId + "|" + b.property));

    try {
      const segments = textNode.getStyledTextSegments(VALID_SEGMENT_FIELDS);
      for (const seg of segments) {
        const s = seg as any;

        // 1. Real variable alias in segment boundVariables (scalar typo tokens)
        if (s.boundVariables && typeof s.boundVariables === "object") {
          for (const prop of Object.keys(s.boundVariables)) {
            const alias = s.boundVariables[prop] as any;
            if (!alias) continue;
            const aliases: any[] = Array.isArray(alias) ? alias : [alias];
            for (const a of aliases) {
              if (!a || a.type !== "VARIABLE_ALIAS" || !a.id) continue;
              const dk = a.id + "|" + prop;
              if (seenKeys.has(dk)) continue;
              seenKeys.add(dk);
              try {
                const variable = await figma.variables.getVariableByIdAsync(a.id);
                if (!variable) continue;
                const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
                bindings.push({ nodeId: node.id, nodeName: node.name, property: prop, variableId: variable.id, variableName: variable.name, collectionName: collection?.name ?? "" });
              } catch { /* inaccessible */ }
            }
          }
        }

        // 2. textStyleId — resolve the style and treat its name as the variable name
        // This is how "Paragraph/XXS" applied from a library surfaces in the plugin.
        if (s.textStyleId && typeof s.textStyleId === "string") {
          const styleId = s.textStyleId as string;
          const dk = "style|" + styleId;
          if (!seenKeys.has(dk)) {
            seenKeys.add(dk);
            try {
              const style = await figma.getStyleByIdAsync(styleId);
              if (style && style.name) {
                // Emit a synthetic binding: variableId = styleId, variableName = style.name
                // applySubstitution will handle property === "textStyleId" specially.
                bindings.push({
                  nodeId: node.id, nodeName: node.name,
                  property: "textStyleId",
                  variableId: styleId,
                  variableName: style.name,
                  collectionName: "TextStyle",
                });
              }
            } catch { /* style inaccessible */ }
          }
        }
      }
    } catch { /* getStyledTextSegments failed */ }
  }

  return bindings;
}

// ============================================================
// FRAME VARIABLE MAP  +  FRAME STYLE MAP
// ============================================================

// Two maps are built from the reference frames:
//   frameVarMap   — normalized variable name  → Variable   (colors, spacing, etc.)
//   frameStyleMap — normalized style name     → styleId    (text styles / typography)
//
// Text style bindings use property="textStyleId" and their variableId IS the styleId.
// They cannot go through figma.variables.getVariableByIdAsync, so they live separately.

interface FrameMaps {
  varMap: Map<string, Variable>;
  styleMap: Map<string, string>;  // normalizedName → styleId
}

async function buildFrameMaps(frames: FrameNode[]): Promise<FrameMaps> {
  const varMap = new Map<string, Variable>();
  const styleMap = new Map<string, string>();

  for (const frame of frames) {
    await walkAll(frame, async (node) => {
      const bindings = await extractVariableBindings(node);
      for (const b of bindings) {
        const key = normalizeName(b.variableName);

        if (b.property === "textStyleId" || b.property === "effectStyleId") {
          // b.variableId holds the styleId
          if (!styleMap.has(key)) styleMap.set(key, b.variableId);
        } else {
          if (!varMap.has(key)) {
            try {
              const v = await figma.variables.getVariableByIdAsync(b.variableId);
              if (v) varMap.set(key, v);
            } catch { /* skip */ }
          }
        }
      }
    });
  }
  return { varMap, styleMap };
}

// ============================================================
// FONT LOADING
// ============================================================

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
 *
 * Fills / Strokes  → figma.variables.setBoundVariableForPaint  (same as before ✅)
 * Effects          → figma.variables.setBoundVariableForEffect  (NEW — mirrors paint API)
 * Typography       → load fonts first, then node.setBoundVariable (same scalar path)
 * Generic scalars  → node.setBoundVariable
 */
async function applySubstitution(
  node: SceneNode,
  binding: VariableBinding,
  newVariable: Variable
): Promise<boolean> {
  if (node.type === "INSTANCE") return false;

  try {
    const { property, paintIndex, paintSubProp } = binding;
    const idx = paintIndex ?? 0;

    // ── Fills ────────────────────────────────────────────────────────────
    if (property === "fills" && "fills" in node && Array.isArray(node.fills)) {
      const paints = [...node.fills] as any[];
      const paint = paints[idx];
      if (!paint) return false;

      if (paintSubProp === "color" && paint.type === "SOLID") {
        paints[idx] = figma.variables.setBoundVariableForPaint(
          paint as SolidPaint, "color", newVariable
        );
      } else if (paintSubProp) {
        // opacity and any other paint sub-property: manual boundVariables spread
        paints[idx] = {
          ...paint,
          boundVariables: {
            ...paint.boundVariables,
            [paintSubProp]: { type: "VARIABLE_ALIAS", id: newVariable.id },
          },
        };
      } else {
        return false;
      }
      (node as any).fills = paints;
      return true;
    }

    // ── Strokes ──────────────────────────────────────────────────────────
    if (property === "strokes" && "strokes" in node && Array.isArray(node.strokes)) {
      const paints = [...node.strokes] as any[];
      const paint = paints[idx];
      if (!paint) return false;

      if (paintSubProp === "color" && paint.type === "SOLID") {
        paints[idx] = figma.variables.setBoundVariableForPaint(
          paint as SolidPaint, "color", newVariable
        );
      } else if (paintSubProp) {
        // opacity and any other paint sub-property: manual boundVariables spread
        paints[idx] = {
          ...paint,
          boundVariables: {
            ...paint.boundVariables,
            [paintSubProp]: { type: "VARIABLE_ALIAS", id: newVariable.id },
          },
        };
      } else {
        return false;
      }
      (node as any).strokes = paints;
      return true;
    }

    // ── Effects ───────────────────────────────────────────────────────────
    // MUST use setBoundVariableForEffect — manual spread does NOT persist in Figma.
    // This mirrors exactly how setBoundVariableForPaint works for fills/strokes.
    if (property === "effects" && "effects" in node && Array.isArray(node.effects)) {
      const effects = [...node.effects] as Effect[];
      const effect = effects[idx];
      if (!effect || !paintSubProp) return false;

      // setBoundVariableForEffect is the correct API (available since plugin API 1.0)
      const updatedEffect = figma.variables.setBoundVariableForEffect(
        effect,
        paintSubProp as VariableBindableEffectField,
        newVariable
      );
      effects[idx] = updatedEffect;
      (node as any).effects = effects;
      return true;
    }

    // ── Typography (TextNode) ─────────────────────────────────────────────
    if (node.type === "TEXT") {
      await ensureFontsLoaded(node as TextNode);

      // Scalar typography variable (fontSize, lineHeight, etc.)
      (node as TextNode).setBoundVariable(
        property as VariableBindableTextField,
        newVariable
      );
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

async function applySubstitutionsToNode(
  node: SceneNode,
  maps: FrameMaps
): Promise<SubstitutionResult[]> {
  const results: SubstitutionResult[] = [];
  const bindings = await extractVariableBindings(node);

  for (const binding of bindings) {
    const key = normalizeName(binding.variableName);

    if (binding.property === "textStyleId") {
      const targetStyleId = maps.styleMap.get(key);
      if (!targetStyleId) continue;
      if (targetStyleId === binding.variableId) continue;

      let ok = false;
      try {
        await ensureFontsLoaded(node as TextNode);
        await (node as TextNode).setTextStyleIdAsync(targetStyleId);
        ok = true;
      } catch (err) {
        console.error(`textStyleId swap failed on "${node.name}":`, err);
      }
      results.push({
        status: ok ? "success" : "failed",
        nodeId: binding.nodeId, nodeName: binding.nodeName, nodeType: node.type,
        property: "textStyleId",
        oldVariableName: binding.variableName,
        newVariableName: binding.variableName,
      });
      continue;
    }

    if (binding.property === "effectStyleId") {
      const targetStyleId = maps.styleMap.get(key);
      if (!targetStyleId) continue;
      if (targetStyleId === binding.variableId) continue;

      let ok = false;
      try {
        await (node as any).setEffectStyleIdAsync(targetStyleId);
        ok = true;
      } catch (err) {
        console.error(`effectStyleId swap failed on "${node.name}":`, err);
      }
      results.push({
        status: ok ? "success" : "failed",
        nodeId: binding.nodeId, nodeName: binding.nodeName, nodeType: node.type,
        property: "effectStyleId",
        oldVariableName: binding.variableName,
        newVariableName: binding.variableName,
      });
      continue;
    }

    // Regular variable substitution
    const frameVar = maps.varMap.get(key);
    if (!frameVar) continue;
    if (frameVar.id === binding.variableId) continue;

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

async function processComponentNodes(
  components: ComponentNode[],
  maps: FrameMaps
): Promise<{
  phase1Results: SubstitutionResult[];
  foundInstances: InstanceNode[];
}> {
  const phase1Results: SubstitutionResult[] = [];
  const foundInstances: InstanceNode[] = [];
  const seenInstanceIds = new Set<string>();

  for (const component of components) {
    await traverseNodeTree(
      component,
      async (inst) => {
        if (seenInstanceIds.has(inst.id)) return;
        seenInstanceIds.add(inst.id);
        foundInstances.push(inst);
      },
      async (node) => {
        const results = await applySubstitutionsToNode(node, maps);
        phase1Results.push(...results);
      }
    );
  }

  return { phase1Results, foundInstances };
}

// ============================================================
// PHASE 2 — CLASSIFY & REPORT INSTANCES
// ============================================================

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

    const mainId = mainComponent?.id ?? null;
    const inScope = mainId !== null && selectedComponentIds.has(mainId);

    if (inScope) continue;

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
  phase2Results: SubstitutionResult[];
  swapResults: SwapResult[];
  swapMissing: SwapResult[];
  successCount: number;
  failedCount: number;
  skippedCount: number;
  total: number;
}

function generateReport(
  phase1Results: SubstitutionResult[],
  instanceResults: SubstitutionResult[],
  swapResults: SwapResult[],
  swapMissing: SwapResult[]
): PipelineReport {
  const successCount = phase1Results.filter(r => r.status === "success").length;
  const failedCount = phase1Results.filter(r => r.status === "failed").length;
  const skippedCount = instanceResults.length + swapMissing.length;

  return {
    phase1Results,
    phase2Results: instanceResults,
    swapResults,
    swapMissing,
    successCount,
    failedCount,
    skippedCount,
    total: successCount + failedCount + skippedCount + swapResults.length,
  };
}

// ============================================================
// FASE 3 — Swap de componentes remotos → locais
// ============================================================

/**
 * Builds a map of local component name → ComponentNode.
 * Uses loadAllPagesAsync() as required by documentAccess: dynamic-page,
 * then scans every page for COMPONENT nodes with remote === false.
 */
async function buildLocalComponentMap(): Promise<Map<string, ComponentNode>> {
  await figma.loadAllPagesAsync();
  const map = new Map<string, ComponentNode>();
  for (const page of figma.root.children) {
    const locals = page.findAll(
      (n) => n.type === "COMPONENT" && !(n as ComponentNode).remote
    ) as ComponentNode[];
    for (const c of locals) {
      if (!map.has(c.name)) map.set(c.name, c);
    }
  }
  return map;
}

/**
 * Runs the swap phase on the already-resolved component list.
 * Iterates all InstanceNodes inside each component; for each remote one,
 * tries to find a local equivalent by name and swaps.
 */
async function runSwapPhase(selectedComponent: ComponentNode) {
  await figma.loadAllPagesAsync();
  const swapped: any[] = [];
  const ignored: any[] = [];

  // 🔎 Instâncias corretamente tipadas
  const instances = selectedComponent.findAll(
    node => node.type === "INSTANCE"
  ) as InstanceNode[];

  // 🔎 Componentes locais corretamente tipados
  const localComponents = figma.root.findAll(
    (node): node is ComponentNode =>
      node.type === "COMPONENT" && node.remote === false
  );

  // 🔥 Mapa tipado corretamente
  const localComponentMap = new Map<string, ComponentNode>();
  for (const comp of localComponents) {
    localComponentMap.set(comp.name, comp as ComponentNode);
  }

  for (const inst of instances) {
    try {
      if (inst.removed) continue;

      const main = inst.mainComponent;
      if (!main) {
        ignored.push({
          status: "no_main",
          nodeId: inst.id,
          nodeName: inst.name,
        });
        continue;
      }

      if (!main.remote) {
        ignored.push({
          status: "already_local",
          nodeId: inst.id,
          nodeName: inst.name,
        });
        continue;
      }

      // 🔐 Captura antes do swap
      const instId = inst.id;
      const instName = inst.name;
      const mainName = main.name;

      const localEquivalent = localComponentMap.get(mainName);

      if (!localEquivalent) {
        ignored.push({
          status: "not_found",
          nodeId: instId,
          nodeName: instName,
          mainComponentName: mainName,
        });
        continue;
      }

      try {
        inst.swapComponent(localEquivalent);

        swapped.push({
          status: "swapped",
          nodeId: instId,
          nodeName: instName,
          mainComponentName: mainName,
        });
      } catch (err) {
        ignored.push({
          status: "swap_error",
          nodeId: instId,
          nodeName: instName,
          error: String(err),
        });
      }
    } catch (err) {
      ignored.push({
        status: "unexpected_error",
        nodeId: inst.id,
        nodeName: inst.name,
        error: String(err),
      });
    }
  }

  return { swapped, ignored };
}

// ============================================================
// PIPELINE ORCHESTRATOR
// ============================================================

async function runPipeline(
  targets: TargetNode[],
  frames: FrameNode[]
): Promise<PipelineReport> {

  // ── Fase 0: Coleta de variáveis ──────────────────────────
  postPhase("collecting", "Coletando variáveis dos frames de referência...");
  const maps = await buildFrameMaps(frames);
  const totalMapped = maps.varMap.size + maps.styleMap.size;
  postPhase("collecting",
    `${totalMapped} token(s) encontrado(s) (${maps.varMap.size} variáveis, ${maps.styleMap.size} estilos).`);

  const { components, selectedComponentIds } = await resolveComponentNodes(targets);

  // ── Fase 1: Substituição de variáveis ────────────────────
  postPhase("phase1_components",
    `Fase 1 — Aplicando substituições em ${components.length} componente(s)...`);
  const { phase1Results, foundInstances } =
    await processComponentNodes(components, maps);
  const p1Success = phase1Results.filter(r => r.status === "success").length;
  postPhase("phase1_components",
    `Fase 1 concluída — ${p1Success} substituição(ões) aplicada(s).`);

  // ── Fase 2: Instâncias externas ──────────────────────────
  postPhase("phase2_instances",
    `Fase 2 — Classificando ${foundInstances.length} instância(s)...`);
  const instanceResults = await processInstanceNodes(foundInstances, selectedComponentIds);
  postPhase("phase2_instances",
    `Fase 2 concluída — ${instanceResults.length} instância(s) externa(s).`);

  // ── Fase 3: Swap de componentes remotos ──────────────────
  let swapped: any[] = [];
let ignored: any[] = [];

for (const comp of components) {
  const result = await runSwapPhase(comp as ComponentNode);
  swapped.push(...result.swapped);
  ignored.push(...result.ignored);
}
  postPhase("done",
    `Concluído — ${swapped.length} swap(s), ${ignored.length} sem equivalente local.`);

  return generateReport(phase1Results, instanceResults, swapped, ignored);
}

// ============================================================
// SELECTION ANALYSIS
// ============================================================

async function analyzeSelection(): Promise<void> {
  const selection = figma.currentPage.selection;
  const targets: TargetNode[] = [];
  const frames: FrameNode[] = [];

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

  if (msg.type === "run") {
    const selection = figma.currentPage.selection;
    const targets: TargetNode[] = [];
    const frames: FrameNode[] = [];

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
      figma.ui.postMessage({
        type: "error",
        message: "Selecione pelo menos um Component Set, Component ou Instance como destino."
      });
      return;
    }
    if (frames.length === 0) {
      figma.ui.postMessage({
        type: "error",
        message: "Selecione pelo menos um Frame como origem das variáveis."
      });
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

  if (msg.type === "analyze") {
    await analyzeSelection();
  }

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