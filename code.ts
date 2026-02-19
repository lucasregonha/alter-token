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
  reason?: string;
}

// Typography scalar props Figma supports via setBoundVariable on TextNode
const FONT_PROPS = new Set([
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
  "characters",
]);

// Accepted target node types
type TargetNode = ComponentSetNode | ComponentNode | InstanceNode;

// ============================================================
// UI
// ============================================================

figma.showUI(__html__, { width: 420, height: 560 });

// ============================================================
// HELPERS
// ============================================================

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

/**
 * Walks a component subtree.
 * Stops descending when it hits an InstanceNode — instances are opaque.
 * Calls callback on every node INCLUDING instances (so we can report them),
 * but does not recurse into their children.
 */
async function walkComponents(
  root: SceneNode,
  callback: (node: SceneNode) => Promise<void>
): Promise<void> {
  await callback(root);
  if (root.type === "INSTANCE") return; // do not walk inside instances
  if ("children" in root) {
    for (const child of root.children) {
      if (isSceneNode(child)) {
        await walkComponents(child, callback);
      }
    }
  }
}

/**
 * Walks any subtree fully (used for frames, where we want every binding).
 */
async function walkAll(
  root: SceneNode,
  callback: (node: SceneNode) => Promise<void>
): Promise<void> {
  await callback(root);
  if ("children" in root) {
    for (const child of root.children) {
      if (isSceneNode(child)) {
        await walkAll(child, callback);
      }
    }
  }
}

// ============================================================
// EXTRACTION
// ============================================================

async function extractVariableBindings(node: SceneNode): Promise<VariableBinding[]> {
  const bindings: VariableBinding[] = [];

  // ── 1. Scalar node.boundVariables ──────────────────────────────────────
  if ("boundVariables" in node && node.boundVariables) {
    const bv = node.boundVariables as Record<string, any>;
    for (const prop of Object.keys(bv)) {
      if (prop === "fills" || prop === "strokes" || prop === "effects") continue;
      const alias = bv[prop] as any;
      if (!alias || alias.type !== "VARIABLE_ALIAS" || !alias.id) continue;
      try {
        const variable = await figma.variables.getVariableByIdAsync(alias.id);
        if (!variable) continue;
        const collection = await figma.variables.getVariableCollectionByIdAsync(
          variable.variableCollectionId
        );
        bindings.push({
          nodeId: node.id, nodeName: node.name, property: prop,
          variableId: variable.id, variableName: variable.name,
          collectionName: collection?.name ?? "",
        });
      } catch { /* inaccessible */ }
    }
  }

  // ── 2. Fills ────────────────────────────────────────────────────────────
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

  // ── 3. Strokes ──────────────────────────────────────────────────────────
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

  // ── 4. Effects ──────────────────────────────────────────────────────────
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
// MAPPING
// ============================================================

async function buildNameToVariableMap(
  bindings: VariableBinding[]
): Promise<Map<string, Variable>> {
  const map = new Map<string, Variable>();
  for (const b of bindings) {
    const key = normalizeName(b.variableName);
    if (!map.has(key)) {
      try {
        const v = await figma.variables.getVariableByIdAsync(b.variableId);
        if (v) map.set(key, v);
      } catch { /* skip */ }
    }
  }
  return map;
}

// ============================================================
// APPLICATION
// ============================================================

async function ensureFontLoaded(node: TextNode): Promise<void> {
  if (node.fontName === figma.mixed) {
    const fontSet = new Set<string>();
    for (let i = 0; i < node.characters.length; i++) {
      const fn = node.getRangeFontName(i, i + 1);
      if (fn !== figma.mixed) fontSet.add(`${fn.family}::${fn.style}`);
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
}

async function applySubstitution(
  node: SceneNode,
  binding: VariableBinding,
  newVariable: Variable
): Promise<boolean> {
  // NEVER modify instances
  if (node.type === "INSTANCE") return false;

  try {
    const { property, paintIndex, paintSubProp } = binding;
    const idx = paintIndex ?? 0;

    // ── Fills ──────────────────────────────────────────────────────────────
    if (property === "fills" && "fills" in node && Array.isArray(node.fills)) {
      const paints = [...node.fills] as any[];
      const paint = paints[idx];
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
      } else {
        return false;
      }
      (node as any).fills = paints;
      return true;
    }

    // ── Strokes ────────────────────────────────────────────────────────────
    if (property === "strokes" && "strokes" in node && Array.isArray(node.strokes)) {
      const paints = [...node.strokes] as any[];
      const paint = paints[idx];
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
      } else {
        return false;
      }
      (node as any).strokes = paints;
      return true;
    }

    // ── Effects ────────────────────────────────────────────────────────────
    if (property === "effects" && "effects" in node && Array.isArray(node.effects)) {
      const effects = [...node.effects] as any[];
      const effect = effects[idx];
      if (!effect || !paintSubProp) return false;
      effects[idx] = {
        ...effect,
        boundVariables: { ...effect.boundVariables, [paintSubProp]: { type: "VARIABLE_ALIAS", id: newVariable.id } },
      };
      (node as any).effects = effects;
      return true;
    }

    // ── Typography scalars on TextNode ─────────────────────────────────────
    if (node.type === "TEXT") {
      if (FONT_PROPS.has(property)) {
        try { await ensureFontLoaded(node as TextNode); } catch { /* best effort */ }
      }
      if ("setBoundVariable" in node) {
        (node as any).setBoundVariable(property, newVariable);
        return true;
      }
      return false;
    }

    // ── Generic scalar ─────────────────────────────────────────────────────
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

// ============================================================
// TARGET RESOLUTION
// ============================================================

/**
 * Resolves the list of ComponentNodes to walk from a target selection.
 * - ComponentSet  → all direct ComponentNode children (variants)
 * - ComponentNode → itself
 * - InstanceNode  → resolve main component via getMainComponentAsync (async-safe)
 */
async function resolveComponentNodes(
  targets: TargetNode[]
): Promise<{ components: ComponentNode[]; selectedComponentIds: Set<string> }> {
  const components: ComponentNode[] = [];
  const selectedComponentIds = new Set<string>();

  for (const target of targets) {
    if (target.type === "COMPONENT_SET") {
      for (const child of target.children) {
        if (child.type === "COMPONENT") {
          components.push(child);
          selectedComponentIds.add(child.id);
        }
      }
    } else if (target.type === "COMPONENT") {
      components.push(target);
      selectedComponentIds.add(target.id);
    } else if (target.type === "INSTANCE") {
      // Use async version to avoid documentAccess error
      const main = await target.getMainComponentAsync();
      if (main) {
        components.push(main);
        selectedComponentIds.add(main.id);
      }
    }
  }

  return { components, selectedComponentIds };
}

// ============================================================
// MAIN SUBSTITUTION LOGIC
// ============================================================

async function runSubstitution(
  targets: TargetNode[],
  frames: FrameNode[]
): Promise<SubstitutionResult[]> {
  // ── Step 1: collect frame bindings and build name map ─────────────────
  figma.ui.postMessage({ type: "status", message: "Coletando variáveis dos frames..." });

  const frameBindings: VariableBinding[] = [];
  for (const frame of frames) {
    await walkAll(frame, async (node) => {
      frameBindings.push(...(await extractVariableBindings(node)));
    });
  }

  const frameVarMap = await buildNameToVariableMap(frameBindings);

  figma.ui.postMessage({
    type: "status",
    message: `${frameVarMap.size} variáveis únicas nos frames. Resolvendo componentes...`,
  });

  // ── Step 2: resolve component nodes from targets ──────────────────────
  const { components, selectedComponentIds } = await resolveComponentNodes(targets);

  figma.ui.postMessage({
    type: "status",
    message: `${components.length} componente(s) encontrado(s). Aplicando substituições...`,
  });

  // ── Step 3: walk and substitute ───────────────────────────────────────
  const results: SubstitutionResult[] = [];

  for (const component of components) {
    await walkComponents(component, async (node) => {

      // ── Instance encountered inside component ────────────────────────
      if (node.type === "INSTANCE") {
        // Use async-safe version
        const mainComponent = await node.getMainComponentAsync();
        const mainId = mainComponent?.id ?? null;
        const inScope = mainId ? selectedComponentIds.has(mainId) : false;

        const instanceBindings = await extractVariableBindings(node);
        const matchingBindings = instanceBindings.filter((b) => {
          const frameVar = frameVarMap.get(normalizeName(b.variableName));
          return frameVar && frameVar.id !== b.variableId;
        });

        if (matchingBindings.length === 0) return;

        const reason = inScope
          ? "Instância ignorada — componente pai selecionado, herança aplicada automaticamente"
          : "Instância ignorada — componente não está na seleção";

        for (const b of matchingBindings) {
          const frameVar = frameVarMap.get(normalizeName(b.variableName))!;
          results.push({
            status: "skipped_instance",
            nodeId: node.id, nodeName: node.name, nodeType: node.type,
            property: b.property, paintSubProp: b.paintSubProp, paintIndex: b.paintIndex,
            oldVariableName: b.variableName, newVariableName: frameVar.name,
            reason,
          });
        }
        return;
      }

      // ── Regular node ─────────────────────────────────────────────────
      const bindings = await extractVariableBindings(node);

      for (const binding of bindings) {
        const key = normalizeName(binding.variableName);
        const frameVariable = frameVarMap.get(key);
        if (!frameVariable) continue;
        if (frameVariable.id === binding.variableId) continue;

        const success = await applySubstitution(node, binding, frameVariable);

        results.push({
          status: success ? "success" : "failed",
          nodeId: binding.nodeId, nodeName: binding.nodeName, nodeType: node.type,
          property: binding.property, paintSubProp: binding.paintSubProp,
          paintIndex: binding.paintIndex,
          oldVariableName: binding.variableName,
          newVariableName: frameVariable.name,
        });
      }
    });
  }

  return results;
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

  // Build display info for each target
  const targetInfos = await Promise.all(
    targets.map(async (t) => {
      if (t.type === "COMPONENT_SET") {
        const variantCount = t.children.filter((c) => c.type === "COMPONENT").length;
        return { id: t.id, name: t.name, type: t.type, variantCount };
      }
      if (t.type === "INSTANCE") {
        const main = await t.getMainComponentAsync();
        return {
          id: t.id,
          name: t.name,
          type: t.type,
          variantCount: 1,
          mainName: main?.name ?? "(componente não encontrado)",
        };
      }
      // COMPONENT
      return { id: t.id, name: t.name, type: t.type, variantCount: 1 };
    })
  );

  figma.ui.postMessage({
    type: "selection",
    targets: targetInfos,
    frames: frames.map((f) => ({ id: f.id, name: f.name })),
  });
}

// ============================================================
// EVENTS
// ============================================================

figma.on("selectionchange", () => {
  analyzeSelection();
});

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
        message: "Selecione pelo menos um Component Set, Component ou Instance como destino.",
      });
      return;
    }
    if (frames.length === 0) {
      figma.ui.postMessage({
        type: "error",
        message: "Selecione pelo menos um Frame como origem das variáveis.",
      });
      return;
    }

    try {
      const results = await runSubstitution(targets, frames);
      figma.ui.postMessage({
        type: "done",
        total: results.length,
        successCount: results.filter((r) => r.status === "success").length,
        failedCount: results.filter((r) => r.status === "failed").length,
        skippedInstanceCount: results.filter((r) => r.status === "skipped_instance").length,
        results,
      });
    } catch (err) {
      console.error("Substitution error:", err);
      figma.ui.postMessage({ type: "error", message: String(err) });
    }
  }

  if (msg.type === "analyze") {
    await analyzeSelection();
  }
};

// ============================================================
// INIT
// ============================================================

(async () => {
  await analyzeSelection();
})();

console.log("Variable Substitution Plugin iniciado ✅");