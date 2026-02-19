"use strict";

// Exibe a UI do plugin
figma.showUI(__html__, { width: 360, height: 422 });


// Variáveis de estado
let showHiddenElements = false;
let currentTab: "colors" | "typography" = "colors";
let ignoringSelectionChange = false;
let rootFrameId: string | null = null;
let initialSelectionIds: string[] | null = null;
let nodesWithAppliedToken = new Set<string>();
// 🔥 CACHE GLOBAL
let cachedColorTokens: { name: string; hex: string; styleId?: string }[] | null = null;
let cachedTextTokens: { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }[] | null = null;
let cachedPageId: string | null = null;


// 🔥 NOVO: Armazena o estado original dos nodes antes de aplicar tokens
interface OriginalNodeState {
    fillStyleId?: string | symbol;
    strokeStyleId?: string | symbol;
    textStyleId?: string | symbol;
    fills?: readonly Paint[];
    strokes?: readonly Paint[];
    // 🔥 Propriedades completas de texto
    fontName?: FontName | symbol;
    fontSize?: number | symbol;
    lineHeight?: LineHeight | symbol;
    letterSpacing?: LetterSpacing | symbol;
    textCase?: TextCase | symbol;
    textDecoration?: TextDecoration | symbol;
    paragraphSpacing?: number | symbol;
    paragraphIndent?: number | symbol;
}
let originalNodeStates = new Map<string, OriginalNodeState>();



/* ---------- HELPERS ---------- */

// Converte cor RGB para HEX
function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// Type guard para SceneNode
function isSceneNode(node: BaseNode): node is SceneNode {
    return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

// Type guard para Gradients
function isGradientPaint(p: Paint): p is GradientPaint {
    return (
        p.type === "GRADIENT_LINEAR" ||
        p.type === "GRADIENT_RADIAL" ||
        p.type === "GRADIENT_ANGULAR" ||
        p.type === "GRADIENT_DIAMOND"
    );
}

// Prefixos válidos de tokens de cor
const VALID_TOKEN_PREFIXES = [
    "Base Color/",
    "Contextual Color/",
    "Base/",
    "Surface Colors/",
    "Content Colors/",
    "Brand Colors/"
];

// Remove o prefixo do nome do token para exibição
// 🔥 ATUALIZADO: Remove TODOS os prefixos, não apenas o primeiro
function removeTokenPrefix(tokenName: string): string {
    let result = tokenName;

    // Remove emoji 📚 se existir
    result = result.replace(/^📚\s+/, '');

    // Remove todos os prefixos válidos
    for (const prefix of VALID_TOKEN_PREFIXES) {
        if (result.startsWith(prefix)) {
            result = result.substring(prefix.length);
        }
    }

    return result;
}

// 🔥 Verifica se um nome de token é válido para exibição (não é interno/privado)
function isValidTokenName(name: string): boolean {
    const trimmed = name.trim();
    // Ignora tokens que começam com _ ou / (convenção de privado no Figma)
    if (trimmed.startsWith('_') || trimmed.startsWith('/')) return false;
    // Ignora tokens vazios
    if (trimmed.length === 0) return false;
    return true;
}

// 🔥 NOVA FUNÇÃO: Extrai o peso legível do fontStyle do Figma
function extractReadableWeight(fontStyle: string): string {
    const styleLower = fontStyle.toLowerCase();

    if (styleLower.includes("thin")) return "Thin";
    if (styleLower.includes("extralight") || styleLower.includes("extra light")) return "ExtraLight";
    if (styleLower.includes("light") && !styleLower.includes("extralight")) return "Light";
    if (styleLower.includes("medium")) return "Medium";
    if (styleLower.includes("semibold") || styleLower.includes("semi bold")) return "SemiBold";
    if (styleLower.includes("extrabold") || styleLower.includes("extra bold")) return "ExtraBold";
    if (styleLower.includes("bold") && !styleLower.includes("semibold") && !styleLower.includes("extrabold")) return "Bold";
    if (styleLower.includes("black") || styleLower.includes("heavy")) return "Black";
    if (styleLower.includes("regular") || styleLower.includes("normal")) return "Regular";

    return "Regular";
}

// Função para aplicar um token de tipografia em múltiplos TextNodes
async function applyTypographyToken(nodeIds: string[], styleId: string) {
    for (const id of nodeIds) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && node.type === "TEXT" && node.characters.length > 0) {
            const textNode = node as TextNode;
            await textNode.setRangeTextStyleIdAsync(0, textNode.characters.length, styleId);
        }
    }
}


// 🔥 CORRIGIDO: Verifica se um paint tem token válido, agora retornando também qual tipo (fill/stroke)
async function hasValidColorToken(node: SceneNode, paint: Paint, isStroke: boolean): Promise<boolean> {
    // 1️⃣ Variable
    if (paint.type === "SOLID") {
        if ("boundVariables" in paint && paint.boundVariables && "color" in paint.boundVariables) {
            return true;
        }
    }

    // 2️⃣ Fill Style (apenas se NÃO for stroke)
    if (!isStroke && !paint.type.startsWith("GRADIENT") && "fillStyleId" in node) {
        const styleId = node.fillStyleId;
        if (typeof styleId === "string" && styleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                if (style) {
                    return VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix));
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    // 3️⃣ Stroke Style (apenas se for stroke)
    if (isStroke && !paint.type.startsWith("GRADIENT") && "strokeStyleId" in node) {
        const styleId = node.strokeStyleId;
        if (typeof styleId === "string" && styleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                if (style) {
                    return VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix));
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    return false;
}

// Verifica se um nó de texto tem token de tipografia válido
async function hasValidTextToken(node: TextNode): Promise<boolean> {
    if (node.textStyleId && typeof node.textStyleId === "string" && node.textStyleId !== "") {
        return true;
    }
    return false;
}

// Função helper para fazer yield e permitir UI updates
function yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// 🔥 NOVA FUNÇÃO: Busca estilos de BIBLIOTECAS usando teamLibrary
async function getAllAvailableColorStyles(): Promise<PaintStyle[]> {
    const allStyles: PaintStyle[] = [];

    console.log("🔍 Buscando estilos de cor...");

    // 1️⃣ Estilos locais
    const localStyles = await figma.getLocalPaintStylesAsync();
    console.log("   📦 Estilos locais:", localStyles.length);
    allStyles.push(...localStyles);

    // 2️⃣ Estilos de bibliotecas habilitadas
    try {
        const libraries = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        console.log("   📚 Bibliotecas disponíveis:", libraries.length);

        // Pega componentes publicados de cada biblioteca
        for (const library of libraries) {
            try {
                console.log(`   📖 Processando biblioteca: ${library.name}`);
                // Busca estilos através de getStylesAsync (disponível em bibliotecas)
                // Infelizmente, não existe API direta para listar estilos de biblioteca
                // A única forma é através dos nodes que já usam esses estilos
            } catch (e) {
                console.log(`   ⚠️ Erro ao processar biblioteca ${library.name}:`, e);
            }
        }
    } catch (e) {
        console.log("   ⚠️ Erro ao acessar bibliotecas:", e);
    }

    console.log("   ✅ Total de estilos encontrados:", allStyles.length);
    return allStyles;
}

// 🔥 NOVA FUNÇÃO: Busca estilos de texto de bibliotecas
async function getAllAvailableTextStyles(): Promise<TextStyle[]> {
    const allStyles: TextStyle[] = [];

    console.log("🔍 Buscando estilos de texto...");

    // 1️⃣ Estilos locais
    const localStyles = await figma.getLocalTextStylesAsync();
    console.log("   📦 Estilos locais:", localStyles.length);
    allStyles.push(...localStyles);

    // 2️⃣ Busca em bibliotecas
    try {
        const libraries = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        console.log("   📚 Bibliotecas disponíveis:", libraries.length);
    } catch (e) {
        console.log("   ⚠️ Erro ao acessar bibliotecas:", e);
    }

    console.log("   ✅ Total de estilos encontrados:", allStyles.length);
    return allStyles;
}

// 🔥 NOVA FUNÇÃO: Coleta estilos USADOS na página (inclui bibliotecas)
async function collectStylesFromPage(): Promise<{ paintStyles: Set<string>; textStyles: Set<string> }> {
    const paintStyles = new Set<string>();
    const textStyles = new Set<string>();

    console.log("🔍 Coletando estilos usados na página...");

    async function walk(node: BaseNode) {
        if (!isSceneNode(node)) return;

        // Coleta fillStyleId
        if ("fillStyleId" in node && typeof node.fillStyleId === "string" && node.fillStyleId !== "") {
            paintStyles.add(node.fillStyleId);
        }

        // Coleta strokeStyleId
        if ("strokeStyleId" in node && typeof node.strokeStyleId === "string" && node.strokeStyleId !== "") {
            paintStyles.add(node.strokeStyleId);
        }

        // Coleta textStyleId
        if (node.type === "TEXT" && node.textStyleId && typeof node.textStyleId === "string" && node.textStyleId !== "") {
            textStyles.add(node.textStyleId);
        }

        // Recursivo
        if ("children" in node) {
            for (const child of node.children) {
                await walk(child);
            }
        }
    }

    // Percorre TODAS as páginas
    for (const page of figma.root.children) {
        await walk(page);
    }

    console.log("   🎨 Paint styles encontrados:", paintStyles.size);
    console.log("   ✏️ Text styles encontrados:", textStyles.size);

    return { paintStyles, textStyles };
}
function calculateTextStyleDistance(
    source: { fontFamily: string; fontSize?: number; fontWeight?: any },
    target: { fontFamily?: string; fontSize?: number; fontWeight?: any }
): number {
    let distance = 0;

    // Família diferente = +100
    if (source.fontFamily !== target.fontFamily) {
        distance += 100;
    }

    // Diferença de tamanho
    if (source.fontSize && target.fontSize) {
        distance += Math.abs(source.fontSize - target.fontSize);
    }

    // Diferença de peso
    const sourceWeight = typeof source.fontWeight === "number" ? source.fontWeight : 400;
    const targetWeight = typeof target.fontWeight === "number" ? target.fontWeight : 400;
    distance += Math.abs(sourceWeight - targetWeight) / 100;

    return distance;
}

// Coleta todos os estilos locais de cores disponíveis
async function collectAllLocalColorStyles(): Promise<{ name: string; hex: string; styleId: string }[]> {
    const localStyles = await figma.getLocalPaintStylesAsync();
    const validPrefixTokens: { name: string; hex: string; styleId: string }[] = [];
    const fallbackTokens: { name: string; hex: string; styleId: string }[] = [];

    for (const style of localStyles) {
        // Verifica se é um estilo SOLID
        if (style.paints && style.paints.length > 0) {
            const firstPaint = style.paints[0];
            if (firstPaint.type === "SOLID") {
                const hex = rgbToHex(firstPaint.color);
                const token = { name: style.name, hex, styleId: style.id };

                if (VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                    validPrefixTokens.push(token);
                }

                fallbackTokens.push(token);
            }
        }
    }

    return validPrefixTokens.length > 0 ? validPrefixTokens : fallbackTokens;
}

// Percorre nó recursivamente coletando tokens de COR
async function walkForColorTokens(node: SceneNode, tokenSet: Map<string, { name: string; hex: string; styleId?: string }>): Promise<void> {
    if (!showHiddenElements && !node.visible) return;

    // Processa fills
    if ("fills" in node && Array.isArray(node.fills)) {
        for (const p of node.fills) {
            if (!p || p.visible === false || p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") continue;

            if (p.type === "SOLID" && "fillStyleId" in node) {
                const styleId = node.fillStyleId;
                if (typeof styleId === "string" && styleId !== "") {
                    try {
                        const style = await figma.getStyleByIdAsync(styleId);
                        if (style && VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                            const hex = rgbToHex(p.color);
                            const key = `${style.name}_${hex}`;
                            tokenSet.set(key, { name: style.name, hex, styleId });
                        }
                    } catch (e) {
                        // Style não encontrado
                    }
                }
            }
        }
    }

    // Processa strokes
    if ("strokes" in node && Array.isArray(node.strokes)) {
        for (const p of node.strokes) {
            if (!p || p.visible === false || p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") continue;

            if (p.type === "SOLID" && "strokeStyleId" in node) {
                const styleId = node.strokeStyleId;
                if (typeof styleId === "string" && styleId !== "") {
                    try {
                        const style = await figma.getStyleByIdAsync(styleId);
                        if (style && VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                            const hex = rgbToHex(p.color);
                            const key = `${style.name}_${hex}`;
                            tokenSet.set(key, { name: style.name, hex, styleId });
                        }
                    } catch (e) {
                        // Style não encontrado
                    }
                }
            }
        }
    }

    // Percorre filhos recursivamente
    if ("children" in node) {
        for (const c of node.children) {
            if (isSceneNode(c)) await walkForColorTokens(c, tokenSet);
        }
    }
}

// Percorre nó recursivamente coletando tokens de TIPOGRAFIA
async function walkForTextTokens(node: SceneNode, tokenSet: Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>): Promise<void> {
    if (!showHiddenElements && !node.visible) return;

    // Processa texto
    if (node.type === "TEXT") {
        const textNode = node as TextNode;
        if (textNode.textStyleId && typeof textNode.textStyleId === "string" && textNode.textStyleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(textNode.textStyleId);
                if (style && style.type === "TEXT") {
                    const key = style.id;

                    // Extrai informações do estilo
                    const fontName = textNode.fontName !== figma.mixed ? textNode.fontName : { family: "Mixed", style: "Mixed" };
                    const fontSize = textNode.fontSize !== figma.mixed ? textNode.fontSize : undefined;

                    tokenSet.set(key, {
                        name: style.name,
                        styleId: style.id,
                        fontFamily: fontName.family,
                        fontStyle: fontName.style,
                        fontSize: fontSize
                    });
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    // Percorre filhos recursivamente
    if ("children" in node) {
        for (const c of node.children) {
            if (isSceneNode(c)) await walkForTextTokens(c, tokenSet);
        }
    }
}

// Coleta tokens de cor aplicados - busca em TODO o arquivo (não apenas página atual)
async function collectAppliedColorTokens(
    frames: (FrameNode | ComponentNode | InstanceNode)[]
): Promise<{ name: string; hex: string; styleId?: string }[]> {

    // 🔥 Se já temos cache válido, retorna ele
    if (cachedColorTokens && cachedPageId === figma.currentPage.id) {
        console.log("⚡ Usando cache de color tokens");
        return cachedColorTokens;
    }


    const tokenSet = new Map<string, { name: string; hex: string; styleId?: string }>();

    console.log("🔍 Coletando estilos de cor de TODO o arquivo...");

    const styleIdsInFile = new Set<string>();
    let nodesProcessed = 0;
    let nodesWithFillStyle = 0;
    let nodesWithStrokeStyle = 0;
    let nodesWithVariable = 0;

    async function collectStyleIds(node: BaseNode) {
        if (!isSceneNode(node)) {
            if ("children" in node) {
                for (const child of node.children) {
                    await collectStyleIds(child);
                }
            }
            return;
        }

        nodesProcessed++;

        // 🔥 1) Coleta via fillStyleId (estilo aplicado diretamente)
        if ("fillStyleId" in node && typeof node.fillStyleId === "string" && node.fillStyleId !== "") {
            nodesWithFillStyle++;
            styleIdsInFile.add(node.fillStyleId);
        }

        // 🔥 2) Coleta via strokeStyleId
        if ("strokeStyleId" in node && typeof node.strokeStyleId === "string" && node.strokeStyleId !== "") {
            nodesWithStrokeStyle++;
            styleIdsInFile.add(node.strokeStyleId);
        }

        // 🔥 3) NOVO: Coleta via boundVariables (quando usa variável de cor)
        if ("boundVariables" in node && node.boundVariables) {
            const bv = node.boundVariables as Record<string, any>;

            // fills podem ter variáveis bound
            const fillVars = bv["fills"];
            if (Array.isArray(fillVars)) {
                for (const v of fillVars) {
                    if (v?.type === "VARIABLE_ALIAS" && v?.id) {
                        nodesWithVariable++;
                        try {
                            const variable = await figma.variables.getVariableByIdAsync(v.id);
                            if (variable && variable.resolvedType === "COLOR") {
                                // Converte variável para pseudo-token
                                const varKey = `var_${variable.id}`;
                                const cleanName = removeTokenPrefix(variable.name);
                                if (!tokenSet.has(varKey) && isValidTokenName(cleanName)) {
                                    // Tenta pegar a cor resolvida do node
                                    const fills = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
                                    const solidFill = fills.find((f: any) => f.type === "SOLID");
                                    const hex = solidFill ? rgbToHex(solidFill.color) : "#000000";

                                    tokenSet.set(varKey, {
                                        name: cleanName,
                                        hex,
                                        styleId: variable.id
                                    });
                                }
                            }
                        } catch (e) {
                            // Ignora erro de variável
                        }
                    }
                }
            }

            // strokes também podem ter variáveis
            const strokeVars = bv["strokes"];
            if (Array.isArray(strokeVars)) {
                for (const v of strokeVars) {
                    if (v?.type === "VARIABLE_ALIAS" && v?.id) {
                        nodesWithVariable++;
                        try {
                            const variable = await figma.variables.getVariableByIdAsync(v.id);
                            if (variable && variable.resolvedType === "COLOR") {
                                const varKey = `var_${variable.id}`;
                                const cleanName = removeTokenPrefix(variable.name);
                                if (!tokenSet.has(varKey) && isValidTokenName(cleanName)) {
                                    const strokes = "strokes" in node && Array.isArray(node.strokes) ? node.strokes : [];
                                    const solidStroke = strokes.find((s: any) => s.type === "SOLID");
                                    const hex = solidStroke ? rgbToHex(solidStroke.color) : "#000000";

                                    tokenSet.set(varKey, {
                                        name: cleanName,
                                        hex,
                                        styleId: variable.id
                                    });
                                }
                            }
                        } catch (e) {
                            // Ignora erro de variável
                        }
                    }
                }
            }
        }

        // Recursivo
        if ("children" in node) {
            for (const child of node.children) {
                await collectStyleIds(child);
            }
        }
    }

    console.log("   📄 Percorrendo apenas a página atual...");
    console.log(`   📄 Página atual: "${figma.currentPage.name}"`);

    // 🔥 IMPORTANTE: carregar a página antes de acessar children
    await figma.currentPage.loadAsync();

    await collectStyleIds(figma.currentPage);


    console.log("   📊 Nodes processados:", nodesProcessed);
    console.log("   📊 Nodes com fillStyle:", nodesWithFillStyle);
    console.log("   📊 Nodes com strokeStyle:", nodesWithStrokeStyle);
    console.log("   📊 Nodes com variável:", nodesWithVariable);
    console.log("   📌 Style IDs únicos (estilos):", styleIdsInFile.size);
    console.log("   📌 Tokens via variável:", tokenSet.size);

    // Busca os estilos por ID
    let localCount = 0;
    let libraryCount = 0;
    let successCount = 0;

    for (const styleId of styleIdsInFile) {
        try {
            const style = await figma.getStyleByIdAsync(styleId);

            if (style && style.type === "PAINT") {
                const paintStyle = style as PaintStyle;

                if (paintStyle.paints && paintStyle.paints.length > 0) {
                    const firstPaint = paintStyle.paints[0];

                    if (firstPaint.type === "SOLID") {
                        const hex = rgbToHex(firstPaint.color);
                        const isRemote = paintStyle.remote || false;

                        if (isRemote) {
                            libraryCount++;
                        } else {
                            localCount++;
                        }

                        tokenSet.set(styleId, {
                            name: removeTokenPrefix(paintStyle.name),
                            hex,
                            styleId
                        });

                        successCount++;
                    }
                }
            }
        } catch (e) {
            console.log(`   ⚠️ Erro ao buscar style ${styleId}`);
        }
    }

    console.log("   📦 Estilos locais:", localCount);
    console.log("   📚 Estilos de biblioteca:", libraryCount);
    console.log("   ✅ Total de tokens disponíveis:", tokenSet.size);

    const result = Array.from(tokenSet.values());

    // 🔥 Salva no cache
    cachedColorTokens = result;
    cachedPageId = figma.currentPage.id;

    return result;

}



// Coleta tokens de texto aplicados - busca em TODO o arquivo (não apenas página atual)
async function collectAppliedTextTokens(
    frames: (FrameNode | ComponentNode | InstanceNode)[],
    currentStyle?: { fontFamily: string; fontSize?: number; fontWeight?: any }
): Promise<{ name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }[]> {

    if (cachedTextTokens && cachedPageId === figma.currentPage.id) {
        console.log("⚡ Usando cache de text tokens");
        return cachedTextTokens;
    }


    const tokenSet = new Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>();

    console.log("🔍 Coletando estilos de texto de TODO o arquivo...");

    // 🔥 Coleta todos os textStyleIds usados em TODAS as páginas
    const styleIdsInFile = new Set<string>();
    let textNodesFound = 0;
    let textNodesWithStyle = 0;

    async function collectStyleIds(node: BaseNode) {
        // 🔥 Se não é SceneNode (ex: PAGE), ainda processa os filhos
        if (!isSceneNode(node)) {
            if ("children" in node) {
                for (const child of node.children) {
                    await collectStyleIds(child);
                }
            }
            return;
        }

        if (node.type === "TEXT") {
            textNodesFound++;
            const styleIdValue = node.textStyleId === figma.mixed ? "MIXED" : (node.textStyleId || "");
            console.log(`   📝 Texto encontrado: "${node.name}" | textStyleId: "${styleIdValue}"`);

            if (node.textStyleId && typeof node.textStyleId === "string" && node.textStyleId !== "") {
                textNodesWithStyle++;
                styleIdsInFile.add(node.textStyleId);
                console.log(`      ✅ Adicionado styleId: ${node.textStyleId}`);
            } else {
                console.log(`      ⚠️ SEM textStyleId`);
            }
        }

        if ("children" in node) {
            for (const child of node.children) {
                await collectStyleIds(child);
            }
        }
    }

    console.log("   📄 Percorrendo apenas a página atual...");
    console.log(`   📄 Página atual: "${figma.currentPage.name}"`);

    await collectStyleIds(figma.currentPage);


    console.log("   📊 Textos encontrados:", textNodesFound);
    console.log("   📊 Textos com estilo:", textNodesWithStyle);
    console.log("   📌 Style IDs únicos encontrados:", styleIdsInFile.size);

    // 🔥 Se não encontrou nenhum estilo aplicado, busca estilos locais como fallback
    if (styleIdsInFile.size === 0) {
        console.log("   ⚠️ Nenhum estilo aplicado encontrado, buscando estilos locais...");
        const localStyles = await figma.getLocalTextStylesAsync();
        console.log("   📦 Estilos locais disponíveis:", localStyles.length);

        for (const style of localStyles) {
            styleIdsInFile.add(style.id);
            console.log(`      📝 Estilo local: "${style.name}" | ID: ${style.id}`);
        }

        console.log("   ✅ Usando", styleIdsInFile.size, "estilos locais como opções");
    }

    // 🔥 Busca os estilos por ID (funciona para locais E bibliotecas)
    let localCount = 0;
    let libraryCount = 0;
    let successCount = 0;

    for (const styleId of styleIdsInFile) {
        try {
            console.log(`   🔎 Buscando estilo: ${styleId}`);
            const style = await figma.getStyleByIdAsync(styleId);

            if (style && style.type === "TEXT") {
                console.log(`      ✅ Estilo encontrado: "${style.name}" | remote: ${style.remote}`);
                const textStyle = style as TextStyle;

                // Tenta carregar a fonte
                if (textStyle.fontName && typeof textStyle.fontName === 'object' && 'family' in textStyle.fontName) {
                    try {
                        console.log(`      🔤 Carregando fonte: ${textStyle.fontName.family} ${textStyle.fontName.style}`);
                        await figma.loadFontAsync(textStyle.fontName as FontName);

                        const isRemote = textStyle.remote || false;

                        if (isRemote) {
                            libraryCount++;
                        } else {
                            localCount++;
                        }

                        // 🔥 Sem emoji, só o nome limpo
                        const key = `${textStyle.name}_${styleId}`;

                        tokenSet.set(key, {
                            name: textStyle.name,
                            styleId,
                            fontFamily: textStyle.fontName.family,
                            fontStyle: textStyle.fontName.style,
                            fontSize: typeof textStyle.fontSize === 'number' ? textStyle.fontSize : undefined
                        });

                        successCount++;
                        console.log(`      ✅ Adicionado ao tokenSet`);
                    } catch (fontError) {
                        console.log(`      ❌ Fonte não disponível: "${textStyle.name}"`, fontError);
                    }
                } else {
                    console.log(`      ⚠️ FontName inválido`);
                }
            } else {
                console.log(`      ⚠️ Estilo não é TEXT ou não existe`);
            }
        } catch (e) {
            console.log(`      ❌ Erro ao buscar style ${styleId}:`, e);
        }
    }

    console.log("   📦 Estilos locais encontrados:", localCount);
    console.log("   📚 Estilos de biblioteca encontrados:", libraryCount);
    console.log("   ✅ Total de tokens disponíveis:", successCount);

    let tokens = Array.from(tokenSet.values());

    // Se temos um estilo atual, ordena por similaridade
    if (currentStyle) {
        tokens = tokens.sort((a, b) => {
            const distA = calculateTextStyleDistance(currentStyle, a);
            const distB = calculateTextStyleDistance(currentStyle, b);
            return distA - distB;
        });
    }

    // 🔥 Retorna TODOS os tokens (sem limite)
    cachedTextTokens = tokens;
    cachedPageId = figma.currentPage.id;

    return tokens;

}

/* ---------- ANALYZE FUNCTIONS ---------- */

// 🔥 CORRIGIDO: Analisa cores sem tokens, verificando fill E stroke separadamente
async function analyzeColors(
    nodes: (FrameNode | ComponentNode | InstanceNode | SectionNode)[]
) {
    // Map: chave = label + tipo (fill/stroke)
    const map = new Map<
        string,
        { nodeId: string; node: SceneNode; paint: Paint; isStroke: boolean; label: string; name: string }[]
    >();

    async function processPaint(node: SceneNode, paint: Paint, isStroke: boolean): Promise<void> {
        if (!paint || paint.visible === false) return;
        if (paint.type === "IMAGE" || paint.type === "VIDEO" || paint.type === "PATTERN") return;

        // 🔥 CORRIGIDO: Passa isStroke para verificar o tipo correto
        const hasToken = await hasValidColorToken(node, paint, isStroke);
        if (hasToken) return;

        let label: string;
        let name: string;

        if (paint.type === "SOLID") {
            label = rgbToHex(paint.color); // hexadecimal
        } else if (isGradientPaint(paint)) {
            label = "Gradiente";
        } else {
            return;
        }

        // Recupera styleId apenas se o nó suportar
        let styleId: string | undefined;
        if ("fillStyleId" in node && !isStroke) {
            styleId = node.fillStyleId as string | undefined;
        } else if ("strokeStyleId" in node && isStroke) {
            styleId = node.strokeStyleId as string | undefined;
        }

        if (styleId) {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                name = style ? style.name : label;
            } catch (e) {
                name = label;
            }

        } else {
            name = label;
        }

        const key = `${label}_${isStroke ? "stroke" : "fill"}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, paint, isStroke, label, name });
    }


    // Caminha recursivamente pelos filhos
    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        if ("fills" in node && Array.isArray(node.fills)) {
            for (const p of node.fills) {
                await processPaint(node, p, false);
            }
        }

        if ("strokes" in node && Array.isArray(node.strokes)) {
            for (const p of node.strokes) {
                await processPaint(node, p, true);
            }
        }

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    // Percorre todos os frames selecionados
    for (const node of nodes) {
        await walk(node);
    }


    // Cria array final para enviar à UI
    const groups = Array.from(map.values()).map(nodePaints => ({
        label: nodePaints[0].label, // hexadecimal ou "Gradiente"
        nodePaints
    }));

    figma.ui.postMessage({ type: "result-colors", groups });
}



// 🔥 CORRIGIDO: Analisa tipografias sem tokens e inclui readableWeight
async function analyzeTypography(
    nodes: (FrameNode | ComponentNode | InstanceNode | SectionNode)[]
) {
    const map = new Map<string, { nodeId: string; node: TextNode; style: CustomTextStyle }[]>();

    async function processTextNode(node: TextNode): Promise<void> {
        const hasToken = await hasValidTextToken(node);
        if (hasToken) return;

        const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Mixed", style: "Mixed" };
        const fontSize = node.fontSize !== figma.mixed ? node.fontSize : "Mixed";
        const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : "Mixed";
        const lineHeight = node.lineHeight !== figma.mixed ? node.lineHeight : "AUTO";
        const letterSpacing = node.letterSpacing !== figma.mixed ? node.letterSpacing : "0";

        // 🔥 NOVO: Extrai peso legível do fontStyle
        const readableWeight = extractReadableWeight(fontName.style);

        const style: CustomTextStyle = {
            fontFamily: fontName.family,
            fontStyle: fontName.style,
            readableWeight: readableWeight, // 🔥 NOVO
            fontSize: fontSize,
            fontWeight: fontWeight,
            lineHeight: lineHeight,
            letterSpacing: letterSpacing
        };

        const key = `${fontName.family}_${fontName.style}`;

        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, style });
    }

    let nodeCount = 0;

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        if (node.type === "TEXT") {
            await processTextNode(node);
        }

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    for (const node of nodes) {
        await walk(node);
    }


    const groups = Array.from(map.values()).map(nodeStyles => {
        const first = nodeStyles[0].style;
        return {
            style: first,
            nodeStyles,
            label: `${first.fontFamily} ${first.readableWeight}` // 🔥 MODIFICADO: usa readableWeight
        };
    });

    figma.ui.postMessage({ type: "result-typography", groups });
}

/* ---------- TYPES ---------- */

interface CustomTextStyle {
    fontFamily: string;
    fontStyle: string;
    readableWeight?: string; // 🔥 NOVO
    fontSize: any;
    fontWeight: any;
    lineHeight: any;
    letterSpacing: any;
}

/* ---------- EVENTS ---------- */

figma.on("selectionchange", async () => {


    console.log("SELECTION CHANGED");

    if (ignoringSelectionChange) {
        console.log("IGNORE CHANGED");
        return;
    }



    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
        figma.ui.postMessage({ type: "empty", clearAll: true });
        return;
    }

    // 🔥 Resolve container raiz
    let node: SceneNode | null = selection[0];

    while (
        node &&
        node.type !== "FRAME" &&
        node.type !== "COMPONENT" &&
        node.type !== "INSTANCE" &&
        node.type !== "SECTION"
    ) {
        node = node.parent as SceneNode;
    }

    if (!node) return;

    const container = node as FrameNode | ComponentNode | InstanceNode | SectionNode;

    const newFrameId = container.id;
    const frameChanged = newFrameId !== rootFrameId;

    rootFrameId = newFrameId;

    // 🔥 SEMPRE avisa UI que a seleção mudou
    figma.ui.postMessage({ type: "selection-changed" });

    // 🔥 Se mudou o frame, também avisa
    if (frameChanged) {
        figma.ui.postMessage({ type: "frame-changed" });
    }

    // 🔥 SEMPRE reanalisa
    if (currentTab === "colors") {
        await analyzeColors([container]);
    } else {
        await analyzeTypography([container]);
    }

});


figma.ui.onmessage = async (msg) => {
    console.log("📩 mensagem recebida:", msg);

    // 🔙 Voltar para lista - processar primeiro!
    if (msg.type === "back-to-list") {
        console.log("🔙 Voltando para lista...");

        // 🔥 Restaura a seleção inicial
        if (initialSelectionIds && initialSelectionIds.length > 0) {
            console.log("📌 Restaurando seleção:", initialSelectionIds);

            const nodes: SceneNode[] = [];

            for (const id of initialSelectionIds) {
                const node = await figma.getNodeByIdAsync(id);
                if (node && isSceneNode(node)) {
                    nodes.push(node);
                }
            }

            if (nodes.length > 0) {
                // 🔥 IMPORTANTE: Ignora apenas a próxima mudança de seleção
                ignoringSelectionChange = true;

                figma.currentPage.selection = nodes;
                figma.viewport.scrollAndZoomIntoView(nodes);

                console.log("✅ Seleção restaurada:", nodes.map(n => n.name));

                // 🔄 Aguarda um momento para garantir que a seleção foi aplicada
                await new Promise(resolve => setTimeout(resolve, 50));

                // 🔄 Reanalisa direto (vai remover elementos que agora têm tokens)
                const validNodes = nodes.filter(
                    (n): n is FrameNode | ComponentNode | InstanceNode =>
                        n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
                );

                if (validNodes.length > 0) {
                    console.log("🔄 Re-analisando frames...");
                    if (currentTab === "colors") {
                        await analyzeColors(validNodes);
                    } else {
                        await analyzeTypography(validNodes);
                    }
                }
            }
        }

        // 🔄 Reset de estado
        initialSelectionIds = null;
        nodesWithAppliedToken.clear();
        originalNodeStates.clear(); // 🔥 Limpa estados originais salvos

        return;
    }

    // 🔒 Salvar seleção inicial
    if (msg.type === "save-initial-selection") {
        if (!initialSelectionIds) {
            initialSelectionIds = figma.currentPage.selection.map(n => n.id);
            console.log("📌 Seleção inicial salva (save):", initialSelectionIds);
        }
        return;
    }

    // 🔥 NOVO: Salvar estado original dos nodes
    if (msg.type === "save-original-state") {
        const nodeIds: string[] = msg.nodeIds || [];
        console.log("========================================");
        console.log("📌 Salvando estado original de", nodeIds.length, "nodes");
        console.log("========================================");

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node) {
                console.log("❌ Node não encontrado:", nodeId);
                continue;
            }

            console.log("📝 Processando node:", node.name, "ID:", nodeId);

            const state: OriginalNodeState = {};

            // Salva estado de COR
            if (isSceneNode(node)) {
                if ("fillStyleId" in node) {
                    state.fillStyleId = node.fillStyleId;
                    console.log("   🎨 fillStyleId salvo:", state.fillStyleId);
                }
                if ("strokeStyleId" in node) {
                    state.strokeStyleId = node.strokeStyleId;
                    console.log("   🎨 strokeStyleId salvo:", state.strokeStyleId);
                }
                if ("fills" in node) {
                    state.fills = JSON.parse(JSON.stringify(node.fills));
                    console.log("   🎨 fills salvos (", (node.fills as readonly Paint[]).length, "itens)");
                }
                if ("strokes" in node) {
                    state.strokes = JSON.parse(JSON.stringify(node.strokes));
                    console.log("   🎨 strokes salvos (", (node.strokes as readonly Paint[]).length, "itens)");
                }
            }

            // Salva estado de TEXTO - TODAS as propriedades
            if (node.type === "TEXT") {
                try {
                    console.log("   📖 É um TextNode, salvando propriedades...");
                    console.log("   textStyleId antes:", node.textStyleId);
                    console.log("   fontName antes:", node.fontName);
                    console.log("   fontSize antes:", node.fontSize);

                    // 🔥 Carrega a fonte antes de acessar propriedades
                    if (node.fontName !== figma.mixed) {
                        await figma.loadFontAsync(node.fontName as FontName);
                        console.log("   ✅ Fonte carregada para salvar");
                    }

                    state.textStyleId = node.textStyleId;
                    state.fontName = node.fontName;
                    state.fontSize = node.fontSize;
                    state.lineHeight = node.lineHeight;
                    state.letterSpacing = node.letterSpacing;
                    state.textCase = node.textCase;
                    state.textDecoration = node.textDecoration;
                    state.paragraphSpacing = node.paragraphSpacing;
                    state.paragraphIndent = node.paragraphIndent;

                    console.log("   ✅ Estado de texto salvo:");
                    console.log("      - textStyleId:", state.textStyleId);
                    console.log("      - fontName:", state.fontName);
                    console.log("      - fontSize:", state.fontSize);
                    console.log("      - lineHeight:", state.lineHeight);
                    console.log("      - letterSpacing:", state.letterSpacing);
                } catch (e) {
                    console.error("❌ Erro ao salvar estado de texto:", e);
                    if (e instanceof Error) {
                        console.error("Stack:", e.stack);
                    }
                }
            }

            originalNodeStates.set(nodeId, state);
            console.log("✅ Estado salvo no Map para nodeId:", nodeId);
            console.log("   Total de estados salvos:", originalNodeStates.size);
        }

        console.log("========================================");
        console.log("✅ Salvamento concluído");
        console.log("========================================");
        return;
    }

    if (msg.type === "enter-list-view") {
        // 🔥 CORRIGIDO: Sempre atualiza a seleção inicial com a seleção atual
        initialSelectionIds = figma.currentPage.selection.map(n => n.id);
        console.log("📌 seleção inicial atualizada:", initialSelectionIds);

        // 🔥 Garante que temos um rootFrameId salvo
        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode =>
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );

        if (validNodes.length > 0) {
            rootFrameId = validNodes[0].id;
            console.log("📌 rootFrameId atualizado:", rootFrameId);
        }
    }

    if (msg.type === "select-node") {
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId);

            if (node && isSceneNode(node)) {

                ignoringSelectionChange = true;

                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);

                // 🔥 Desliga no próximo tick
                setTimeout(() => {
                    ignoringSelectionChange = false;
                }, 0);
            }

        } catch (err) {
            console.error("Erro ao buscar node:", err);
        }
    }


    if (msg.type === "select-multiple-nodes") {
        try {
            ignoringSelectionChange = true;

            const nodes = await Promise.all(
                msg.nodeIds.map((id: string) => figma.getNodeByIdAsync(id))
            );


            // Mantém apenas SceneNodes válidos
            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));

            // Filtra TEXT nodes que têm texto e textStyleId válido
            const safeNodes = validNodes.filter(n => {
                if (n.type === "TEXT") {
                    return n.characters.length > 0;  // evita texto vazio
                }
                return true;
            });

            if (safeNodes.length) {
                figma.currentPage.selection = safeNodes;
                figma.viewport.scrollAndZoomIntoView(safeNodes);
            }
        } catch (err) {
            console.error("Erro ao selecionar nodes:", err);
        }
    }



    if (msg.type === "get-suggested-tokens") {
        try {
            let validNodes = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode =>
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );

            if (validNodes.length === 0 && rootFrameId) {
                const rootNode = await figma.getNodeByIdAsync(rootFrameId);
                if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                    validNodes = [rootNode];
                }
            }

            if (validNodes.length > 0) {
                if (currentTab === "colors") {
                    const appliedTokens = await collectAppliedColorTokens(validNodes);
                    figma.ui.postMessage({ type: "result-suggested-tokens", tokens: appliedTokens });
                } else {
                    // Para tipografia, pega o estilo atual do nó selecionado
                    let currentStyle = undefined;
                    if (msg.nodeId) {
                        const node = await figma.getNodeByIdAsync(msg.nodeId);
                        if (node && node.type === "TEXT" && node.characters.length > 0) {
                            const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" };
                            const fontSize = node.fontSize !== figma.mixed ? node.fontSize : 14;
                            const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : 400;
                            currentStyle = {
                                fontFamily: fontName.family,
                                fontSize,
                                fontWeight
                            };
                        }
                    }
                    const appliedTokens = await collectAppliedTextTokens(validNodes, currentStyle);
                    figma.ui.postMessage({ type: "result-suggested-text-tokens", tokens: appliedTokens });
                }
            } else {
                figma.ui.postMessage({ type: "result-suggested-tokens", tokens: [] });
            }
        } catch (err) {
            console.error("Erro ao buscar tokens sugeridos:", err);
            figma.ui.postMessage({ type: "result-suggested-tokens", tokens: [] });
        }
    }

    if (msg.type === "apply-token-multiple") {
        const styleId = msg.styleId;
        const nodeIds: string[] = msg.nodeIds || [];
        const isStroke = msg.isStroke || false;
        let lastDisplayName = styleId;

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || !isSceneNode(node)) continue;

            // 🔥 Tenta aplicar como variável primeiro (styleId pode ser um variableId)
            const variable = await figma.variables.getVariableByIdAsync(styleId).catch(() => null);

            if (variable && variable.resolvedType === "COLOR") {
                // Aplica como variável
                if (!isStroke && "fills" in node && Array.isArray(node.fills) && node.fills.length > 0) {
                    const newFills = node.fills.map((fill: Paint, i: number) =>
                        i === 0 ? figma.variables.setBoundVariableForPaint(fill as SolidPaint, "color", variable) : fill
                    );
                    node.fills = newFills;
                } else if (isStroke && "strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
                    const newStrokes = node.strokes.map((stroke: Paint, i: number) =>
                        i === 0 ? figma.variables.setBoundVariableForPaint(stroke as SolidPaint, "color", variable) : stroke
                    );
                    node.strokes = newStrokes;
                }

                lastDisplayName = removeTokenPrefix(variable.name);
                figma.ui.postMessage({
                    type: "update-detail",
                    nodeId: node.id,
                    styleName: lastDisplayName,
                    styleId: variable.id
                });
            } else {
                // Aplica como estilo (Paint Style)
                const style = await figma.getStyleByIdAsync(styleId);
                if (!style || style.type !== "PAINT") continue;

                if (isStroke && "setStrokeStyleIdAsync" in node) {
                    await node.setStrokeStyleIdAsync(styleId);
                } else if (!isStroke && "setFillStyleIdAsync" in node) {
                    await node.setFillStyleIdAsync(styleId);
                }

                lastDisplayName = removeTokenPrefix(style.name);
                figma.ui.postMessage({
                    type: "update-detail",
                    nodeId: node.id,
                    styleName: lastDisplayName,
                    styleId: style.id
                });
            }
        }

        figma.ui.postMessage({ type: "token-applied-success", styleName: lastDisplayName, styleId });
    }




    if (msg.type === "apply-token") {
        try {
            const styleId = msg.styleId;
            const isStroke = msg.isStroke;
            const isText = msg.isText || false;
            const nodeIds: string[] = msg.nodeIds || [msg.nodeId];
            const nodes = await Promise.all(nodeIds.map(id => figma.getNodeByIdAsync(id)));
            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));

            // 🔥 Verifica se é variável ou estilo
            const variable = !isText ? await figma.variables.getVariableByIdAsync(styleId).catch(() => null) : null;

            await Promise.all(validNodes.map(async (node) => {
                if (isText && node.type === "TEXT") {
                    const style = await figma.getStyleByIdAsync(styleId);
                    if (style && style.type === "TEXT") {
                        await figma.loadFontAsync(style.fontName as FontName);
                        await node.setTextStyleIdAsync(styleId);
                    }
                } else if (variable && variable.resolvedType === "COLOR") {
                    // 🔥 Aplica como variável de cor
                    if (!isStroke && "fills" in node && Array.isArray(node.fills) && node.fills.length > 0) {
                        const newFills = node.fills.map((fill: Paint, i: number) =>
                            i === 0 ? figma.variables.setBoundVariableForPaint(fill as SolidPaint, "color", variable) : fill
                        );
                        node.fills = newFills;
                    } else if (isStroke && "strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
                        const newStrokes = node.strokes.map((stroke: Paint, i: number) =>
                            i === 0 ? figma.variables.setBoundVariableForPaint(stroke as SolidPaint, "color", variable) : stroke
                        );
                        node.strokes = newStrokes;
                    }
                } else {
                    // 🔥 Aplica como Paint Style
                    if (isStroke && "setStrokeStyleIdAsync" in node) {
                        await node.setStrokeStyleIdAsync(styleId);
                    } else if (!isStroke && "setFillStyleIdAsync" in node) {
                        await node.setFillStyleIdAsync(styleId);
                    }
                }

                const rawName = variable ? variable.name : (await figma.getStyleByIdAsync(styleId))?.name || styleId;
                const displayName = removeTokenPrefix(rawName);
                figma.ui.postMessage({
                    type: "update-detail",
                    nodeId: node.id,
                    styleName: displayName,
                    styleId
                });
            }));

            const rawName = variable ? variable.name : (await figma.getStyleByIdAsync(styleId))?.name || styleId;
            figma.ui.postMessage({
                type: "token-applied-success",
                styleName: removeTokenPrefix(rawName),
                styleId
            });

        } catch (err) {
            console.error("Erro ao aplicar token:", err);
            figma.ui.postMessage({ type: "token-applied-error" });
        }
    }

    // 🔥 CORRIGIDO: Permite aplicar múltiplos estilos de fonte
    if (msg.type === "apply-typography-token-multiple") {
        console.log("📩 apply-typography-token-multiple recebido:", msg);

        const styleId = msg.styleId;
        const nodeIds: string[] = msg.nodeIds || [];

        console.log("📩 styleId:", styleId, "nodeIds:", nodeIds);

        const style = await figma.getStyleByIdAsync(styleId);

        if (!style || style.type !== "TEXT") {
            console.log("❌ Style não é TEXT, style:", style);
            figma.ui.postMessage({ type: "token-applied-error" });
            return;
        }

        console.log("✅ Style encontrado:", style.name, "fontName:", style.fontName);

        let successCount = 0;
        let errorNodes: string[] = [];

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);

            if (node && node.type === "TEXT") {
                try {
                    console.log("✅ Tentando aplicar em node:", node.name);

                    // 🔥 Carrega a fonte do ESTILO (não do node)
                    await figma.loadFontAsync(style.fontName as FontName);
                    await node.setTextStyleIdAsync(styleId);

                    successCount++;
                    console.log("✅ Aplicado com sucesso em:", node.name);

                    figma.ui.postMessage({
                        type: "update-detail",
                        nodeId: node.id,
                        styleName: style.name,
                        styleId: style.id
                    });
                } catch (fontError) {
                    console.error("❌ Erro ao carregar fonte:", fontError);
                    errorNodes.push(node.name);

                    // Tenta carregar a fonte atual do node e aplicar o estilo mesmo assim
                    try {
                        const currentFont = node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" };
                        await figma.loadFontAsync(currentFont as FontName);
                        await node.setTextStyleIdAsync(styleId);
                        successCount++;
                        console.log("✅ Aplicado com fonte alternativa em:", node.name);
                    } catch (fallbackError) {
                        console.error("❌ Erro mesmo com fallback:", fallbackError);
                    }
                }
            } else {
                console.log("❌ Node não é TEXT ou não existe:", nodeId);
            }
        }

        if (successCount > 0) {
            console.log("✅ Enviando token-applied-success");
            let successMessage = style.name;
            if (errorNodes.length > 0) {
                successMessage += ` (Fonte não disponível em ${errorNodes.length} elemento(s))`;
            }

            figma.ui.postMessage({
                type: "token-applied-success",
                styleName: successMessage,
                styleId: style.id
            });
        } else {
            console.log("❌ Nenhum node foi atualizado");
            figma.ui.postMessage({
                type: "token-applied-error",
                message: "Não foi possível aplicar o estilo. A fonte pode não estar disponível."
            });
        }
    }








    if (msg.type === "toggle-hidden") {
        showHiddenElements = msg.value;

        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode =>
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );

        // 🔥 Se não há seleção atual mas temos um rootFrameId salvo, usa ele
        if (validNodes.length === 0 && rootFrameId) {
            const rootNode = await figma.getNodeByIdAsync(rootFrameId);
            if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                validNodes.push(rootNode);
            }
        }

        if (validNodes.length > 0) {
            if (currentTab === "colors") {
                await analyzeColors(validNodes);
            } else {
                await analyzeTypography(validNodes);
            }
        }
    }

    if (msg.type === "switch-tab") {
        currentTab = msg.tab;

        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode =>
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );

        if (validNodes.length === 0) {
            figma.ui.postMessage({ type: "empty", clearAll: true });
        } else {
            if (currentTab === "colors") {
                analyzeColors(validNodes);
            } else {
                analyzeTypography(validNodes);
            }
        }
    }

    // 🔥 CORRIGIDO: Remove token de cor com logs detalhados
    if (msg.type === "remove-color-token") {
        console.log("📩 remove-color-token recebido:", msg);
        const nodeIds: string[] = msg.nodeIds || [];
        const isStroke = msg.isStroke || false;

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || !isSceneNode(node)) {
                console.log("❌ Node não encontrado ou não é SceneNode:", nodeId);
                continue;
            }

            console.log("========================================");
            console.log("✅ Processando node:", node.name);
            console.log("   Tipo:", isStroke ? "STROKE" : "FILL");
            console.log("   Node ID:", nodeId);

            try {
                // 🔥 Verificar se tem styleId aplicado
                if (isStroke && "strokeStyleId" in node) {
                    console.log("   strokeStyleId atual:", node.strokeStyleId);
                } else if (!isStroke && "fillStyleId" in node) {
                    console.log("   fillStyleId atual:", node.fillStyleId);
                }

                // 🔥 Buscar estado original
                const originalState = originalNodeStates.get(nodeId);

                if (originalState) {
                    console.log("   📦 Estado original encontrado!");

                    if (isStroke) {
                        // ========== RESTAURAR STROKE ==========
                        console.log("   🎨 Restaurando STROKE...");

                        // Restaura strokeStyleId
                        if (originalState.strokeStyleId !== undefined && "setStrokeStyleIdAsync" in node) {
                            if (typeof originalState.strokeStyleId === 'string') {
                                await node.setStrokeStyleIdAsync(originalState.strokeStyleId);
                                console.log("   ✅ strokeStyleId restaurado:", originalState.strokeStyleId);
                            } else if (originalState.strokeStyleId === figma.mixed) {
                                await node.setStrokeStyleIdAsync("");
                                console.log("   ✅ strokeStyleId removido (era mixed)");
                            }
                        }

                        // Restaura strokes (cores originais)
                        if (originalState.strokes !== undefined && "strokes" in node) {
                            node.strokes = originalState.strokes as Paint[];
                            console.log("   ✅ strokes restaurados (cores originais)");
                        }

                    } else {
                        // ========== RESTAURAR FILL ==========
                        console.log("   🎨 Restaurando FILL...");

                        // Restaura fillStyleId
                        if (originalState.fillStyleId !== undefined && "setFillStyleIdAsync" in node) {
                            if (typeof originalState.fillStyleId === 'string') {
                                await node.setFillStyleIdAsync(originalState.fillStyleId);
                                console.log("   ✅ fillStyleId restaurado:", originalState.fillStyleId);
                            } else if (originalState.fillStyleId === figma.mixed) {
                                await node.setFillStyleIdAsync("");
                                console.log("   ✅ fillStyleId removido (era mixed)");
                            }
                        }

                        // Restaura fills (cores originais)
                        if (originalState.fills !== undefined && "fills" in node) {
                            node.fills = originalState.fills as Paint[];
                            console.log("   ✅ fills restaurados (cores originais)");
                        }
                    }

                    console.log("   ✅ SUCESSO! Estado original restaurado");

                } else {
                    // ========== SEM ESTADO ORIGINAL ==========
                    console.log("   ⚠️ Sem estado original, fazendo detach simples...");

                    if (isStroke && "setStrokeStyleIdAsync" in node) {
                        await node.setStrokeStyleIdAsync("");
                        console.log("   ✅ strokeStyleId removido (detach)");
                    } else if (!isStroke && "setFillStyleIdAsync" in node) {
                        await node.setFillStyleIdAsync("");
                        console.log("   ✅ fillStyleId removido (detach)");
                    }
                }

                // Log final
                console.log("   ========================================");
                if (isStroke && "strokeStyleId" in node) {
                    console.log("   FINAL - strokeStyleId:", node.strokeStyleId);
                } else if (!isStroke && "fillStyleId" in node) {
                    console.log("   FINAL - fillStyleId:", node.fillStyleId);
                }
                console.log("   ========================================");

            } catch (e) {
                console.error("❌ Erro ao remover token de cor:", e);
                if (e instanceof Error) {
                    console.error("Stack:", e.stack);
                }
            }
        }

        console.log("✅ Enviando token-removed-success");
        figma.ui.postMessage({ type: "token-removed-success" });
    }

    // 🔥 CORRIGIDO: Remove token de texto (detach style) e restaura propriedades originais
    if (msg.type === "remove-text-token") {
        console.log("📩 remove-text-token recebido:", msg);
        const nodeIds: string[] = msg.nodeIds || [];

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);

            if (node && node.type === "TEXT") {
                console.log("✅ Processando node:", node.name);
                console.log("   textStyleId atual:", node.textStyleId);

                try {
                    // 🔥 PASSO 1: Verificar se tem estilo aplicado
                    if (!node.textStyleId || node.textStyleId === "") {
                        console.log("   ⚠️ Node não tem textStyleId, pulando...");
                        continue;
                    }

                    // 🔥 PASSO 2: Buscar estado original
                    const originalState = originalNodeStates.get(nodeId);

                    if (originalState && originalState.fontName && originalState.fontName !== figma.mixed) {
                        console.log("   📦 Estado original encontrado!");
                        console.log("   fontName original:", originalState.fontName);
                        console.log("   fontSize original:", originalState.fontSize);

                        // 🔥 IMPORTANTE: Carregar a fonte original PRIMEIRO
                        await figma.loadFontAsync(originalState.fontName as FontName);
                        console.log("   ✅ Fonte original carregada");

                        // 🔥 PASSO 3: Fazer DETACH (remover textStyleId) - USANDO ASYNC!
                        await node.setTextStyleIdAsync("");
                        console.log("   ✅ textStyleId removido (DETACH feito)");

                        // 🔥 PASSO 4: Restaurar propriedades da fonte original
                        node.fontName = originalState.fontName as FontName;
                        console.log("   ✅ fontName restaurado");

                        if (originalState.fontSize !== undefined && typeof originalState.fontSize === 'number') {
                            node.fontSize = originalState.fontSize;
                            console.log("   ✅ fontSize restaurado:", originalState.fontSize);
                        }

                        if (originalState.lineHeight !== undefined && originalState.lineHeight !== figma.mixed) {
                            node.lineHeight = originalState.lineHeight as LineHeight;
                            console.log("   ✅ lineHeight restaurado");
                        }

                        if (originalState.letterSpacing !== undefined && originalState.letterSpacing !== figma.mixed) {
                            node.letterSpacing = originalState.letterSpacing as LetterSpacing;
                            console.log("   ✅ letterSpacing restaurado");
                        }

                        if (originalState.textCase !== undefined && originalState.textCase !== figma.mixed) {
                            node.textCase = originalState.textCase as TextCase;
                            console.log("   ✅ textCase restaurado");
                        }

                        if (originalState.textDecoration !== undefined && originalState.textDecoration !== figma.mixed) {
                            node.textDecoration = originalState.textDecoration as TextDecoration;
                            console.log("   ✅ textDecoration restaurado");
                        }

                        if (originalState.paragraphSpacing !== undefined && typeof originalState.paragraphSpacing === 'number') {
                            node.paragraphSpacing = originalState.paragraphSpacing;
                            console.log("   ✅ paragraphSpacing restaurado");
                        }

                        if (originalState.paragraphIndent !== undefined && typeof originalState.paragraphIndent === 'number') {
                            node.paragraphIndent = originalState.paragraphIndent;
                            console.log("   ✅ paragraphIndent restaurado");
                        }

                        console.log("   ✅ SUCESSO! Todas as propriedades restauradas");
                        console.log("   textStyleId final:", node.textStyleId);

                    } else if (originalState && originalState.textStyleId !== undefined && typeof originalState.textStyleId === 'string') {
                        // Se tinha um textStyleId original (estava vinculado a outro estilo)
                        console.log("   📦 Tinha textStyleId original:", originalState.textStyleId);

                        if (originalState.textStyleId !== "") {
                            // Restaura o estilo original
                            try {
                                const originalStyle = await figma.getStyleByIdAsync(originalState.textStyleId);
                                if (originalStyle && originalStyle.type === "TEXT") {
                                    await figma.loadFontAsync(originalStyle.fontName as FontName);
                                    await node.setTextStyleIdAsync(originalState.textStyleId);
                                    console.log("   ✅ textStyleId original restaurado:", originalState.textStyleId);
                                }
                            } catch (e) {
                                console.log("   ⚠️ Erro ao carregar estilo original:", e);
                                // Se falhar, faz detach simples
                                if (node.fontName !== figma.mixed) {
                                    await figma.loadFontAsync(node.fontName as FontName);
                                }
                                await node.setTextStyleIdAsync("");
                                console.log("   ✅ Detach simples realizado");
                            }
                        } else {
                            // textStyleId original era vazio, só faz detach
                            if (node.fontName !== figma.mixed) {
                                await figma.loadFontAsync(node.fontName as FontName);
                            }
                            await node.setTextStyleIdAsync("");
                            console.log("   ✅ Detach realizado (original era vazio)");
                        }

                    } else {
                        // Se não tem estado original, faz detach simples mantendo a aparência atual
                        console.log("   ⚠️ Sem estado original salvo, fazendo detach mantendo aparência atual...");

                        if (node.fontName !== figma.mixed) {
                            await figma.loadFontAsync(node.fontName as FontName);
                        }

                        await node.setTextStyleIdAsync("");
                        console.log("   ✅ Detach realizado");
                    }

                    console.log("   ========================================");
                    console.log("   FINAL - textStyleId:", node.textStyleId);
                    console.log("   FINAL - fontName:", node.fontName);
                    console.log("   FINAL - fontSize:", node.fontSize);
                    console.log("   ========================================");

                } catch (e) {
                    console.error("❌ Erro ao remover estilo:", e);
                    if (e instanceof Error) {
                        console.error("Stack:", e.stack);
                    }
                }
            }
        }

        console.log("✅ Enviando token-removed-success");
        figma.ui.postMessage({ type: "token-removed-success" });
    }

    if (msg.type === "reanalyze") {

        let validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode =>
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );

        if (validNodes.length === 0 && rootFrameId) {
            const rootNode = await figma.getNodeByIdAsync(rootFrameId);
            if (rootNode && (
                rootNode.type === "FRAME" ||
                rootNode.type === "COMPONENT" ||
                rootNode.type === "INSTANCE"
            )) {
                validNodes = [rootNode];
            }
        }

        if (validNodes.length > 0) {
            if (currentTab === "colors") {
                await analyzeColors(validNodes);
            } else {
                await analyzeTypography(validNodes);
            }
        }
    }






};

/* ---------- INIT ---------- */
figma.ui.postMessage({ type: "init-tab", tab: currentTab });

// 🔥 Verifica se já tem um frame selecionado ao abrir o plugin
(async () => {
    const validNodes = figma.currentPage.selection.filter(
        (n): n is FrameNode | ComponentNode | InstanceNode =>
            n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
    );

    if (validNodes.length > 0) {
        rootFrameId = validNodes[0].id;
        initialSelectionIds = validNodes.map(n => n.id);
        console.log("✅ Frame já selecionado ao iniciar:", validNodes[0].name);

        if (currentTab === "colors") {
            analyzeColors(validNodes);
        } else {
            analyzeTypography(validNodes);
        }
    } else {
        figma.ui.postMessage({ type: "empty", clearAll: true });
    }
})();

console.log("Plugin iniciado ✅");  