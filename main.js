'use strict';

/* ==========================================================================
 * MINI WORLDBOX – ecossistema em grade (HTML5 Canvas + JS puro)
 *
 * Como o arquivo está organizado (cada parte só conhece as anteriores):
 *
 *    1. CONFIG ........ números que você vai querer ajustar
 *    2. TERRENOS ...... tipos de célula: nome, cor e se dá para andar sobre eles
 *    3. RECURSOS ...... árvores e minérios que crescem sobre certos terrenos
 *    4. WORLD ......... os dados do mapa (grade de terrenos + recursos + tráfego)
 *    5. GERAÇÃO ....... cria um mundo inicial com ruído procedural, em lotes
 *    6. VILAS ......... fundação, ideologia, tecnologia e crescimento das vilas
 *    7. HABITANTES .... entidades com classe (Construtor/Explorador/Guerreiro)
 *    8. SIMULAÇÃO ..... reações entre terrenos a cada tick + relógio do jogo
 *    9. PODERES ....... ações do jogador (Meteoro, Lava, spawns de humanos)
 *   10. RENDERER ...... desenha só a área visível (câmera) + vilas + habitantes
 *   11. MINIMAPA ...... visão geral do mapa e das vilas, com navegação por clique
 *   12. INPUT ......... mouse/toque: pincel, poderes e arraste da câmera
 *   13. UI ............ botões, sliders, atalhos e estatísticas
 *   14. BOOT .......... monta tudo e liga o game loop
 *
 * MUDANÇA DE ESCALA (do protótipo de 160x100 para um mundo de 4000x4000):
 * um mapa gigante não pode mais ser redesenhado nem sorteado por inteiro a
 * cada tick. Duas decisões resolvem isso:
 *   - o Renderer só desenha a área visível pela câmera (o custo por quadro
 *     passa a depender do tamanho da TELA, não do mapa);
 *   - a simulação sorteia uma QUANTIDADE FIXA de células por tick
 *     (CONFIG.simSamplesPerTick), não uma porcentagem do mapa.
 * Vilas e habitantes continuam em número pequeno (até algumas centenas/
 * milhares), então laços simples entre eles (ex.: guerreiro comparando
 * distância até cada vila) são baratos mesmo sem estruturas espaciais.
 *
 * Para depurar: depois de carregar a página, o objeto `game` fica disponível
 * no console. Exemplos:
 *   game.world.set(10, 10, game.Terrain.LAVA)
 *   game.inhabitants.add(20, 20, game.HumanClass.WARRIOR)
 *   game.villages.villages
 * ========================================================================== */


/* ==========================================================================
 * 1. CONFIG
 * ========================================================================== */
const CONFIG = {
  // Mundo
  gridWidth: 4000,
  gridHeight: 4000,
  minMapSize: 100,
  maxMapSize: 6000,
  initialCellSize: 8,
  minCellSize: 2,
  maxCellSize: 20,
  worldGenRowsPerChunk: 25,

  // Câmera
  wheelPanSpeed: 1.1,
  wheelZoomSpeed: 0.0025,
  
  // Relógio da simulação
  ticksPerSecond: 10,
  minTicksPerSecond: 1,
  maxTicksPerSecond: 60,
  maxTicksPerFrame: 5,

  // Em mapas gigantes não dá para sortear uma % das células a cada tick (seria
  // milhões de checagens). Sorteamos uma QUANTIDADE FIXA por tick, então o
  // custo não cresce com o tamanho do mapa.
  simSamplesPerTick: 9000,

  // Reações entre terrenos
  grassSpreadChance: 0.06,
  beachChance: 0.03,
  lavaCoolChance: 0.8,
  lavaBurnChance: 0.5,
  snowMeltChance: 0.5,
  snowMeltRadius: 2,
  treeRegrowChance: 0.02,    // por vizinho de árvore, quando a grama é sorteada

  // Tráfego / estradas
  trafficPerStep: 6,         // tráfego adicionado à célula quando alguém pisa nela
  trafficDecay: 1,           // quanto o tráfego de uma célula sorteada esfria por tick
  trafficRoadThreshold: 40,  // tráfego acumulado a partir do qual a célula "vira" estrada (visual)

  // Habitantes
  maxInhabitants: 3000,
  initialInhabitants: 90,
  spawnChance: 0.10,
  idleChance: 0.35,
  keepDirectionChance: 0.7,

  // Classes (proporção alvo ao entrar para uma vila)
  builderRatio: 0.5,
  explorerRatio: 0.2,
  warriorRatio: 0.3,        // o resto (1 - as duas acima)

  // Vilas
  maxVillages: 90,
  initialVillages: 4,
  villageFoundMinDistance: 46,   // distância mínima entre vilas
  explorerFoundDistance: 55,     // distância da vila-mãe a partir da qual um explorador pode fundar
  explorerFoundChance: 0.01,     // chance por tick, uma vez que as condições são atendidas
  villageBaseRadius: 14,
  villageMaxRadius: 60,
  villageRadiusPerPop: 0.06,
  villageMaxHouses: 30,
  houseWoodCost: 12,
  houseStoneCost: 6,
  harvestAmount: 4,              // quanto um Construtor traz por viagem
  boatsNearWaterTicksNeeded: 1500,
  industryCommerceTicksNeeded: 1800,
  industryYieldBonus: 1.5,       // multiplicador de colheita depois da indústria
  raidChance: 0.015,             // chance por tick de um guerreiro expansionista saquear
  raidDefenseMultiplier: 0.5,    // isolacionistas sofrem metade da chance de saque

  // Meteoro
  meteorLavaRadius: 3,
  meteorCraterRadius: 8,
  meteorEmberChance: 0.05,
  blastDurationMs: 600,

  // Lava (poder menor, sem cratera)
  lavaSplatRadius: 4,

  brushSize: 3,
  minBrushSize: 1,
  maxBrushSize: 10,

  statsIntervalMs: 250,     // de quanto em quanto tempo os painéis de estatística atualizam
  minimapIntervalMs: 500,   // idem para o minimapa (é mais caro de redesenhar)
};

/** Inteiro sorteado em [0, n). */
const randomInt = (n) => Math.floor(Math.random() * n);

/** "#rgb()" a partir de [r,g,b]. Usado tanto por terrenos quanto por vilas/classes. */
const toCssColor = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;


/* ==========================================================================
 * 2. TERRENOS
 * ========================================================================== */

/** Identificadores numéricos. Cada célula do mapa guarda um destes números. */
const Terrain = Object.freeze({
  WATER: 0,
  SAND: 1,
  DIRT: 2,
  GRASS: 3,
  MOUNTAIN: 4,
  LAVA: 5,
  SNOW: 6,
  STONE: 7,
});

/**
 * Lista de terrenos. IMPORTANTE: a posição no array tem que ser igual ao id.
 *
 * `walkable` diz se os habitantes podem pisar no terreno. Para criar um
 * terreno novo: adicione um id em `Terrain` e uma linha aqui. O botão, o
 * atalho de teclado (1 a 8) e a linha de estatísticas aparecem sozinhos.
 * Se ele precisar de comportamento próprio, veja BEHAVIORS (seção 8).
 */
const TERRAINS = [
  { id: Terrain.WATER,    name: 'Água',     color: [43, 108, 196],  walkable: false },
  { id: Terrain.SAND,     name: 'Areia',    color: [226, 206, 140], walkable: true },
  { id: Terrain.DIRT,     name: 'Terra',    color: [139, 99, 62],   walkable: true },
  { id: Terrain.GRASS,    name: 'Grama',    color: [82, 158, 72],   walkable: true },
  { id: Terrain.MOUNTAIN, name: 'Montanha', color: [122, 124, 132], walkable: false },
  { id: Terrain.LAVA,     name: 'Lava',     color: [232, 84, 20],   walkable: false },
  { id: Terrain.SNOW,     name: 'Neve',     color: [238, 243, 250], walkable: false },
  { id: Terrain.STONE,    name: 'Pedra',    color: [84, 82, 94],    walkable: false },
];

/** Paleta "achatada" (r,g,b,r,g,b...) para o renderer ler rápido. */
const PALETTE = new Uint8Array(TERRAINS.length * 3);
TERRAINS.forEach((terrain) => PALETTE.set(terrain.color, terrain.id * 3));

/** WALKABLE[terreno] vale 1 se os habitantes podem pisar nele (consulta O(1)). */
const WALKABLE = new Uint8Array(TERRAINS.length);
TERRAINS.forEach((terrain) => { WALKABLE[terrain.id] = terrain.walkable ? 1 : 0; });


/* ==========================================================================
 * 3. RECURSOS
 *
 * Ficam numa camada separada dos terrenos (um Uint8Array do mesmo tamanho do
 * mapa): assim uma árvore não precisa ser um "terreno" à parte, e continuamos
 * com só 8 terrenos e os atalhos 1-8 intactos. Construtores colhem essas
 * células; o valor colhido entra no estoque da vila (madeira/ferro/pedra).
 * ========================================================================== */
const Resource = Object.freeze({ NONE: 0, TREE: 1, IRON_ORE: 2, STONE_ORE: 3 });

const RESOURCES = [
  null, // índice 0 = Resource.NONE, sem célula "sem recurso" na lista de botões
  { id: Resource.TREE,      name: 'Árvore',           color: [40, 120, 55],   growsOn: Terrain.GRASS,                     stock: 'wood',  key: 'f' },
  { id: Resource.IRON_ORE,  name: 'Minério de Ferro',  color: [183, 138, 96],  growsOn: [Terrain.MOUNTAIN, Terrain.STONE], stock: 'iron',  key: 'i' },
  { id: Resource.STONE_ORE, name: 'Minério de Pedra',  color: [150, 150, 160], growsOn: [Terrain.MOUNTAIN, Terrain.STONE], stock: 'stone', key: 'o' },
];

/** Se o recurso `resourceId` pode existir sobre o terreno `terrainId`. */
function canPlaceResource(terrainId, resourceId) {
  const info = RESOURCES[resourceId];
  if (!info) return false;
  return Array.isArray(info.growsOn) ? info.growsOn.includes(terrainId) : info.growsOn === terrainId;
}


/* ==========================================================================
 * 4. WORLD – dados do mapa
 *
 * O mapa é um conjunto de Uint8Array paralelos: a célula (x, y) fica no
 * índice y * largura + x em cada um deles. Isso é bem mais leve do que uma
 * matriz de objetos e é o que torna um mundo de 16 milhões de células viável.
 * ========================================================================== */
class World {
 constructor(width, height) {
    this.counts = new Uint32Array(TERRAINS.length);
    this.resourceCounts = new Uint32Array(RESOURCES.length);
    this.resize(width, height);
}

resize(width, height) {
    this.width = width;
    this.height = height;

    this.cells = new Uint8Array(width * height);
    this.shade = new Int8Array(width * height);
    this.resources = new Uint8Array(width * height);
    this.traffic = new Uint8Array(width * height);

    for (let i = 0; i < this.shade.length; i++) {
        this.shade[i] = Math.floor(Math.random() * 15) - 7;
    }

    this.fill(Terrain.WATER);
}

    this.fill(Terrain.WATER);
}

    this.cells = new Uint8Array(width * height);      // terreno de cada célula
    this.shade = new Int8Array(width * height);        // variação de brilho (só visual)
    this.resources = new Uint8Array(width * height);   // Resource.* de cada célula
    this.traffic = new Uint8Array(width * height);      // tráfego acumulado (estrada quando alto)

    this.counts = new Uint32Array(TERRAINS.length);
    this.resourceCounts = new Uint32Array(RESOURCES.length);

    // Cada célula ganha um leve desvio de brilho fixo, para o mapa não ficar chapado.
    for (let i = 0; i < this.shade.length; i++) {
      this.shade[i] = Math.floor(Math.random() * 15) - 7;
    }

    this.fill(Terrain.WATER);
  }

  index(x, y) {
    return y * this.width + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Lê o terreno de (x, y). O chamador deve garantir que está dentro do mapa. */
  get(x, y) {
    return this.cells[this.index(x, y)];
  }

  /**
   * Muda o terreno de (x, y). É o único ponto de escrita do terreno, então
   * mantém as contagens corretas e apaga um recurso que não faça mais
   * sentido ali (ex.: lava sobre uma árvore, meteoro sobre um minério).
   * Retorna true se algo mudou.
   */
  set(x, y, type) {
    if (!this.inBounds(x, y)) return false;

    const idx = this.index(x, y);
    const previous = this.cells[idx];
    if (previous === type) return false;

    this.counts[previous]--;
    this.counts[type]++;
    this.cells[idx] = type;

    const res = this.resources[idx];
    if (res !== Resource.NONE && !canPlaceResource(type, res)) {
      this.resourceCounts[res]--;
      this.resourceCounts[Resource.NONE]++;
      this.resources[idx] = Resource.NONE;
    }
    return true;
  }

  /** Muda o recurso de (x, y), respeitando quais terrenos podem tê-lo. Retorna true se mudou. */
  setResource(x, y, type) {
    if (!this.inBounds(x, y)) return false;
    const idx = this.index(x, y);
    if (type !== Resource.NONE && !canPlaceResource(this.cells[idx], type)) return false;

    const previous = this.resources[idx];
    if (previous === type) return false;

    this.resourceCounts[previous]--;
    this.resourceCounts[type]++;
    this.resources[idx] = type;
    return true;
  }

  /** Soma tráfego a uma célula (usado quando um habitante pisa nela), sem passar de 255. */
  addTraffic(x, y, amount) {
    const idx = this.index(x, y);
    const value = this.traffic[idx] + amount;
    this.traffic[idx] = value > 255 ? 255 : value;
  }

  isRoad(x, y) {
    return this.traffic[this.index(x, y)] >= CONFIG.trafficRoadThreshold;
  }

  /** Preenche o mapa inteiro com um terreno e limpa recursos/tráfego. */
  fill(type) {
    this.cells.fill(type);
    this.resources.fill(Resource.NONE);
    this.traffic.fill(0);

    this.counts.fill(0);
    this.counts[type] = this.cells.length;
    this.resourceCounts.fill(0);
    this.resourceCounts[Resource.NONE] = this.cells.length;
  }

  /** Conta quantas células do terreno `type` há num quadrado de raio `radius` ao redor de (x, y). */
  countWithin(x, y, type, radius) {
    let total = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (this.inBounds(nx, ny) && this.get(nx, ny) === type) total++;
      }
    }
    return total;
  }

  /** Conta quantos dos 8 vizinhos de (x, y) são do terreno `type`. */
  countNeighbors(x, y, type) {
    return this.countWithin(x, y, type, 1);
  }

  /** Chama `callback(nx, ny)` para cada um dos 8 vizinhos que estão dentro do mapa. */
  forEachNeighbor(x, y, callback) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (this.inBounds(nx, ny)) callback(nx, ny);
      }
    }
  }
}


/* ==========================================================================
 * 5. GERAÇÃO PROCEDURAL
 *
 * Usa "ruído de valor": uma grade de números aleatórios suavemente
 * interpolados. Somando várias escalas (fbm) obtém-se relevo natural.
 *
 * Num mapa de 4000x4000 (16 milhões de células) gerar tudo de uma vez
 * travaria a aba por vários segundos. `runInChunks` gera algumas linhas por
 * vez com um `setTimeout(0)` entre lotes: a aba continua respondendo e o
 * jogo loop chega a desenhar o mundo se formando aos poucos.
 * ========================================================================== */

/** Gerador pseudoaleatório com semente (mulberry32): mesma semente, mesmo mundo. */
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cria uma função noise(x, y) que devolve valores suaves entre 0 e 1. */
function createValueNoise(rng) {
  const SIZE = 64; // potência de 2, para o "& 63" repetir a grade
  const lattice = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();

  const smooth = (t) => t * t * (3 - 2 * t);
  const at = (ix, iy) => lattice[((iy & 63) << 6) | (ix & 63)];

  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);

    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return top + (bottom - top) * ty;
  };
}

/** Soma 4 "oitavas" de ruído: grandes formas + detalhes cada vez menores. */
function fbm(noise, x, y) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let octave = 0; octave < 4; octave++) {
    value += noise(x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / norm;
}

/** Executa `rowFn(y)` para y de 0 a totalRows-1, em lotes, sem travar a aba. */
function runInChunks(totalRows, rowsPerChunk, rowFn, onDone) {
  let y = 0;
  function chunk() {
    const end = Math.min(totalRows, y + rowsPerChunk);
    for (; y < end; y++) rowFn(y);
    if (y < totalRows) setTimeout(chunk, 0);
    else onDone();
  }
  chunk();
}

/**
 * Substitui o conteúdo do mundo por um mapa novo (ilhas cercadas por oceano,
 * com bolsões de árvores e minérios) e chama `onDone` quando termina.
 */
function generateWorld(world, seed = Math.floor(Math.random() * 2 ** 31), onDone = () => {}) {
  const rng = createRng(seed);
  const heightNoise = createValueNoise(rng);
  const moistureNoise = createValueNoise(rng);
  const resourceNoise = createValueNoise(rng); // canal simples (sem fbm): mais barato, serve para agrupar
  const scale = 0.035; // menor = continentes maiores

  function generateRow(y) {
    const ny = (y / world.height) * 2 - 1;
    for (let x = 0; x < world.width; x++) {
      // Distância ao centro (0 = centro, 1 = borda): puxa as bordas para o oceano.
      const nx = (x / world.width) * 2 - 1;
      const edge = Math.pow(Math.min(1, Math.hypot(nx, ny)), 2.5);

      const height = fbm(heightNoise, x * scale, y * scale) - edge * 0.28;
      const moisture = fbm(moistureNoise, x * scale * 1.5, y * scale * 1.5);

      // Limiares ajustados para dar um mundo com bastante água, grama e o
      // resto dividido entre terra, areia e montanha (com neve nos picos).
      let type;
      if (height < 0.335) type = Terrain.WATER;
      else if (height < 0.355) type = Terrain.SAND;
      else if (height > 0.61) type = height > 0.67 ? Terrain.SNOW : Terrain.MOUNTAIN;
      else type = moisture > 0.43 ? Terrain.GRASS : Terrain.DIRT;

      world.set(x, y, type);

      // Recursos: um único canal de ruído (bolsões, não pontos isolados).
      const patch = resourceNoise(x * scale * 3, y * scale * 3);
      if (type === Terrain.GRASS && patch > 0.62) {
        world.setResource(x, y, Resource.TREE);
      } else if (type === Terrain.MOUNTAIN && patch > 0.7) {
        world.setResource(x, y, patch > 0.84 ? Resource.IRON_ORE : Resource.STONE_ORE);
      }
    }
  }

  runInChunks(world.height, CONFIG.worldGenRowsPerChunk, generateRow, onDone);
}


/* ==========================================================================
 * 6. VILAS
 *
 * Uma vila é um objeto simples (não um array tipado: o número de vilas é
 * pequeno, então não vale a pena complicar). O VillageManager cuida de
 * fundar, fazer crescer (casas, tecnologia) e alimentar as vilas a cada tick.
 * ========================================================================== */

const Ideology = Object.freeze({ COMMERCIAL: 0, EXPANSIONIST: 1, ISOLATIONIST: 2 });

/**
 * `patrolFactor` multiplica o raio de território para decidir até onde os
 * guerreiros daquela ideologia patrulham: expansionistas avançam além da
 * própria fronteira (mais chance de saque), isolacionistas ficam bem perto
 * de casa (raramente entram em território alheio), comerciais ficam no meio.
 */
const IDEOLOGIES = [
  { id: Ideology.COMMERCIAL,   name: 'Comercial',     color: [224, 178, 60], patrolFactor: 1.1 },
  { id: Ideology.EXPANSIONIST, name: 'Expansionista', color: [201, 74, 74],  patrolFactor: 1.35 },
  { id: Ideology.ISOLATIONIST, name: 'Isolacionista', color: [92, 148, 158], patrolFactor: 0.8 },
];

const VILLAGE_NAME_A = ['Vale', 'Porto', 'Pedra', 'Monte', 'Rio', 'Campo', 'Bosque', 'Forte', 'Alto', 'Baía'];
const VILLAGE_NAME_B = ['Verde', 'Dourado', 'Sereno', 'Bravo', 'Claro', 'Fundo', 'Novo', 'Grande', 'Sombrio', 'Feliz'];

function generateVillageName() {
  const a = VILLAGE_NAME_A[randomInt(VILLAGE_NAME_A.length)];
  const b = VILLAGE_NAME_B[randomInt(VILLAGE_NAME_B.length)];
  return `${a} ${b}`;
}

/**
 * Decide a ideologia de uma vila nova a partir do bioma ao redor do ponto de
 * fundação: recursos por perto puxam para o comércio, montanha/neve por
 * perto puxam para o isolamento, planície aberta puxa para a expansão.
 */
function determineIdeology(world, x, y) {
  const radius = 7;
  let resources = 0;
  let ruggedTiles = 0;
  let plainTiles = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!world.inBounds(nx, ny)) continue;
      if (world.resources[world.index(nx, ny)] !== Resource.NONE) resources++;
      const t = world.get(nx, ny);
      if (t === Terrain.MOUNTAIN || t === Terrain.SNOW) ruggedTiles++;
      if (t === Terrain.GRASS || t === Terrain.DIRT) plainTiles++;
    }
  }

  if (resources >= 6) return Ideology.COMMERCIAL;
  if (ruggedTiles >= 10) return Ideology.ISOLATIONIST;
  if (plainTiles >= 130) return Ideology.EXPANSIONIST;

  // Sem um bioma claramente dominante: sorteia com pesos parecidos.
  const roll = Math.random();
  if (roll < 0.34) return Ideology.COMMERCIAL;
  if (roll < 0.67) return Ideology.EXPANSIONIST;
  return Ideology.ISOLATIONIST;
}

class VillageManager {
  constructor(world) {
    this.world = world;
    this.villages = [];
  }

  get count() { return this.villages.length; }

  reset() {
    this.villages = [];
  }

  /** Funda uma vila em (x, y). Retorna a vila criada, ou null se o teto foi atingido. */
  found(x, y) {
    if (this.villages.length >= CONFIG.maxVillages) return null;

    const village = {
      id: this.villages.length,
      name: generateVillageName(),
      x, y,
      ideology: determineIdeology(this.world, x, y),
      population: 0,
      houses: [{ x, y }],
      stock: { wood: 8, stone: 4, iron: 0 },
      tech: { boats: false, industry: false },
      nearWaterTicks: 0,
      commerceTicks: 0,
      territoryRadius: CONFIG.villageBaseRadius,
    };
    this.villages.push(village);
    return village;
  }

  /** Nenhuma vila pode nascer muito perto de outra já existente. */
  isFarEnoughFromVillages(x, y, minDistance = CONFIG.villageFoundMinDistance) {
    for (const village of this.villages) {
      if (Math.hypot(village.x - x, village.y - y) < minDistance) return false;
    }
    return true;
  }

  /** A vila mais próxima de (x, y) e a distância até ela ({village: null, distance: Infinity} se não houver nenhuma). */
  nearest(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const village of this.villages) {
      const d = Math.hypot(village.x - x, village.y - y);
      if (d < bestDist) { bestDist = d; best = village; }
    }
    return { village: best, distance: bestDist };
  }

  /** A vila cujo território (círculo de raio `territoryRadius`) cobre (x, y), se houver. */
  territoryAt(x, y) {
    for (const village of this.villages) {
      if (Math.hypot(village.x - x, village.y - y) <= village.territoryRadius) return village;
    }
    return null;
  }

  /** Sorteia uma classe de habitante respeitando as proporções alvo (CONFIG.*Ratio). */
  static rollClass() {
    const roll = Math.random();
    if (roll < CONFIG.builderRatio) return HumanClass.BUILDER;
    if (roll < CONFIG.builderRatio + CONFIG.explorerRatio) return HumanClass.EXPLORER;
    return HumanClass.WARRIOR;
  }

  /** Recalcula a população de cada vila a partir dos habitantes vivos (barato: poucas vilas). */
  recomputePopulations(inhabitants) {
    for (const village of this.villages) village.population = 0;
    for (let i = 0; i < inhabitants.count; i++) {
      const id = inhabitants.village[i];
      if (id >= 0 && id < this.villages.length) this.villages[id].population++;
    }
  }

  /**
   * Mata um habitante aleatório de uma vila (usado em saques). Retorna true
   * se alguém morreu. OBS.: como isso pode ser chamado no meio do laço de
   * Inhabitants.step(), a remoção (que move o último habitante para o lugar
   * do removido) pode, raramente, fazer alguém agir duas vezes ou nenhuma
   * no mesmo tick — inofensivo num protótipo desse porte.
   */
  killRandomVillager(inhabitants, villageId) {
    const candidates = [];
    for (let i = 0; i < inhabitants.count; i++) {
      if (inhabitants.village[i] === villageId) candidates.push(i);
    }
    if (candidates.length === 0) return false;
    inhabitants.remove(candidates[randomInt(candidates.length)]);
    return true;
  }

  /** Um tick de vida para todas as vilas: crescimento de território, tecnologia e casas novas. */
  step() {
    const { world } = this;
    for (const village of this.villages) {
      village.territoryRadius = Math.min(
        CONFIG.villageMaxRadius,
        CONFIG.villageBaseRadius + village.population * CONFIG.villageRadiusPerPop
      );

      if (world.countWithin(village.x, village.y, Terrain.WATER, 8) > 0) village.nearWaterTicks++;
      if (!village.tech.boats && village.nearWaterTicks >= CONFIG.boatsNearWaterTicksNeeded) {
        village.tech.boats = true;
      }
      if (!village.tech.industry && village.commerceTicks >= CONFIG.industryCommerceTicksNeeded) {
        village.tech.industry = true;
      }

      this.tryBuildHouse(village);
    }
  }

  tryBuildHouse(village) {
    if (village.houses.length >= CONFIG.villageMaxHouses) return;
    if (village.stock.wood < CONFIG.houseWoodCost || village.stock.stone < CONFIG.houseStoneCost) return;

    const spot = this.findBuildSpot(village);
    if (!spot) return;

    village.stock.wood -= CONFIG.houseWoodCost;
    village.stock.stone -= CONFIG.houseStoneCost;
    village.houses.push(spot);
  }

  /** Procura uma célula andável perto de uma casa existente, longe o bastante das outras. */
  findBuildSpot(village) {
    const { world } = this;
    for (let tries = 0; tries < 24; tries++) {
      const anchor = village.houses[randomInt(village.houses.length)];
      const angle = Math.random() * Math.PI * 2;
      const dist = 3 + Math.random() * 6;
      const x = Math.round(anchor.x + Math.cos(angle) * dist);
      const y = Math.round(anchor.y + Math.sin(angle) * dist);
      if (!world.inBounds(x, y) || !WALKABLE[world.get(x, y)]) continue;

      const tooClose = village.houses.some((house) => Math.hypot(house.x - x, house.y - y) < 2.2);
      if (!tooClose) return { x, y };
    }
    return null;
  }
}


/* ==========================================================================
 * 7. HABITANTES
 *
 * Os dados ficam em arrays tipados (x[i], y[i], cls[i]... descrevem o
 * habitante i), no mesmo espírito do mapa: sem um objeto por habitante, sem
 * lixo para o coletor de memória, e o custo por tick é só um laço curto.
 * ========================================================================== */

// Quatro direções: direita, baixo, esquerda, cima.
const DIR_X = [1, 0, -1, 0];
const DIR_Y = [0, 1, 0, -1];

const HumanClass = Object.freeze({ NONE: 0, BUILDER: 1, EXPLORER: 2, WARRIOR: 3 });

const CLASS_INFO = [
  { id: HumanClass.NONE,     name: 'Andarilho',  color: [235, 235, 235] },
  { id: HumanClass.BUILDER,  name: 'Construtor', color: [201, 140, 80] },
  { id: HumanClass.EXPLORER, name: 'Explorador', color: [76, 195, 201] },
  { id: HumanClass.WARRIOR,  name: 'Guerreiro',  color: [214, 78, 78] },
];

class Inhabitants {
  /** `villageManager` dá acesso às vilas (para se filiar, entregar recursos, patrulhar...). */
  constructor(world, villageManager) {
    this.world = world;
    this.villages = villageManager;
    this.count = 0; // quantos estão vivos; só os índices 0..count-1 valem

    const capacity = CONFIG.maxInhabitants;
    this.x = new Uint16Array(capacity);
    this.y = new Uint16Array(capacity);
    this.dir = new Uint8Array(capacity);        // direção atual (índice em DIR_X / DIR_Y)
    this.village = new Int16Array(capacity).fill(-1); // id da vila, ou -1 se não filiado
    this.cls = new Uint8Array(capacity);         // HumanClass
    this.carrying = new Uint8Array(capacity);    // 1 = está carregando um recurso colhido
    this.carryKind = new Uint8Array(capacity);   // Resource.* que está sendo carregado
    this.targetX = new Int16Array(capacity);     // alvo atual (recurso a colher), se houver
    this.targetY = new Int16Array(capacity);
    this.hasTarget = new Uint8Array(capacity);
    this.heading = new Float32Array(capacity);   // ângulo usado por exploradores e guerreiros
  }

  /** Cria um habitante em (x, y). Retorna o índice criado, ou -1 se a população já está no teto. */
  add(x, y, cls = HumanClass.NONE, villageId = -1) {
    if (this.count >= CONFIG.maxInhabitants) return -1;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.dir[i] = randomInt(4);
    this.village[i] = villageId;
    this.cls[i] = cls;
    this.carrying[i] = 0;
    this.hasTarget[i] = 0;
    this.heading[i] = Math.random() * Math.PI * 2;
    return i;
  }

  /** Remove o habitante i copiando o último para o lugar dele (custo constante). */
  remove(i) {
    const last = --this.count;
    this.x[i] = this.x[last];
    this.y[i] = this.y[last];
    this.dir[i] = this.dir[last];
    this.village[i] = this.village[last];
    this.cls[i] = this.cls[last];
    this.carrying[i] = this.carrying[last];
    this.carryKind[i] = this.carryKind[last];
    this.targetX[i] = this.targetX[last];
    this.targetY[i] = this.targetY[last];
    this.hasTarget[i] = this.hasTarget[last];
    this.heading[i] = this.heading[last];
  }

  /** Elimina toda a população. */
  reset() {
    this.count = 0;
  }

  /**
   * Faz nascer até `amount` habitantes em células de grama sorteadas.
   * Retorna quantos nasceram (menos que o pedido se o mapa tiver pouca grama).
   */
  spawnOnGrass(amount, cls = HumanClass.NONE, villageId = -1) {
    const { world } = this;
    let spawned = 0;

    for (let tries = amount * 30; tries > 0 && spawned < amount && this.count < CONFIG.maxInhabitants; tries--) {
      const x = randomInt(world.width);
      const y = randomInt(world.height);
      if (world.get(x, y) === Terrain.GRASS) {
        this.add(x, y, cls, villageId);
        spawned++;
      }
    }
    return spawned;
  }

  /** Um tick de vida: descarta quem ficou em terreno proibido, dá um passo cada um, e às vezes nasce alguém. */
  step() {
    this.cullBlocked();
    for (let i = 0; i < this.count; i++) this.stepOne(i);
    if (Math.random() < CONFIG.spawnChance) this.spawnOnGrass(1);
  }

  stepOne(i) {
    switch (this.cls[i]) {
      case HumanClass.BUILDER: this.stepBuilder(i); break;
      case HumanClass.EXPLORER: this.stepExplorer(i); break;
      case HumanClass.WARRIOR: this.stepWarrior(i); break;
      default: this.stepWanderer(i); break;
    }
  }

  /** Se o habitante i pode estar em (x, y): terreno andável, ou água com a vila tendo barcos. */
  canStep(i, x, y) {
    const { world } = this;
    if (!world.inBounds(x, y)) return false;
    const terrain = world.get(x, y);
    if (WALKABLE[terrain]) return true;
    return terrain === Terrain.WATER && this.villageHasBoats(this.village[i]);
  }

  moveTo(i, x, y) {
    const { world } = this;
    this.x[i] = x;
    this.y[i] = y;
    if (WALKABLE[world.get(x, y)]) world.addTraffic(x, y, CONFIG.trafficPerStep);
  }

  villageHasBoats(villageId) {
    if (villageId < 0) return false;
    const village = this.villages.villages[villageId];
    return Boolean(village && village.tech.boats);
  }

  /**
   * Dá um passo em direção a (tx, ty), com folga para contornar obstáculos
   * (tenta o eixo dominante primeiro, depois o outro). Retorna true se andou.
   */
  stepToward(i, tx, ty) {
    const dx = tx - this.x[i];
    const dy = ty - this.y[i];
    if (dx === 0 && dy === 0) return false;

    const primary = Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
    const secondary = primary[0] !== 0 ? [0, Math.sign(dy)] : [Math.sign(dx), 0];

    for (const [sx, sy] of [primary, secondary]) {
      if (sx === 0 && sy === 0) continue;
      const nx = this.x[i] + sx;
      const ny = this.y[i] + sy;
      if (this.canStep(i, nx, ny)) {
        this.moveTo(i, nx, ny);
        return true;
      }
    }
    return false;
  }

  /** Comportamento original: passeio quase aleatório, tendendo a manter a direção. */
  stepWanderer(i) {
    // Andarilho sem vila que cruza o território de uma vila se torna morador dela.
    if (this.village[i] < 0) {
      const village = this.villages.territoryAt(this.x[i], this.y[i]);
      if (village) {
        this.village[i] = village.id;
        this.cls[i] = VillageManager.rollClass();
        return;
      }
    }

    if (Math.random() < CONFIG.idleChance) return;

    let dir = this.dir[i];
    if (Math.random() > CONFIG.keepDirectionChance) dir = randomInt(4);

    const nx = this.x[i] + DIR_X[dir];
    const ny = this.y[i] + DIR_Y[dir];

    if (this.canStep(i, nx, ny)) {
      this.moveTo(i, nx, ny);
      this.dir[i] = dir;
    } else {
      this.dir[i] = randomInt(4);
    }
  }

  /** Construtor: procura o recurso mais próximo, colhe, entrega na vila, repete. */
  stepBuilder(i) {
    const village = this.villages.villages[this.village[i]];
    if (!village) { this.stepWanderer(i); return; }

    if (this.carrying[i]) {
      if (Math.hypot(this.x[i] - village.x, this.y[i] - village.y) <= 1) {
        const kind = RESOURCES[this.carryKind[i]].stock;
        const bonus = village.tech.industry ? CONFIG.industryYieldBonus : 1;
        village.stock[kind] += CONFIG.harvestAmount * bonus;
        this.carrying[i] = 0;
        return;
      }
      if (!this.stepToward(i, village.x, village.y)) this.stepWanderer(i);
      return;
    }

    if (!this.hasTarget[i]) {
      const found = this.findNearbyResource(this.x[i], this.y[i], Math.max(12, village.territoryRadius));
      if (!found) { this.stepWanderer(i); return; }
      this.targetX[i] = found.x;
      this.targetY[i] = found.y;
      this.hasTarget[i] = 1;
    }

    if (Math.hypot(this.x[i] - this.targetX[i], this.y[i] - this.targetY[i]) <= 1) {
      const idx = this.world.index(this.targetX[i], this.targetY[i]);
      const kind = this.world.resources[idx];
      if (kind !== Resource.NONE) {
        this.world.setResource(this.targetX[i], this.targetY[i], Resource.NONE);
        this.carrying[i] = 1;
        this.carryKind[i] = kind;
      }
      this.hasTarget[i] = 0;
      return;
    }

    if (!this.stepToward(i, this.targetX[i], this.targetY[i])) this.hasTarget[i] = 0;
  }

  /** Procura, num raio pequeno (barato), a célula com recurso mais próxima. */
  findNearbyResource(cx, cy, radius) {
    const { world } = this;
    let best = null;
    let bestDist = Infinity;
    const r = Math.min(radius, 30); // teto de custo por busca
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (!world.inBounds(x, y)) continue;
        if (world.resources[world.index(x, y)] === Resource.NONE) continue;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; best = { x, y }; }
      }
    }
    return best;
  }

  /** Explorador: afasta-se da vila-mãe num rumo que vai derivando; longe o bastante, pode fundar uma vila nova. */
  stepExplorer(i) {
    const village = this.villages.villages[this.village[i]];
    if (!village) { this.stepWanderer(i); return; }

    if (Math.random() < CONFIG.idleChance * 0.4) return; // exploradores param bem menos

    const targetX = Math.round(this.x[i] + Math.cos(this.heading[i]) * 6);
    const targetY = Math.round(this.y[i] + Math.sin(this.heading[i]) * 6);
    if (!this.stepToward(i, targetX, targetY)) {
      this.heading[i] = Math.random() * Math.PI * 2; // bateu em algo: escolhe outro rumo
      this.stepWanderer(i);
      return;
    }
    if (Math.random() < 0.05) this.heading[i] += (Math.random() - 0.5) * 0.8; // o rumo vai derivando aos poucos

    const distance = Math.hypot(this.x[i] - village.x, this.y[i] - village.y);
    if (distance < CONFIG.explorerFoundDistance || Math.random() >= CONFIG.explorerFoundChance) return;

    const terrain = this.world.get(this.x[i], this.y[i]);
    const goodBiome = terrain === Terrain.GRASS || terrain === Terrain.DIRT || terrain === Terrain.SAND;
    if (!goodBiome || !this.villages.isFarEnoughFromVillages(this.x[i], this.y[i])) return;

    const newVillage = this.villages.found(this.x[i], this.y[i]);
    if (newVillage) {
      this.village[i] = newVillage.id;
      this.cls[i] = HumanClass.BUILDER; // o fundador vira o primeiro construtor da vila nova
    }
  }

  /** Guerreiro: patrulha a fronteira da vila; o que faz ao cruzar território rival depende da ideologia. */
  stepWarrior(i) {
    const village = this.villages.villages[this.village[i]];
    if (!village) { this.stepWanderer(i); return; }

    if (Math.random() < CONFIG.idleChance * 0.6) return;

    const ideology = IDEOLOGIES[village.ideology];
    const patrolRadius = village.territoryRadius * ideology.patrolFactor;
    const patrolX = Math.round(village.x + Math.cos(this.heading[i]) * patrolRadius);
    const patrolY = Math.round(village.y + Math.sin(this.heading[i]) * patrolRadius);

    if (!this.stepToward(i, patrolX, patrolY) || Math.random() < 0.02) {
      this.heading[i] = Math.random() * Math.PI * 2; // completa a volta / desvia de obstáculo
    }

    const rival = this.villages.territoryAt(this.x[i], this.y[i]);
    if (!rival || rival.id === village.id) return;

    if (village.ideology === Ideology.COMMERCIAL) {
      // Comerciantes de passagem: contato vira comércio para as duas vilas, sem dano.
      village.commerceTicks++;
      rival.commerceTicks++;
    } else if (village.ideology === Ideology.EXPANSIONIST) {
      let chance = CONFIG.raidChance;
      if (rival.ideology === Ideology.ISOLATIONIST) chance *= CONFIG.raidDefenseMultiplier;
      if (Math.random() < chance) {
        const killed = this.villages.killRandomVillager(this, rival.id);
        if (killed) {
          village.stock.wood += 4;
          village.stock.stone += 2;
          rival.stock.wood = Math.max(0, rival.stock.wood - 4);
        }
      }
    }
    // Isolacionistas: por desenho, patrulham perto de casa (patrolFactor < 1) e
    // raramente chegam a cruzar o território de outra vila — não têm ação aqui.
  }

  /** Remove quem está sobre um terreno em que não pode estar (ex.: depois de o jogador pintar lava sob alguém). */
  cullBlocked() {
    for (let i = this.count - 1; i >= 0; i--) {
      if (!this.canStep(i, this.x[i], this.y[i])) this.remove(i);
    }
  }

  /** Mata todos os habitantes a até `radius` células de (cx, cy). Retorna quantos morreram. */
  killWithin(cx, cy, radius) {
    let killed = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      if (Math.hypot(this.x[i] - cx, this.y[i] - cy) <= radius) {
        this.remove(i);
        killed++;
      }
    }
    return killed;
  }
}


/* ==========================================================================
 * 8. SIMULAÇÃO
 *
 * A cada tick, sorteamos uma quantidade FIXA de células do mapa (não uma %:
 * num mapa de 16 milhões de células isso seria caro demais) e aplicamos a
 * reação do terreno de cada uma, além de esfriar um pouco o tráfego ali.
 * Depois do mapa, as vilas e os habitantes dão o passo deles.
 * ========================================================================== */

/**
 * Reações por terreno. Cada função recebe o mundo e a posição da célula
 * sorteada e pode alterá-la (ou as vizinhas) com world.set()/setResource().
 *
 * Para criar uma regra nova, adicione uma chave `[Terrain.X](world, x, y) {}`.
 * Terrenos sem regra ficam parados (Água, Areia, Montanha e Pedra).
 */
const BEHAVIORS = {
  // Terra: vira areia perto da água (praia) ou grama perto de grama.
  [Terrain.DIRT](world, x, y) {
    // Terra colada na lava está quente demais: nem a grama cresce nem a praia se forma.
    if (world.countNeighbors(x, y, Terrain.LAVA) > 0) return;

    const water = world.countNeighbors(x, y, Terrain.WATER);
    if (water > 0 && Math.random() < CONFIG.beachChance * water) {
      world.set(x, y, Terrain.SAND);
      return;
    }

    const grass = world.countNeighbors(x, y, Terrain.GRASS);
    if (grass > 0 && Math.random() < CONFIG.grassSpreadChance * grass) {
      world.set(x, y, Terrain.GRASS);
    }
  },

  // Grama: uma árvore pode brotar aqui se não houver recurso e houver árvores por perto.
  [Terrain.GRASS](world, x, y) {
    const idx = world.index(x, y);
    if (world.resources[idx] !== Resource.NONE) return;

    const neighborTrees = countResourceNeighbors(world, x, y, Resource.TREE);
    if (neighborTrees > 0 && Math.random() < CONFIG.treeRegrowChance * neighborTrees) {
      world.setResource(x, y, Resource.TREE);
    }
  },

  // Lava: esfria ao tocar a água e queima a grama vizinha.
  [Terrain.LAVA](world, x, y) {
    if (world.countNeighbors(x, y, Terrain.WATER) > 0 && Math.random() < CONFIG.lavaCoolChance) {
      world.set(x, y, Terrain.STONE);
      return;
    }
    world.forEachNeighbor(x, y, (nx, ny) => {
      if (world.get(nx, ny) === Terrain.GRASS && Math.random() < CONFIG.lavaBurnChance) {
        world.set(nx, ny, Terrain.DIRT);
      }
    });
  },

  // Neve: derrete e vira água quando há lava por perto.
  [Terrain.SNOW](world, x, y) {
    const lava = world.countWithin(x, y, Terrain.LAVA, CONFIG.snowMeltRadius);
    if (lava > 0 && Math.random() < CONFIG.snowMeltChance) {
      world.set(x, y, Terrain.WATER);
    }
  },
};

/** Conta vizinhos (8) cuja célula tem o recurso `type`. */
function countResourceNeighbors(world, x, y, type) {
  let total = 0;
  world.forEachNeighbor(x, y, (nx, ny) => {
    if (world.resources[world.index(nx, ny)] === type) total++;
  });
  return total;
}

class Simulation {
  constructor(world, inhabitants, villages) {
    this.world = world;
    this.inhabitants = inhabitants;
    this.villages = villages;
    this.tickCount = 0;
    this.paused = false;
    this.ticksPerSecond = CONFIG.ticksPerSecond;
    this.accumulator = 0; // tempo (ms) que passou e ainda não virou tick
  }

  /** Executa exatamente um tick de simulação. */
  step() {
    const { world } = this;
    const samples = CONFIG.simSamplesPerTick;

    for (let i = 0; i < samples; i++) {
      const x = randomInt(world.width);
      const y = randomInt(world.height);
      const idx = world.index(x, y);

      const behavior = BEHAVIORS[world.get(x, y)];
      if (behavior) behavior(world, x, y);

      if (world.traffic[idx] > 0) {
        world.traffic[idx] = Math.max(0, world.traffic[idx] - CONFIG.trafficDecay);
      }
    }

    this.inhabitants.step();
    this.villages.step();
    this.villages.recomputePopulations(this.inhabitants);
    this.tickCount++;
  }

  /**
   * Passo de tempo fixo: o desenho acontece a cada quadro do navegador, mas
   * a simulação só avança em ticks de duração constante. Assim o mundo evolui
   * na mesma velocidade em qualquer monitor (60 Hz, 144 Hz...).
   */
  update(deltaMs) {
    if (this.paused) return;

    const interval = 1000 / this.ticksPerSecond;
    this.accumulator += deltaMs;

    let steps = 0;
    while (this.accumulator >= interval && steps < CONFIG.maxTicksPerFrame) {
      this.step();
      this.accumulator -= interval;
      steps++;
    }

    if (this.accumulator >= interval) this.accumulator = 0;
  }

  togglePause() {
    this.paused = !this.paused;
    this.accumulator = 0;
  }

  resetClock() {
    this.tickCount = 0;
    this.accumulator = 0;
  }

  /** Gera um mundo novo (em lotes) e, ao terminar, semeia população e vilas iniciais. */
 // ANTES — apague isso:
  newWorld(onDone = () => {}) {
    this.inhabitants.reset();
    this.villages.reset();
    this.resetClock();

    generateWorld(this.world, undefined, () => {
      this.inhabitants.spawnOnGrass(CONFIG.initialInhabitants);
      this.seedInitialVillages();
      onDone();
    });
  }
  
  /** Funda algumas vilas de partida e recruta quem já estiver por perto. */
  seedInitialVillages() {
    const { world, villages, inhabitants } = this;
    let tries = 0;

    while (villages.count < CONFIG.initialVillages && tries < 400) {
      tries++;
      const x = randomInt(world.width);
      const y = randomInt(world.height);
      const terrain = world.get(x, y);
      if (terrain !== Terrain.GRASS && terrain !== Terrain.DIRT) continue;
      if (!villages.isFarEnoughFromVillages(x, y)) continue;

      const village = villages.found(x, y);
      if (!village) break;

      for (let i = 0; i < inhabitants.count; i++) {
        if (inhabitants.village[i] >= 0) continue;
        if (Math.hypot(inhabitants.x[i] - x, inhabitants.y[i] - y) <= CONFIG.villageBaseRadius) {
          inhabitants.village[i] = village.id;
          inhabitants.cls[i] = VillageManager.rollClass();
        }
      }
    }
  }

  /** Deixa só oceano, sem habitantes nem vilas. Rápido (fill de typed array): não precisa de lotes. */
  clearWorld() {
    this.world.fill(Terrain.WATER);
    this.inhabitants.reset();
    this.villages.reset();
    this.resetClock();
  }
}


/* ==========================================================================
 * 9. PODERES – ações do jogador que não são "pintar terreno"
 *
 * Um poder é aplicado com um clique. Para criar outro, acrescente um item em
 * POWERS: `apply(game, x, y)` recebe o objeto `game` (world, inhabitants,
 * villages, renderer...) e a célula clicada. A UI cria o botão e o atalho
 * sozinha, no grupo indicado por `group` ('camera' | 'disaster' | 'spawn').
 * ========================================================================== */
const POWERS = [
  {
    id: 'move',
    name: 'Mover',
    key: 'h',
    group: 'camera',
    color: [140, 170, 190],
    previewRadii: null, // ferramenta de navegação: sem prévia de área
    apply: null,        // tratado à parte pelo Input (arrasta a câmera)
  },
  {
    id: 'meteor',
    name: 'Meteoro',
    key: 'm',
    group: 'disaster',
    color: [255, 128, 32],
    previewRadii: () => [CONFIG.meteorLavaRadius, CONFIG.meteorCraterRadius],
    apply: (game, x, y) => meteorStrike(game, x, y),
  },
  {
    id: 'lava',
    name: 'Lava',
    key: 'l',
    group: 'disaster',
    color: [232, 84, 20],
    previewRadii: () => [0, CONFIG.lavaSplatRadius],
    apply: (game, x, y) => lavaSplat(game, x, y),
  },
  {
    id: 'spawn-builder',
    name: 'Spawnar Construtor',
    key: 'b',
    group: 'spawn',
    color: CLASS_INFO[HumanClass.BUILDER].color,
    previewRadii: () => [0, 1],
    apply: (game, x, y) => spawnHuman(game, x, y, HumanClass.BUILDER),
  },
  {
    id: 'spawn-explorer',
    name: 'Spawnar Explorador',
    key: 'e',
    group: 'spawn',
    color: CLASS_INFO[HumanClass.EXPLORER].color,
    previewRadii: () => [0, 1],
    apply: (game, x, y) => spawnHuman(game, x, y, HumanClass.EXPLORER),
  },
  {
    id: 'spawn-warrior',
    name: 'Spawnar Guerreiro',
    key: 'w',
    group: 'spawn',
    color: CLASS_INFO[HumanClass.WARRIOR].color,
    previewRadii: () => [0, 1],
    apply: (game, x, y) => spawnHuman(game, x, y, HumanClass.WARRIOR),
  },
];

const POWERS_BY_ID = Object.fromEntries(POWERS.map((power) => [power.id, power]));

/**
 * Meteoro: núcleo de lava cercado por uma cratera de pedra. Logo depois da
 * cratera caem algumas brasas (lava solta), que queimam a grama e derretem
 * a neve ao redor, ou esfriam se caírem na água. Todo habitante na área morre.
 */
function meteorStrike({ world, inhabitants, renderer }, cx, cy) {
  const lavaRadius = CONFIG.meteorLavaRadius;
  const craterRadius = CONFIG.meteorCraterRadius;
  const reach = craterRadius + 3; // até onde as brasas podem cair

  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!world.inBounds(x, y)) continue;

      // Um pequeno sorteio na distância deixa a borda da cratera irregular.
      const distance = Math.hypot(dx, dy) + (Math.random() - 0.5) * 1.5;

      if (distance <= lavaRadius) world.set(x, y, Terrain.LAVA);
      else if (distance <= craterRadius) world.set(x, y, Terrain.STONE);
      else if (distance <= reach && Math.random() < CONFIG.meteorEmberChance) world.set(x, y, Terrain.LAVA);
    }
  }

  inhabitants.killWithin(cx, cy, craterRadius + 1);
  inhabitants.cullBlocked();
  renderer.addBlast(cx, cy, craterRadius);
}

/** Poder menor: um respingo de lava instantâneo, sem cratera de pedra ao redor. */
function lavaSplat({ world, inhabitants, renderer }, cx, cy) {
  const radius = CONFIG.lavaSplatRadius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!world.inBounds(x, y)) continue;
      if (Math.hypot(dx, dy) + (Math.random() - 0.5) <= radius) world.set(x, y, Terrain.LAVA);
    }
  }
  inhabitants.killWithin(cx, cy, radius);
  inhabitants.cullBlocked();
  renderer.addBlast(cx, cy, radius);
}

/** Spawna um humano da classe escolhida, filiando-o à vila mais próxima (se houver alguma). */
function spawnHuman({ world, inhabitants, villages }, x, y, cls) {
  if (!WALKABLE[world.get(x, y)]) return;
  const { village } = villages.nearest(x, y);
  inhabitants.add(x, y, cls, village ? village.id : -1);
}


/* ==========================================================================
 * 10. RENDERER
 *
 * Só desenha a área coberta pela câmera: o buffer "de bastidores" (1 pixel
 * por célula, depois esticado sem suavização) é redimensionado para caber
 * exatamente a tela, não o mapa inteiro. Por isso o custo por quadro depende
 * do tamanho da JANELA, não do tamanho do mapa — essencial para 4000x4000.
 * ========================================================================== */
class Renderer {
  constructor(canvas, world, inhabitants, villages) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.inhabitants = inhabitants;
    this.villages = villages;

    this.showGrid = false;
    this.showTerritory = true;
    this.cellSize = CONFIG.initialCellSize;
    this.camera = { x: 0, y: 0 }; // célula do mundo no canto superior esquerdo da tela (pode ser fracionária)
    this.blasts = []; // explosões em andamento: { x, y, radius, start }

    this.buffer = document.createElement('canvas');
    this.bufferCtx = this.buffer.getContext('2d');
    this.bufferCols = 0;
    this.bufferRows = 0;

    this.centerCamera();
  }

  centerCamera() {
    this.panTo(this.world.width / 2 - this.visibleCols() / 2, this.world.height / 2 - this.visibleRows() / 2);
  }

  /** Quantas células cabem na tela, na largura/altura atuais do canvas. */
  visibleCols() { return Math.ceil(this.canvas.width / this.cellSize) + 1; }
  visibleRows() { return Math.ceil(this.canvas.height / this.cellSize) + 1; }

  /** Ajusta o canvas ao espaço disponível no layout (não ao tamanho do mapa). */
  fit(availableWidth, availableHeight) {
    this.canvas.width = Math.max(1, Math.floor(availableWidth));
    this.canvas.height = Math.max(1, Math.floor(availableHeight));
    this.clampCamera();
  }

  setCellSize(size) {
    this.cellSize = Math.min(CONFIG.maxCellSize, Math.max(CONFIG.minCellSize, size));
    this.clampCamera();
  }

  zoomAt(newCellSize, screenX, screenY) {
    const worldX = this.camera.x + screenX / this.cellSize;
    const worldY = this.camera.y + screenY / this.cellSize;

    this.cellSize = Math.min(CONFIG.maxCellSize, Math.max(CONFIG.minCellSize, newCellSize));

    this.camera.x = worldX - screenX / this.cellSize;
    this.camera.y = worldY - screenY / this.cellSize;
    this.clampCamera();
}

  /** Move a câmera em CÉLULAS (não pixels) e garante que ela não saia do mapa. */
  panBy(dxCells, dyCells) {
    this.panTo(this.camera.x + dxCells, this.camera.y + dyCells);
  }

  panTo(x, y) {
    this.camera.x = x;
    this.camera.y = y;
    this.clampCamera();
  }

  clampCamera() {
    const maxX = Math.max(0, this.world.width - this.visibleCols());
    const maxY = Math.max(0, this.world.height - this.visibleRows());
    this.camera.x = Math.min(maxX, Math.max(0, this.camera.x));
    this.camera.y = Math.min(maxY, Math.max(0, this.camera.y));
  }

  addBlast(x, y, radius) {
    this.blasts.push({ x, y, radius, start: performance.now() });
  }

  /** Converte uma célula do mundo para pixels na tela, considerando a câmera. */
  toScreen(x, y) {
    return { sx: (x - this.camera.x) * this.cellSize, sy: (y - this.camera.y) * this.cellSize };
  }

  /** Converte um pixel do canvas para a célula do mundo sob ele. */
  toWorld(px, py) {
    return { x: Math.floor(this.camera.x + px / this.cellSize), y: Math.floor(this.camera.y + py / this.cellSize) };
  }

  /** Se a célula (x, y) está (mesmo que em parte) na tela agora, com uma margem em células. */
  inView(x, y, margin = 2) {
    return x >= this.camera.x - margin && x <= this.camera.x + this.visibleCols() + margin &&
           y >= this.camera.y - margin && y <= this.camera.y + this.visibleRows() + margin;
  }

  /**
   * Desenha um quadro. `hover` é a célula sob o mouse (ou null), `tools` é o
   * estado das ferramentas e `now` é o horário do quadro (ms).
   */
  render(hover, tools, now) {
    const { ctx } = this;
    this.updateBuffer();

    ctx.imageSmoothingEnabled = false;
    const startX = Math.floor(this.camera.x);
    const startY = Math.floor(this.camera.y);
    const fracX = (this.camera.x - startX) * this.cellSize;
    const fracY = (this.camera.y - startY) * this.cellSize;
    ctx.drawImage(
      this.buffer, 0, 0, this.bufferCols, this.bufferRows,
      -fracX, -fracY, this.bufferCols * this.cellSize, this.bufferRows * this.cellSize
    );

    if (this.showGrid && this.cellSize >= 4) this.drawGrid();
    if (this.showTerritory) this.drawTerritories();
    this.drawVillages();
    this.drawInhabitants();
    this.drawBlasts(now);

    if (hover && this.world.inBounds(hover.x, hover.y)) {
      const power = POWERS_BY_ID[tools.power];
      if (power && power.previewRadii) this.drawPowerPreview(hover, power);
      else if (!power) this.drawBrushPreview(hover, tools);
    }
  }

  /**
   * Redesenha só a área visível (não o mapa inteiro: em 4000x4000 isso seria
   * 16 milhões de células todo quadro). O custo passa a depender só do
   * tamanho da tela, nunca do tamanho do mapa.
   */
  updateBuffer() {
    const { world } = this;
    const startX = Math.max(0, Math.floor(this.camera.x));
    const startY = Math.max(0, Math.floor(this.camera.y));
    const cols = Math.min(this.visibleCols(), world.width - startX);
    const rows = Math.min(this.visibleRows(), world.height - startY);
    if (cols <= 0 || rows <= 0) return;

    if (cols !== this.bufferCols || rows !== this.bufferRows) {
      this.buffer.width = cols;
      this.buffer.height = rows;
      this.bufferCols = cols;
      this.bufferRows = rows;
      this.imageData = this.bufferCtx.createImageData(cols, rows);
    }

    const pixels = this.imageData.data;
    let p = 0;
    for (let y = 0; y < rows; y++) {
      let idx = world.index(startX, startY + y);
      for (let x = 0; x < cols; x++, idx++, p += 4) {
        const cellType = world.cells[idx];
        const c = cellType * 3;
        const s = world.shade[idx];

        let r = PALETTE[c] + s;
        let g = PALETTE[c + 1] + s;
        let b = PALETTE[c + 2] + s;

        if (WALKABLE[cellType] && world.traffic[idx] >= CONFIG.trafficRoadThreshold) {
          // Estrada: mistura a cor do terreno com um tom de terra batida.
          r = r * 0.35 + 150 * 0.65;
          g = g * 0.35 + 128 * 0.65;
          b = b * 0.35 + 96 * 0.65;
        }

        const resource = world.resources[idx];
        if (resource !== Resource.NONE) {
          const rc = RESOURCES[resource].color;
          r = r * 0.4 + rc[0] * 0.6;
          g = g * 0.4 + rc[1] * 0.6;
          b = b * 0.4 + rc[2] * 0.6;
        }

        pixels[p] = r;
        pixels[p + 1] = g;
        pixels[p + 2] = b;
        pixels[p + 3] = 255;
      }
    }
    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  drawGrid() {
    const { ctx, canvas, cellSize } = this;
    const startX = Math.floor(this.camera.x);
    const startY = Math.floor(this.camera.y);
    const offsetX = -(this.camera.x - startX) * cellSize;
    const offsetY = -(this.camera.y - startY) * cellSize;

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.bufferCols; x++) {
      const sx = offsetX + x * cellSize + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, canvas.height);
    }
    for (let y = 0; y <= this.bufferRows; y++) {
      const sy = offsetY + y * cellSize + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(canvas.width, sy);
    }
    ctx.stroke();
  }

  /** Cada habitante é um quadradinho com a cor da classe; com espaço sobrando, ganha uma "cabeça". */
  drawInhabitants() {
    const { ctx, cellSize, inhabitants } = this;
    const size = Math.max(2, Math.round(cellSize * 0.6));
    const detailed = cellSize >= 6;

    for (let i = 0; i < inhabitants.count; i++) {
      const wx = inhabitants.x[i], wy = inhabitants.y[i];
      if (!this.inView(wx, wy)) continue;

      const { sx, sy } = this.toScreen(wx, wy);
      const offset = Math.floor((cellSize - size) / 2);
      const color = CLASS_INFO[inhabitants.cls[i]].color;

      if (detailed) {
        ctx.fillStyle = 'rgba(10, 10, 15, 0.55)';
        ctx.fillRect(sx + offset - 1, sy + offset - 1, size + 2, size + 2);
        ctx.fillStyle = toCssColor(color); // corpo
        ctx.fillRect(sx + offset, sy + offset, size, Math.ceil(size * 0.72));
        ctx.fillStyle = '#f2e2c8'; // cabeça
        ctx.fillRect(sx + offset + size * 0.22, sy + offset - size * 0.28, size * 0.56, size * 0.4);
      } else {
        ctx.fillStyle = toCssColor(color);
        ctx.fillRect(sx + offset, sy + offset, size, size);
      }
    }
  }

  drawTerritories() {
    const { ctx, cellSize } = this;
    for (const village of this.villages.villages) {
      if (!this.inView(village.x, village.y, village.territoryRadius)) continue;
      const { sx, sy } = this.toScreen(village.x, village.y);
      const color = IDEOLOGIES[village.ideology].color;

      ctx.beginPath();
      ctx.arc(sx, sy, village.territoryRadius * cellSize, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.35)`;
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawVillages() {
    const { ctx, cellSize } = this;
    for (const village of this.villages.villages) {
      if (!this.inView(village.x, village.y, 4)) continue;

      // Casas: pequenos telhados ao redor do centro da vila.
      for (const house of village.houses) {
        if (!this.inView(house.x, house.y, 2)) continue;
        const p = this.toScreen(house.x, house.y);
        const hs = Math.max(3, cellSize * 0.55);
        ctx.fillStyle = '#c9a15f';
        ctx.fillRect(p.sx - hs / 2, p.sy - hs / 2, hs, hs);
        ctx.fillStyle = '#8a5a3b';
        ctx.beginPath();
        ctx.moveTo(p.sx - hs * 0.7, p.sy - hs / 2);
        ctx.lineTo(p.sx, p.sy - hs * 1.15);
        ctx.lineTo(p.sx + hs * 0.7, p.sy - hs / 2);
        ctx.closePath();
        ctx.fill();
      }

      // Bandeira no centro, na cor da ideologia.
      const { sx, sy } = this.toScreen(village.x, village.y);
      const color = IDEOLOGIES[village.ideology].color;
      const halfSize = Math.max(5, cellSize * 0.9);

      ctx.strokeStyle = '#2b2b2b';
      ctx.lineWidth = Math.max(1, cellSize * 0.15);
      ctx.beginPath();
      ctx.moveTo(sx, sy + halfSize * 0.6);
      ctx.lineTo(sx, sy - halfSize);
      ctx.stroke();
      ctx.fillStyle = toCssColor(color);
      ctx.beginPath();
      ctx.moveTo(sx, sy - halfSize);
      ctx.lineTo(sx + halfSize, sy - halfSize * 0.7);
      ctx.lineTo(sx, sy - halfSize * 0.4);
      ctx.closePath();
      ctx.fill();

      // Ícones de tecnologia, ao lado da bandeira.
      let iconX = sx + halfSize * 1.3;
      if (village.tech.boats) {
        ctx.fillStyle = '#dff0ff';
        ctx.beginPath();
        ctx.moveTo(iconX - 4, sy);
        ctx.lineTo(iconX + 4, sy);
        ctx.lineTo(iconX, sy - 7);
        ctx.closePath();
        ctx.fill();
        iconX += 12;
      }
      if (village.tech.industry) {
        ctx.fillStyle = '#5a5a5a';
        ctx.fillRect(iconX - 3, sy - 8, 6, 8);
      }
    }
  }

  /** Clarão e onda de choque das explosões; cada uma dura CONFIG.blastDurationMs. */
  drawBlasts(now) {
    if (this.blasts.length === 0) return;
    const { ctx, cellSize } = this;
    this.blasts = this.blasts.filter((blast) => now - blast.start < CONFIG.blastDurationMs);

    for (const blast of this.blasts) {
      if (!this.inView(blast.x, blast.y, blast.radius + 2)) continue;
      const t = Math.max(0, (now - blast.start) / CONFIG.blastDurationMs); // 0 → 1
      const { sx: cx, sy: cy } = this.toScreen(blast.x, blast.y);
      const radius = blast.radius * cellSize * (0.3 + 1.1 * t); // a onda cresce

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 220, 150, ${0.55 * (1 - t) * (1 - t)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 245, 220, ${1 - t})`;
      ctx.lineWidth = Math.max(2, cellSize * 1.5 * (1 - t));
      ctx.stroke();
    }
  }

  /** Marca exatamente as células que o pincel (terreno ou recurso) vai alterar. */
  drawBrushPreview(hover, tools) {
    const { ctx, cellSize } = this;
    ctx.fillStyle = tools.mode === 'resource' ? 'rgba(120, 220, 140, 0.28)' : 'rgba(255, 255, 255, 0.28)';
    forEachBrushCell(hover.x, hover.y, tools.brushSize, (x, y) => {
      if (this.world.inBounds(x, y)) {
        const { sx, sy } = this.toScreen(x, y);
        ctx.fillRect(sx, sy, cellSize, cellSize);
      }
    });
  }

  /** Mostra a área de um poder: círculo externo e, se houver, um núcleo menor. */
  drawPowerPreview(hover, power) {
    const { ctx, cellSize } = this;
    const { sx, sy } = this.toScreen(hover.x + 0.5, hover.y + 0.5);
    const [coreRadius, outerRadius] = power.previewRadii();

    const circle = (radius) => {
      ctx.beginPath();
      ctx.arc(sx, sy, radius * cellSize, 0, Math.PI * 2);
    };

    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    circle(outerRadius);
    ctx.fill();

    if (coreRadius > 0) {
      ctx.fillStyle = 'rgba(255, 90, 20, 0.35)';
      circle(coreRadius);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(255, 200, 120, 0.9)';
    ctx.lineWidth = 2;
    circle(outerRadius);
    ctx.stroke();
  }
}


/* ==========================================================================
 * 11. MINIMAPA
 *
 * Amostra o mapa (não lê cada uma das 16 milhões de células, só uma a cada
 * N) e é redesenhado num intervalo (CONFIG.minimapIntervalMs), não todo
 * quadro: é barato o bastante para isso, mas não precisa ser em tempo real.
 * ========================================================================== */
class Minimap {
  constructor(canvas, world, villages, renderer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.villages = villages;
    this.renderer = renderer;
    this.lastDraw = -Infinity;

    canvas.addEventListener('pointerdown', (event) => this.jumpTo(event));
  }

  /** Centraliza a câmera principal no ponto do minimapa que foi clicado. */
  jumpTo(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const worldX = px * this.world.width - this.renderer.visibleCols() / 2;
    const worldY = py * this.world.height - this.renderer.visibleRows() / 2;
    this.renderer.panTo(worldX, worldY);
  }

  update(now) {
    if (now - this.lastDraw < CONFIG.minimapIntervalMs) return;
    this.lastDraw = now;
    this.draw();
  }

  draw() {
    const { ctx, canvas, world } = this;
    const w = canvas.width, h = canvas.height;
    const stepX = Math.max(1, Math.floor(world.width / w));
    const stepY = Math.max(1, Math.floor(world.height / h));

    const imageData = ctx.createImageData(w, h);
    const pixels = imageData.data;
    let p = 0;
    for (let y = 0; y < h; y++) {
      const wy = Math.min(world.height - 1, y * stepY);
      for (let x = 0; x < w; x++, p += 4) {
        const wx = Math.min(world.width - 1, x * stepX);
        const c = world.cells[world.index(wx, wy)] * 3;
        pixels[p] = PALETTE[c];
        pixels[p + 1] = PALETTE[c + 1];
        pixels[p + 2] = PALETTE[c + 2];
        pixels[p + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Vilas: um pontinho na cor da ideologia.
    for (const village of this.villages.villages) {
      const sx = (village.x / world.width) * w;
      const sy = (village.y / world.height) * h;
      ctx.fillStyle = toCssColor(IDEOLOGIES[village.ideology].color);
      ctx.beginPath();
      ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Retângulo mostrando o que está visível na tela principal agora.
    const cam = this.renderer.camera;
    const vx = (cam.x / world.width) * w;
    const vy = (cam.y / world.height) * h;
    const vw = (this.renderer.visibleCols() / world.width) * w;
    const vh = (this.renderer.visibleRows() / world.height) * h;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, Math.max(2, vw), Math.max(2, vh));
  }
}


/* ==========================================================================
 * 12. INPUT – pincel, poderes e câmera, por mouse ou toque
 * ========================================================================== */

/**
 * Chama `callback(x, y)` para cada célula coberta por um pincel redondo
 * centrado em (cx, cy). Tamanho 1 = uma única célula, 2 = uma cruz de 5, etc.
 * É usado tanto para pintar quanto para mostrar a prévia, então os dois
 * sempre coincidem.
 */
function forEachBrushCell(cx, cy, size, callback) {
  const radius = size - 1;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) callback(cx + dx, cy + dy);
    }
  }
}

class Input {
  /**
   * `game` é o objeto que reúne as peças do jogo. `game.tools` é o estado
   * compartilhado com a UI: { mode, terrain, resource, power, brushSize }.
   */
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.world = game.world;
    this.renderer = game.renderer;
    this.tools = game.tools;

    this.hover = null;      // célula sob o cursor: { x, y }
    this.painting = false;
    this.paintMode = 'terrain'; // 'terrain' ou 'resource', decidido no clique
    this.paintType = 0;
    this.lastCell = null;   // última célula pintada (para ligar os pontos)

    this.dragging = false;
    this.dragStart = null;  // { clientX, clientY, camX, camY }

    // Pointer Events cobrem mouse, toque e caneta com o mesmo código.
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.painting && !this.dragging) this.hover = null;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // botão direito apaga
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    this.updateCursor();
  }

  /** Converte a posição do ponteiro na tela para coordenadas de célula (via câmera). */
  cellAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (event.clientY - rect.top) * (this.canvas.height / rect.height);
    return this.renderer.toWorld(px, py);
  }

  onPointerDown(event) {
    const cell = this.cellAt(event);
    this.hover = cell;

    // Botão do meio sempre arrasta a câmera; botão esquerdo arrasta se a ferramenta "Mover" está ativa.
    const wantsPan = event.button === 1 || (event.button === 0 && this.tools.power === 'move');
    if (wantsPan) {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      this.dragging = true;
      this.dragStart = {
        clientX: event.clientX, clientY: event.clientY,
        camX: this.renderer.camera.x, camY: this.renderer.camera.y,
      };
      this.updateCursor();
      return;
    }

    if (event.button !== 0 && event.button !== 2) return;

    // Botão esquerdo com um poder selecionado (que não seja "Mover"): um clique = um uso.
    const power = event.button === 0 ? POWERS_BY_ID[this.tools.power] : null;
    if (power && power.apply) {
      power.apply(this.game, cell.x, cell.y);
      return;
    }

    this.canvas.setPointerCapture(event.pointerId);
    this.painting = true;

    if (event.button === 2) {
      this.paintMode = 'terrain';
      this.paintType = Terrain.WATER; // botão direito é sempre a borracha (água)
    } else {
      this.paintMode = this.tools.mode;
      this.paintType = this.tools.mode === 'resource' ? this.tools.resource : this.tools.terrain;
    }

    this.stamp(cell.x, cell.y);
    this.game.inhabitants.cullBlocked();
    this.lastCell = cell;
  }

  onPointerMove(event) {
    if (this.dragging) {
      const rect = this.canvas.getBoundingClientRect();
      const scale = this.canvas.width / rect.width; // pixels de tela -> pixels de canvas
      const dxPx = (event.clientX - this.dragStart.clientX) * scale;
      const dyPx = (event.clientY - this.dragStart.clientY) * scale;
      this.renderer.panTo(
        this.dragStart.camX - dxPx / this.renderer.cellSize,
        this.dragStart.camY - dyPx / this.renderer.cellSize
      );
      this.hover = this.cellAt(event);
      return;
    }

    const cell = this.cellAt(event);
    this.hover = cell;

    if (this.painting && this.lastCell) {
      this.paintLine(this.lastCell, cell);
      this.game.inhabitants.cullBlocked();
      this.lastCell = cell;
    }
  }

  onPointerUp(event) {
    this.painting = false;
    this.dragging = false;
    this.lastCell = null;
    this.updateCursor();
    if (event.pointerType !== 'mouse') this.hover = null; // no toque não há cursor pairando
  }

onWheel(event) {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (event.clientY - rect.top) * (this.canvas.height / rect.height);

    const factor = Math.exp(-event.deltaY * CONFIG.wheelZoomSpeed);
    this.renderer.zoomAt(this.renderer.cellSize * factor, px, py);
}
    // Roda do mouse ou dois dedos no touchpad: navega pelo mapa.
    this.renderer.panBy(
      (event.deltaX * CONFIG.wheelPanSpeed) / this.renderer.cellSize,
      (event.deltaY * CONFIG.wheelPanSpeed) / this.renderer.cellSize
    );
  }

  /** Aplica o pincel centrado em (cx, cy), em terreno ou em recurso conforme o modo do clique atual. */
  stamp(cx, cy) {
    const { world } = this;
    forEachBrushCell(cx, cy, this.tools.brushSize, (x, y) => {
      if (this.paintMode === 'resource') world.setResource(x, y, this.paintType);
      else world.set(x, y, this.paintType);
    });
  }

  /**
   * Pinta uma linha entre duas células (algoritmo de Bresenham). Sem isso,
   * mover o mouse rápido deixaria "buracos" entre um evento e outro.
   */
  paintLine(from, to) {
    let { x, y } = from;
    const dx = Math.abs(to.x - x);
    const dy = Math.abs(to.y - y);
    const stepX = x < to.x ? 1 : -1;
    const stepY = y < to.y ? 1 : -1;
    let error = dx - dy;

    while (true) {
      this.stamp(x, y);
      if (x === to.x && y === to.y) break;

      const doubled = error * 2;
      if (doubled > -dy) { error -= dy; x += stepX; }
      if (doubled < dx) { error += dx; y += stepY; }
    }
  }

  /** Mão fechada arrastando, mão aberta com "Mover" selecionado, mira nos outros casos. */
  updateCursor() {
    this.canvas.style.cursor = this.dragging ? 'grabbing' : this.tools.power === 'move' ? 'grab' : 'crosshair';
  }
}


/* ==========================================================================
 * 13. UI – liga o HTML ao jogo
 * ========================================================================== */
class UI {
  constructor(game) {
    this.world = game.world;
    this.inhabitants = game.inhabitants;
    this.villages = game.villages;
    this.simulation = game.simulation;
    this.renderer = game.renderer;
    this.input = game.input;
    this.tools = game.tools;

    const $ = (id) => document.getElementById(id);
    this.el = {
      terrainList: $('tool-list'),
      resourceList: $('resource-list'),
      cameraList: $('camera-list'),
      mapWidth: $('map-width'),
      mapHeight: $('map-height'),
      spawnList: $('spawn-list'),
      powerList: $('power-list'), // agora só os desastres (Meteoro, Lava)
      brushSize: $('brush-size'),
      brushSizeValue: $('brush-size-value'),
      pause: $('btn-pause'),
      step: $('btn-step'),
      speed: $('speed'),
      speedValue: $('speed-value'),
      tickCount: $('tick-count'),
      inhabitantsCount: $('inhabitants-count'),
      villageStats: $('village-stats'),
      generate: $('btn-generate'),
      clear: $('btn-clear'),
      grid: $('toggle-grid'),
      territory: $('toggle-territory'),
      hover: $('hover-info'),
      stats: $('stats'),
      lastTerrainKey: $('last-terrain-key'),
    };

    this.percent = new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    this.lastStatsTime = 0;
    this.lastHoverText = '';
    this.lastTick = -1;
    this.lastPopulation = -1;

    this.buildToolButtons();
    this.buildStatsRows();
    this.bindControls();
    this.bindShortcuts();

    this.el.lastTerrainKey.textContent = Math.min(9, TERRAINS.length); // dica de atalho na barra de status
    this.refreshTools();
    this.setBrushSize(this.tools.brushSize);
    this.setSpeed(this.simulation.ticksPerSecond);
    this.el.mapWidth.value = this.world.width;
    this.el.mapHeight.value = this.world.height;
    this.refreshPauseState();
    this.updateStats();
  }

  /* ---- construção dos elementos gerados a partir de TERRAINS / RESOURCES / POWERS ---- */

  buildToolButtons() {
    this.terrainButtons = TERRAINS.map((terrain, index) => {
      const button = this.createToolButton({
        name: terrain.name,
        color: terrain.color,
        title: `${terrain.name} (tecla ${index + 1})`,
      }, () => this.selectTerrain(terrain.id));
      this.el.terrainList.appendChild(button);
      return button;
    });

    this.resourceButtons = RESOURCES.filter(Boolean).map((res) => {
      const button = this.createToolButton({
        name: res.name,
        color: res.color,
        title: `${res.name} (tecla ${res.key.toUpperCase()})`,
        key: res.key.toUpperCase(),
      }, () => this.selectResource(res.id));
      this.el.resourceList.appendChild(button);
      return button;
    });

    const groupContainers = {
      camera: this.el.cameraList,
      disaster: this.el.powerList,
      spawn: this.el.spawnList,
    };
    this.powerButtons = POWERS.map((power) => {
      const key = power.key.toUpperCase();
      const button = this.createToolButton({
        name: power.name, color: power.color, title: `${power.name} (tecla ${key})`, key,
      }, () => this.selectPower(power.id));
      button.classList.add('tool--power');
      groupContainers[power.group].appendChild(button);
      return button;
    });
  }

  createToolButton({ name, color, title, key }, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.title = title;
    button.style.setProperty('--swatch', toCssColor(color));
    button.innerHTML =
      `<span class="tool__swatch"></span>` +
      `<span class="tool__name">${name}</span>` +
      (key ? `<kbd>${key}</kbd>` : '');
    button.addEventListener('click', onClick);
    return button;
  }

  buildStatsRows() {
    this.statRows = TERRAINS.map((terrain) => {
      const row = document.createElement('li');
      row.className = 'stat';
      row.style.setProperty('--swatch', toCssColor(terrain.color));
      row.innerHTML =
        `<span class="stat__name">${terrain.name}</span>` +
        `<span class="stat__value"></span>` +
        `<span class="stat__bar"><i></i></span>`;
      this.el.stats.appendChild(row);
      return {
        value: row.querySelector('.stat__value'),
        bar: row.querySelector('.stat__bar > i'),
      };
    });
  }

  /* ---- ligação dos controles ---- */

  bindControls() {
    const { el } = this;

    el.pause.addEventListener('click', () => this.togglePause());
    el.step.addEventListener('click', () => this.stepOnce());
    el.speed.addEventListener('input', () => this.setSpeed(Number(el.speed.value)));
    el.brushSize.addEventListener('input', () => this.setBrushSize(Number(el.brushSize.value)));
    el.grid.addEventListener('change', () => { this.renderer.showGrid = el.grid.checked; });
    el.territory.addEventListener('change', () => { this.renderer.showTerritory = el.territory.checked; });

    el.generate.addEventListener('click', () => {
      el.generate.disabled = true;
      el.clear.disabled = true;
      const { width, height } = this.readMapSize();
      this.simulation.newWorld(() => {
        el.generate.disabled = false;
        el.clear.disabled = false;
        const first = this.villages.villages[0];
        if (first) this.renderer.panTo(first.x - 60, first.y - 40);
        else this.renderer.centerCamera();
      }, width, height);
    });
    el.clear.addEventListener('click', () => {
      const { width, height } = this.readMapSize();
      this.simulation.clearWorld(width, height);
      this.renderer.centerCamera();
    });
  }

  readMapSize() {
    const width = this.clampMapSize(this.el.mapWidth.value, this.world.width);
    const height = this.clampMapSize(this.el.mapHeight.value, this.world.height);
    this.el.mapWidth.value = width;
    this.el.mapHeight.value = height;
    return { width, height };
  }

  clampMapSize(value, fallback) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(CONFIG.maxMapSize, Math.max(CONFIG.minMapSize, parsed));
  }

  bindShortcuts() {
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return; // não briga com o navegador

      const key = event.key.toLowerCase();

      // 1, 2, 3... escolhem o terreno na ordem da lista.
      const number = Number(key);
      if (Number.isInteger(number) && number >= 1 && number <= TERRAINS.length) {
        this.selectTerrain(TERRAINS[number - 1].id);
        return;
      }

      const resource = RESOURCES.find((r) => r && r.key === key);
      if (resource) { this.selectResource(resource.id); return; }

      const power = POWERS.find((candidate) => candidate.key === key);
      if (power) { this.selectPower(power.id); return; }

      switch (key) {
        case ' ':
          event.preventDefault();
          if (document.activeElement) document.activeElement.blur();
          this.togglePause();
          break;
        case 'n': this.stepOnce(); break;
        case 'g': this.el.grid.click(); break;
        case 't': this.el.territory.click(); break;
        case '+':
        case '=': this.setBrushSize(this.tools.brushSize + 1); break;
        case '-': this.setBrushSize(this.tools.brushSize - 1); break;
      }
    });
  }

  /* ---- ações ---- */

  selectTerrain(id) {
    this.tools.mode = 'terrain';
    this.tools.terrain = id;
    this.tools.power = null;
    this.refreshTools();
  }

  selectResource(id) {
    this.tools.mode = 'resource';
    this.tools.resource = id;
    this.tools.power = null;
    this.refreshTools();
  }

  selectPower(id) {
    this.tools.power = id;
    this.refreshTools();
  }

  /** Sincroniza botões, cor de acento, cursor e slider com a ferramenta atual. */
  refreshTools() {
    const { mode, terrain, resource, power } = this.tools;

    this.terrainButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(!power && mode === 'terrain' && index === terrain));
    });
    this.resourceButtons.forEach((button, index) => {
      const resId = index + 1; // RESOURCES[0] é null; os botões começam em 1
      button.setAttribute('aria-pressed', String(!power && mode === 'resource' && resId === resource));
    });
    this.powerButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(POWERS[index].id === power));
    });

    let color;
    if (power) color = POWERS_BY_ID[power].color;
    else if (mode === 'resource') color = RESOURCES[resource].color;
    else color = TERRAINS[terrain].color;
    document.documentElement.style.setProperty('--brush', toCssColor(color));

    this.el.brushSize.disabled = Boolean(power);
    this.input.updateCursor();
  }

  setBrushSize(value) {
    const size = Math.min(CONFIG.maxBrushSize, Math.max(CONFIG.minBrushSize, value));
    this.tools.brushSize = size;
    this.el.brushSize.value = size;
    this.el.brushSizeValue.textContent = size;
  }

  setSpeed(value) {
    const speed = Math.min(CONFIG.maxTicksPerSecond, Math.max(CONFIG.minTicksPerSecond, value));
    this.simulation.ticksPerSecond = speed;
    this.el.speed.value = speed;
    this.el.speedValue.textContent = `${speed} ticks/s`;
  }

  togglePause() {
    this.simulation.togglePause();
    this.refreshPauseState();
  }

  /** O botão "Passo" só faz sentido com a simulação pausada. */
  stepOnce() {
    if (this.simulation.paused) this.simulation.step();
  }

  refreshPauseState() {
    const { paused } = this.simulation;
    this.el.pause.textContent = paused ? 'Continuar' : 'Pausar';
    this.el.step.disabled = !paused;
  }

  /* ---- atualização a cada quadro ---- */

  update(now) {
    if (this.simulation.tickCount !== this.lastTick) {
      this.lastTick = this.simulation.tickCount;
      this.el.tickCount.textContent = this.lastTick.toLocaleString('pt-BR');
    }
    if (this.inhabitants.count !== this.lastPopulation) {
      this.lastPopulation = this.inhabitants.count;
      this.el.inhabitantsCount.textContent = this.lastPopulation.toLocaleString('pt-BR');
    }

    this.updateHoverInfo();

    if (now - this.lastStatsTime >= CONFIG.statsIntervalMs) {
      this.lastStatsTime = now;
      this.updateStats();
      this.updateVillageStats();
    }
  }

  updateHoverInfo() {
    const { hover } = this.input;
    let text = 'Passe o mouse sobre o mapa (arraste com o botão do meio para navegar)';

    if (hover && this.world.inBounds(hover.x, hover.y)) {
      const idx = this.world.index(hover.x, hover.y);
      const terrainName = TERRAINS[this.world.get(hover.x, hover.y)].name;
      const resId = this.world.resources[idx];
      const resText = resId !== Resource.NONE ? ` · ${RESOURCES[resId].name}` : '';
      const village = this.villages.territoryAt(hover.x, hover.y);
      const villageText = village ? ` · Vila: ${village.name} (${IDEOLOGIES[village.ideology].name})` : '';
      text = `${terrainName} em x ${hover.x}, y ${hover.y}${resText}${villageText}`;
    }

    if (text !== this.lastHoverText) {
      this.lastHoverText = text;
      this.el.hover.textContent = text;
    }
  }

  updateStats() {
    const total = this.world.width * this.world.height;
    TERRAINS.forEach((terrain) => {
      const percent = (this.world.counts[terrain.id] / total) * 100;
      const row = this.statRows[terrain.id];
      row.value.textContent = `${this.percent.format(percent)}%`;
      row.bar.style.width = `${percent}%`;
    });
  }

  updateVillageStats() {
    const villages = this.villages.villages;
    const counts = [0, 0, 0];
    let totalPop = 0;
    for (const village of villages) {
      counts[village.ideology]++;
      totalPop += village.population;
    }
    this.el.villageStats.textContent = villages.length === 0
      ? 'Nenhuma vila fundada ainda.'
      : `${villages.length} vilas — Comercial ${counts[0]}, Expansionista ${counts[1]}, ` +
        `Isolacionista ${counts[2]} · população aldeã ${totalPop.toLocaleString('pt-BR')}`;
  }
}


/* ==========================================================================
 * 14. BOOT – monta as peças e liga o game loop
 * ========================================================================== */
function boot() {
  const canvas = document.getElementById('world-canvas');
  const minimapCanvas = document.getElementById('minimap');
  const stage = document.getElementById('stage');

  const world = new World(CONFIG.gridWidth, CONFIG.gridHeight);
  const villages = new VillageManager(world);
  const inhabitants = new Inhabitants(world, villages);
  const simulation = new Simulation(world, inhabitants, villages);
  const renderer = new Renderer(canvas, world, inhabitants, villages);
  const minimap = new Minimap(minimapCanvas, world, villages, renderer);

  // Estado das ferramentas, compartilhado entre a UI (que muda) e o Input (que lê).
  const tools = { mode: 'terrain', terrain: Terrain.GRASS, resource: Resource.TREE, power: null, brushSize: CONFIG.brushSize };

  const game = { world, inhabitants, villages, simulation, renderer, minimap, tools };
  game.input = new Input(canvas, game);
  const ui = new UI(game);

  // Ajusta o tamanho do canvas ao espaço disponível sempre que o palco muda de tamanho.
  new ResizeObserver(([entry]) => {
    renderer.fit(entry.contentRect.width, entry.contentRect.height);
  }).observe(stage);

  // Gera o mundo em lotes; quando termina, centraliza a câmera perto da primeira vila fundada.
  simulation.newWorld(() => {
    const first = villages.villages[0];
    if (first) renderer.panTo(first.x - 60, first.y - 40);
    else renderer.centerCamera();
  });

  /* ---- GAME LOOP ----
   * requestAnimationFrame chama `frame` antes de cada quadro da tela.
   * 1) update: a simulação avança quantos ticks o tempo decorrido pedir;
   * 2) render: desenha o estado atual (só a área visível pela câmera);
   * 3) minimap/ui: atualizam, cada um no seu próprio ritmo.
   */
  let lastTime = performance.now();
  function frame(now) {
    // Limita o delta: se a aba ficou em segundo plano, não "recupera" minutos de ticks.
    const delta = Math.min(Math.max(now - lastTime, 0), 250);
    lastTime = now;

    simulation.update(delta);
    renderer.render(game.input.hover, tools, now);
    minimap.update(now);
    ui.update(now);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Atalho para experimentar pelo console do navegador.
  window.game = Object.assign(game, {
    CONFIG, Terrain, TERRAINS, Resource, RESOURCES, HumanClass, CLASS_INFO,
    Ideology, IDEOLOGIES, POWERS, generateWorld, meteorStrike, lavaSplat,
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
