'use strict';

/* ==========================================================================
 * MINI WORLDBOX – protótipo de simulação em grade (HTML5 Canvas + JS puro)
 *
 * Como o arquivo está organizado (cada parte só conhece as anteriores):
 *
 *    1. CONFIG ........ números que você vai querer ajustar
 *    2. TERRENOS ...... tipos de célula: nome, cor e se dá para andar sobre eles
 *    3. WORLD ......... os dados do mapa (uma grade de terrenos)
 *    4. GERAÇÃO ....... cria um mundo inicial com ruído procedural
 *    5. HABITANTES .... entidades que nascem na grama e vagam pelo mapa
 *    6. SIMULAÇÃO ..... reações entre terrenos a cada tick + relógio do jogo
 *    7. PODERES ....... ações do jogador (Meteoro)
 *    8. RENDERER ...... desenha mapa, habitantes e efeitos no canvas
 *    9. INPUT ......... mouse/toque: pincel e poderes
 *   10. UI ............ botões, sliders, atalhos e estatísticas
 *   11. BOOT .......... monta tudo e liga o game loop
 *
 * Para depurar: depois de carregar a página, o objeto `game` fica disponível
 * no console. Exemplos:
 *   game.world.set(10, 10, game.Terrain.LAVA)
 *   game.inhabitants.add(20, 20)
 *   game.meteorStrike(game, 80, 50)
 * ========================================================================== */


/* ==========================================================================
 * 1. CONFIG
 * ========================================================================== */
const CONFIG = {
  gridWidth: 160,         // colunas do mapa
  gridHeight: 100,        // linhas do mapa
  initialCellSize: 6,     // pixels por célula até o primeiro ajuste à janela
  minCellSize: 2,

  ticksPerSecond: 10,     // velocidade inicial da simulação
  minTicksPerSecond: 1,
  maxTicksPerSecond: 60,
  maxTicksPerFrame: 5,    // teto de ticks por quadro (evita travar se o PC atrasar)

  randomTickRatio: 0.10,  // fração do mapa sorteada a cada tick (veja Simulation.step)

  // Reações entre terrenos (chances aplicadas quando a célula é sorteada num tick)
  grassSpreadChance: 0.06, // por vizinho de grama: a terra vira grama
  beachChance: 0.03,       // por vizinho de água: a terra vira areia
  lavaCoolChance: 0.8,     // lava encostada na água vira pedra
  lavaBurnChance: 0.5,     // por vizinho de grama: a grama queimada vira terra
  snowMeltChance: 0.5,     // neve com lava por perto vira água
  snowMeltRadius: 2,       // "perto" = até 2 células de distância

  // Habitantes
  maxInhabitants: 400,       // tamanho dos arrays: a população nunca passa disso
  initialInhabitants: 60,    // quantos nascem ao gerar um mundo
  spawnChance: 0.08,         // por tick: chance de nascer mais um na grama (0 desliga)
  idleChance: 0.4,           // por tick: chance de o habitante ficar parado
  keepDirectionChance: 0.7,  // chance de continuar na mesma direção em vez de sortear outra

  // Meteoro
  meteorLavaRadius: 3,       // raio do núcleo de lava (em células)
  meteorCraterRadius: 8,     // raio da cratera de pedra (em células)
  meteorEmberChance: 0.05,   // brasas: lava espalhada num anel logo depois da cratera
  blastDurationMs: 600,      // duração do efeito visual da explosão

  brushSize: 3,
  minBrushSize: 1,
  maxBrushSize: 10,

  statsIntervalMs: 250,   // de quanto em quanto tempo o painel de composição atualiza
};

/** Inteiro sorteado em [0, n). */
const randomInt = (n) => Math.floor(Math.random() * n);


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
 * atalho de teclado (1 a 9) e a linha de estatísticas aparecem sozinhos.
 * Se ele precisar de comportamento próprio, veja BEHAVIORS.
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

const toCssColor = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;


/* ==========================================================================
 * 3. WORLD – dados do mapa
 *
 * O mapa é um único Uint8Array: a célula (x, y) fica no índice y * largura + x.
 * Isso é bem mais leve do que uma matriz de objetos e aguenta mapas grandes.
 * ========================================================================== */
class World {
  constructor(width, height) {
    this.width = width;
    this.height = height;

    this.cells = new Uint8Array(width * height);     // terreno de cada célula
    this.shade = new Int8Array(width * height);      // variação de brilho (só visual)
    this.counts = new Uint32Array(TERRAINS.length);  // quantas células de cada terreno
    this.dirty = true;                               // true = o renderer precisa redesenhar

    // Cada célula ganha um leve desvio de brilho fixo, para o mapa não ficar chapado.
    for (let i = 0; i < this.shade.length; i++) {
      this.shade[i] = Math.floor(Math.random() * 15) - 7;
    }

    this.fill(Terrain.WATER);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Lê o terreno de (x, y). O chamador deve garantir que está dentro do mapa. */
  get(x, y) {
    return this.cells[y * this.width + x];
  }

  /**
   * Muda o terreno de (x, y). É o único ponto de escrita do mapa, então ele
   * mantém as contagens e o flag `dirty` sempre corretos.
   * Retorna true se algo mudou.
   */
  set(x, y, type) {
    if (!this.inBounds(x, y)) return false;

    const index = y * this.width + x;
    const previous = this.cells[index];
    if (previous === type) return false;

    this.counts[previous]--;
    this.counts[type]++;
    this.cells[index] = type;
    this.dirty = true;
    return true;
  }

  /** Preenche o mapa inteiro com um terreno. */
  fill(type) {
    this.cells.fill(type);
    this.counts.fill(0);
    this.counts[type] = this.cells.length;
    this.dirty = true;
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
 * 4. GERAÇÃO PROCEDURAL
 *
 * Usa "ruído de valor": uma grade de números aleatórios suavemente
 * interpolados. Somando várias escalas (fbm) obtém-se relevo natural.
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

/** Substitui o conteúdo do mundo por um mapa novo (ilhas cercadas por oceano). */
function generateWorld(world, seed = Math.floor(Math.random() * 2 ** 31)) {
  const rng = createRng(seed);
  const heightNoise = createValueNoise(rng);
  const moistureNoise = createValueNoise(rng);
  const scale = 0.035; // menor = continentes maiores

  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      // Distância ao centro (0 = centro, 1 = borda): puxa as bordas para o oceano.
      const nx = (x / world.width) * 2 - 1;
      const ny = (y / world.height) * 2 - 1;
      const edge = Math.pow(Math.min(1, Math.hypot(nx, ny)), 2.5);

      const height = fbm(heightNoise, x * scale, y * scale) - edge * 0.28;
      const moisture = fbm(moistureNoise, x * scale * 1.5, y * scale * 1.5);

      // Limiares ajustados para dar ~47% de água, ~30% de grama e o resto de terra,
      // areia e montanha. Os picos mais altos das montanhas ganham neve.
      let type;
      if (height < 0.335) type = Terrain.WATER;
      else if (height < 0.355) type = Terrain.SAND;
      else if (height > 0.61) type = height > 0.67 ? Terrain.SNOW : Terrain.MOUNTAIN;
      else type = moisture > 0.43 ? Terrain.GRASS : Terrain.DIRT;

      world.set(x, y, type);
    }
  }
}


/* ==========================================================================
 * 5. HABITANTES
 *
 * Os dados ficam em arrays tipados (x[i], y[i], dir[i] descrevem o habitante
 * i), no mesmo espírito do mapa: sem um objeto por habitante, sem lixo para
 * o coletor de memória, e o custo por tick é só um laço curto.
 * ========================================================================== */

// Quatro direções: direita, baixo, esquerda, cima.
const DIR_X = [1, 0, -1, 0];
const DIR_Y = [0, 1, 0, -1];

class Inhabitants {
  constructor(world) {
    this.world = world;
    this.count = 0; // quantos estão vivos; só os índices 0..count-1 valem

    const capacity = CONFIG.maxInhabitants;
    this.x = new Uint16Array(capacity);
    this.y = new Uint16Array(capacity);
    this.dir = new Uint8Array(capacity); // direção atual (índice em DIR_X / DIR_Y)
  }

  /** Cria um habitante em (x, y). Retorna false se a população já está no teto. */
  add(x, y) {
    if (this.count >= CONFIG.maxInhabitants) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.dir[i] = randomInt(4);
    return true;
  }

  /** Remove o habitante i copiando o último para o lugar dele (custo constante). */
  remove(i) {
    const last = --this.count;
    this.x[i] = this.x[last];
    this.y[i] = this.y[last];
    this.dir[i] = this.dir[last];
  }

  /** Elimina toda a população. */
  reset() {
    this.count = 0;
  }

  /**
   * Faz nascer até `amount` habitantes em células de grama sorteadas.
   * Retorna quantos nasceram (menos que o pedido se o mapa tiver pouca grama).
   */
  spawnOnGrass(amount) {
    const { world } = this;
    let spawned = 0;

    // Número limitado de tentativas: sem grama no mapa, desiste em vez de travar.
    for (let tries = amount * 30; tries > 0 && spawned < amount && this.count < CONFIG.maxInhabitants; tries--) {
      const x = randomInt(world.width);
      const y = randomInt(world.height);
      if (world.get(x, y) === Terrain.GRASS) {
        this.add(x, y);
        spawned++;
      }
    }
    return spawned;
  }

  /** Um tick de vida: descarta quem ficou em terreno proibido, anda e, às vezes, nasce alguém. */
  step() {
    this.cullBlocked();
    this.wander();
    if (Math.random() < CONFIG.spawnChance) this.spawnOnGrass(1);
  }

  /**
   * Cada habitante dá no máximo um passo por tick. Ele tende a seguir em
   * frente e às vezes muda de rumo, o que gera trajetos mais naturais do que
   * um "tremor" totalmente aleatório. Só pisa em terreno `walkable`.
   */
  wander() {
    const { world } = this;

    for (let i = 0; i < this.count; i++) {
      if (Math.random() < CONFIG.idleChance) continue; // descansa neste tick

      let dir = this.dir[i];
      if (Math.random() > CONFIG.keepDirectionChance) dir = randomInt(4);

      const nx = this.x[i] + DIR_X[dir];
      const ny = this.y[i] + DIR_Y[dir];

      if (world.inBounds(nx, ny) && WALKABLE[world.get(nx, ny)]) {
        this.x[i] = nx;
        this.y[i] = ny;
        this.dir[i] = dir;
      } else {
        this.dir[i] = randomInt(4); // água, montanha, lava... escolhe outro rumo
      }
    }
  }

  /**
   * Remove quem está sobre um terreno em que não pode estar (por exemplo,
   * depois de o jogador pintar água ou lava embaixo dele).
   */
  cullBlocked() {
    const { world } = this;
    // De trás para frente, porque remove() traz o último habitante para o índice i.
    for (let i = this.count - 1; i >= 0; i--) {
      if (!WALKABLE[world.get(this.x[i], this.y[i])]) this.remove(i);
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
 * 6. SIMULAÇÃO
 *
 * A cada tick, sorteamos algumas células do mapa (em vez de varrer todas) e
 * aplicamos a regra do terreno de cada uma. Isso é leve mesmo em mapas
 * grandes e faz as mudanças se espalharem de forma orgânica, sem "efeito de
 * varredura" de cima para baixo. Depois do mapa, os habitantes dão o passo deles.
 * ========================================================================== */

/**
 * Reações por terreno. Cada função recebe o mundo e a posição da célula
 * sorteada e pode alterá-la (ou as vizinhas) com world.set().
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

    // Cada vizinho de grama aumenta a chance de a grama se espalhar até aqui.
    const grass = world.countNeighbors(x, y, Terrain.GRASS);
    if (grass > 0 && Math.random() < CONFIG.grassSpreadChance * grass) {
      world.set(x, y, Terrain.GRASS);
    }
  },

  // Lava: esfria ao tocar a água e queima a grama vizinha.
  [Terrain.LAVA](world, x, y) {
    // Encostou na água: esfria e vira pedra.
    if (world.countNeighbors(x, y, Terrain.WATER) > 0 && Math.random() < CONFIG.lavaCoolChance) {
      world.set(x, y, Terrain.STONE);
      return;
    }

    // Senão, o calor queima a grama vizinha, que vira terra.
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

class Simulation {
  constructor(world, inhabitants) {
    this.world = world;
    this.inhabitants = inhabitants;
    this.tickCount = 0;
    this.paused = false;
    this.ticksPerSecond = CONFIG.ticksPerSecond;
    this.accumulator = 0; // tempo (ms) que passou e ainda não virou tick
  }

  /** Executa exatamente um tick de simulação. */
  step() {
    const { world } = this;
    const samples = Math.floor(world.width * world.height * CONFIG.randomTickRatio);

    for (let i = 0; i < samples; i++) {
      const x = randomInt(world.width);
      const y = randomInt(world.height);
      const behavior = BEHAVIORS[world.get(x, y)];
      if (behavior) behavior(world, x, y);
    }

    this.inhabitants.step();
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

    // Se bateu no teto, descarta o atraso restante em vez de tentar "correr atrás".
    if (this.accumulator >= interval) this.accumulator = 0;
  }

  togglePause() {
    this.paused = !this.paused;
    this.accumulator = 0;
  }

  /** Zera o relógio do jogo. */
  resetClock() {
    this.tickCount = 0;
    this.accumulator = 0;
  }

  /** Gera um mundo novo, com população inicial na grama. */
  newWorld() {
    generateWorld(this.world);
    this.inhabitants.reset();
    this.inhabitants.spawnOnGrass(CONFIG.initialInhabitants);
    this.resetClock();
  }

  /** Deixa só oceano e sem habitantes. */
  clearWorld() {
    this.world.fill(Terrain.WATER);
    this.inhabitants.reset();
    this.resetClock();
  }
}


/* ==========================================================================
 * 7. PODERES – ações do jogador que não são "pintar terreno"
 *
 * Um poder é aplicado com um clique. Para criar outro, acrescente um item em
 * POWERS: `apply(game, x, y)` recebe o objeto `game` (world, inhabitants,
 * renderer...) e a célula clicada. A UI cria o botão e o atalho sozinha.
 * ========================================================================== */
const POWERS = [
  {
    id: 'meteor',
    name: 'Meteoro',
    key: 'm',
    color: [255, 128, 32],
    // Raios (em células) que a prévia desenha sobre o mapa: núcleo e cratera.
    previewRadii: () => [CONFIG.meteorLavaRadius, CONFIG.meteorCraterRadius],
    apply: (game, x, y) => meteorStrike(game, x, y),
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

  // Quem estava na área da explosão morre, mesmo se a borda irregular
  // poupou o terreno onde ele pisava; depois sai também quem ficou sobre uma brasa.
  inhabitants.killWithin(cx, cy, craterRadius + 1);
  inhabitants.cullBlocked();

  renderer.addBlast(cx, cy, craterRadius);
}


/* ==========================================================================
 * 8. RENDERER
 *
 * O mapa é desenhado em um canvas pequeno "de bastidores" com 1 pixel por
 * célula, e depois esticado para o canvas da tela sem suavização. Só refaz
 * os pixels quando o mundo mudou (world.dirty). Por cima do mapa vêm os
 * habitantes, o efeito das explosões e a prévia da ferramenta.
 * ========================================================================== */
class Renderer {
  constructor(canvas, world, inhabitants) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.inhabitants = inhabitants;
    this.showGrid = false;
    this.cellSize = 0;
    this.blasts = []; // explosões em andamento: { x, y, radius, start }

    this.buffer = document.createElement('canvas');
    this.buffer.width = world.width;
    this.buffer.height = world.height;
    this.bufferCtx = this.buffer.getContext('2d');
    this.imageData = this.bufferCtx.createImageData(world.width, world.height);

    this.setCellSize(CONFIG.initialCellSize);
  }

  /** Escolhe o maior tamanho de célula (inteiro) que cabe no espaço disponível. */
  fit(availableWidth, availableHeight) {
    const { world } = this;
    const size = Math.floor(Math.min(availableWidth / world.width, availableHeight / world.height));
    this.setCellSize(Math.max(CONFIG.minCellSize, size));
  }

  setCellSize(size) {
    if (size === this.cellSize) return;
    this.cellSize = size;
    // Mudar width/height limpa o canvas, mas ele é redesenhado a todo quadro.
    this.canvas.width = this.world.width * size;
    this.canvas.height = this.world.height * size;
  }

  /** Registra uma explosão para o efeito visual (a mudança no mapa é feita por quem chama). */
  addBlast(x, y, radius) {
    this.blasts.push({ x, y, radius, start: performance.now() });
  }

  /**
   * Desenha um quadro. `hover` é a célula sob o mouse (ou null), `tools` é o
   * estado das ferramentas e `now` é o horário do quadro (ms).
   */
  render(hover, tools, now) {
    const { ctx, canvas, world } = this;

    if (world.dirty) {
      this.updateBuffer();
      world.dirty = false;
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.buffer, 0, 0, canvas.width, canvas.height);

    if (this.showGrid && this.cellSize >= 4) this.drawGrid();
    this.drawInhabitants();
    this.drawBlasts(now);

    if (hover && world.inBounds(hover.x, hover.y)) {
      const power = POWERS_BY_ID[tools.power];
      if (power) this.drawPowerPreview(hover, power);
      else this.drawBrushPreview(hover, tools.brushSize);
    }
  }

  /** Converte o array de terrenos em pixels do buffer (1 pixel = 1 célula). */
  updateBuffer() {
    const { cells, shade } = this.world;
    const pixels = this.imageData.data; // Uint8ClampedArray: valores fora de 0-255 são cortados

    for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
      const c = cells[i] * 3;
      const s = shade[i];
      pixels[p] = PALETTE[c] + s;
      pixels[p + 1] = PALETTE[c + 1] + s;
      pixels[p + 2] = PALETTE[c + 2] + s;
      pixels[p + 3] = 255;
    }

    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  drawGrid() {
    const { ctx, canvas, cellSize, world } = this;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= world.width; x++) {
      ctx.moveTo(x * cellSize + 0.5, 0);
      ctx.lineTo(x * cellSize + 0.5, canvas.height);
    }
    for (let y = 0; y <= world.height; y++) {
      ctx.moveTo(0, y * cellSize + 0.5);
      ctx.lineTo(canvas.width, y * cellSize + 0.5);
    }
    ctx.stroke();
  }

  /** Cada habitante é um quadradinho branco, com contorno escuro quando há espaço. */
  drawInhabitants() {
    const { ctx, cellSize, inhabitants } = this;
    const { x, y, count } = inhabitants;
    if (count === 0) return;

    const size = Math.max(2, Math.round(cellSize * 0.6));
    const offset = Math.floor((cellSize - size) / 2);

    // Duas passadas (contorno e depois preenchimento) evitam trocar de cor a cada habitante.
    if (cellSize >= 5) {
      ctx.fillStyle = 'rgba(15, 15, 20, 0.75)';
      for (let i = 0; i < count; i++) {
        ctx.fillRect(x[i] * cellSize + offset - 1, y[i] * cellSize + offset - 1, size + 2, size + 2);
      }
    }
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < count; i++) {
      ctx.fillRect(x[i] * cellSize + offset, y[i] * cellSize + offset, size, size);
    }
  }

  /** Clarão e onda de choque das explosões; cada uma dura CONFIG.blastDurationMs. */
  drawBlasts(now) {
    if (this.blasts.length === 0) return;

    const { ctx, cellSize } = this;
    this.blasts = this.blasts.filter((blast) => now - blast.start < CONFIG.blastDurationMs);

    for (const blast of this.blasts) {
      const t = Math.max(0, (now - blast.start) / CONFIG.blastDurationMs); // 0 → 1
      const cx = (blast.x + 0.5) * cellSize;
      const cy = (blast.y + 0.5) * cellSize;
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

  /** Marca exatamente as células que o pincel vai alterar. */
  drawBrushPreview(hover, brushSize) {
    const { ctx, cellSize, world } = this;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    forEachBrushCell(hover.x, hover.y, brushSize, (x, y) => {
      if (world.inBounds(x, y)) ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    });
  }

  /** Mostra a área de um poder: cratera (círculo maior) e núcleo de lava (círculo menor). */
  drawPowerPreview(hover, power) {
    const { ctx, cellSize } = this;
    const cx = (hover.x + 0.5) * cellSize;
    const cy = (hover.y + 0.5) * cellSize;
    const [coreRadius, outerRadius] = power.previewRadii();

    const circle = (radius) => {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * cellSize, 0, Math.PI * 2);
    };

    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    circle(outerRadius);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 90, 20, 0.35)';
    circle(coreRadius);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 200, 120, 0.9)';
    ctx.lineWidth = 2;
    circle(outerRadius);
    ctx.stroke();
  }
}


/* ==========================================================================
 * 9. INPUT – pincel e poderes controlados por mouse ou toque
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
   * compartilhado com a UI: { terrain, power, brushSize }.
   */
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.world = game.world;
    this.tools = game.tools;

    this.hover = null;      // célula sob o cursor: { x, y }
    this.painting = false;
    this.paintType = 0;     // terreno que o gesto atual está pintando
    this.lastCell = null;   // última célula pintada (para ligar os pontos)

    // Pointer Events cobrem mouse, toque e caneta com o mesmo código.
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.painting) this.hover = null;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // botão direito apaga
  }

  /** Converte a posição do ponteiro na tela para coordenadas de célula. */
  cellAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor(((event.clientX - rect.left) / rect.width) * this.world.width),
      y: Math.floor(((event.clientY - rect.top) / rect.height) * this.world.height),
    };
  }

  onPointerDown(event) {
    if (event.button !== 0 && event.button !== 2) return;

    const cell = this.cellAt(event);
    this.hover = cell;

    // Botão esquerdo com um poder selecionado: um clique = um uso (não arrasta).
    const power = event.button === 0 ? POWERS_BY_ID[this.tools.power] : null;
    if (power) {
      power.apply(this.game, cell.x, cell.y);
      return;
    }

    // Com a captura, o gesto continua mesmo se o ponteiro sair do canvas.
    this.canvas.setPointerCapture(event.pointerId);

    this.painting = true;
    // O botão direito é sempre a borracha (água), qualquer que seja a ferramenta.
    this.paintType = event.button === 2 ? Terrain.WATER : this.tools.terrain;

    this.stamp(cell.x, cell.y);
    this.game.inhabitants.cullBlocked();
    this.lastCell = cell;
  }

  onPointerMove(event) {
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
    this.lastCell = null;
    if (event.pointerType !== 'mouse') this.hover = null; // no toque não há cursor pairando
  }

  /** Aplica o pincel centrado em (cx, cy). */
  stamp(cx, cy) {
    forEachBrushCell(cx, cy, this.tools.brushSize, (x, y) => {
      this.world.set(x, y, this.paintType);
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
}


/* ==========================================================================
 * 10. UI – liga o HTML ao jogo
 * ========================================================================== */
class UI {
  constructor(game) {
    this.world = game.world;
    this.inhabitants = game.inhabitants;
    this.simulation = game.simulation;
    this.renderer = game.renderer;
    this.input = game.input;
    this.tools = game.tools;

    const $ = (id) => document.getElementById(id);
    this.el = {
      toolList: $('tool-list'),
      powerList: $('power-list'),
      brushSize: $('brush-size'),
      brushSizeValue: $('brush-size-value'),
      pause: $('btn-pause'),
      step: $('btn-step'),
      speed: $('speed'),
      speedValue: $('speed-value'),
      tickCount: $('tick-count'),
      inhabitantsCount: $('inhabitants-count'),
      generate: $('btn-generate'),
      clear: $('btn-clear'),
      grid: $('toggle-grid'),
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
    this.refreshPauseState();
    this.updateStats();
  }

  /* ---- construção dos elementos gerados a partir das listas TERRAINS e POWERS ---- */

  buildToolButtons() {
    this.terrainButtons = TERRAINS.map((terrain, index) => {
      const button = this.createToolButton({
        name: terrain.name,
        color: terrain.color,
        title: `${terrain.name} (tecla ${index + 1})`,
      }, () => this.selectTerrain(terrain.id));
      this.el.toolList.appendChild(button);
      return button;
    });

    this.powerButtons = POWERS.map((power) => {
      const key = power.key.toUpperCase();
      const button = this.createToolButton({
        name: power.name,
        color: power.color,
        title: `${power.name} (tecla ${key})`,
        key,
      }, () => this.selectPower(power.id));
      button.classList.add('tool--power');
      this.el.powerList.appendChild(button);
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

    el.generate.addEventListener('click', () => this.simulation.newWorld());
    el.clear.addEventListener('click', () => this.simulation.clearWorld());

    // Roda do mouse sobre o mapa muda o tamanho do pincel.
    this.renderer.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.setBrushSize(this.tools.brushSize + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
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

      // Cada poder tem a sua tecla (M = Meteoro).
      const power = POWERS.find((candidate) => candidate.key === key);
      if (power) {
        this.selectPower(power.id);
        return;
      }

      switch (key) {
        case ' ':
          event.preventDefault();
          // Tira o foco de botões/checkbox para o espaço não "clicá-los" também.
          if (document.activeElement) document.activeElement.blur();
          this.togglePause();
          break;
        case 'n': this.stepOnce(); break;
        case 'g': this.el.grid.click(); break;
        case '+':
        case '=': this.setBrushSize(this.tools.brushSize + 1); break;
        case '-': this.setBrushSize(this.tools.brushSize - 1); break;
      }
    });
  }

  /* ---- ações ---- */

  selectTerrain(id) {
    this.tools.terrain = id;
    this.tools.power = null; // voltar a escolher um terreno desativa o poder
    this.refreshTools();
  }

  selectPower(id) {
    this.tools.power = id;
    this.refreshTools();
  }

  /** Sincroniza botões, cor de acento e slider com a ferramenta atual. */
  refreshTools() {
    const { terrain, power } = this.tools;

    this.terrainButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(!power && index === terrain));
    });
    this.powerButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(POWERS[index].id === power));
    });

    // O acento da interface assume a cor da ferramenta escolhida (ver style.css).
    const color = power ? POWERS_BY_ID[power].color : TERRAINS[terrain].color;
    document.documentElement.style.setProperty('--brush', toCssColor(color));

    // Poderes têm tamanho fixo, então o slider do pincel fica desativado.
    this.el.brushSize.disabled = Boolean(power);
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
    // Contadores: só mexem no DOM quando o valor muda.
    if (this.simulation.tickCount !== this.lastTick) {
      this.lastTick = this.simulation.tickCount;
      this.el.tickCount.textContent = this.lastTick.toLocaleString('pt-BR');
    }
    if (this.inhabitants.count !== this.lastPopulation) {
      this.lastPopulation = this.inhabitants.count;
      this.el.inhabitantsCount.textContent = this.lastPopulation.toLocaleString('pt-BR');
    }

    this.updateHoverInfo();

    // Composição do mapa: throttled, não precisa ser em tempo real.
    if (now - this.lastStatsTime >= CONFIG.statsIntervalMs) {
      this.lastStatsTime = now;
      this.updateStats();
    }
  }

  updateHoverInfo() {
    const { hover } = this.input;
    const text = hover && this.world.inBounds(hover.x, hover.y)
      ? `${TERRAINS[this.world.get(hover.x, hover.y)].name} em x ${hover.x}, y ${hover.y}`
      : 'Passe o mouse sobre o mapa';

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
}


/* ==========================================================================
 * 11. BOOT – monta as peças e liga o game loop
 * ========================================================================== */
function boot() {
  const canvas = document.getElementById('world-canvas');
  const stage = document.getElementById('stage');

  const world = new World(CONFIG.gridWidth, CONFIG.gridHeight);
  const inhabitants = new Inhabitants(world);
  const simulation = new Simulation(world, inhabitants);
  const renderer = new Renderer(canvas, world, inhabitants);

  // Estado das ferramentas, compartilhado entre a UI (que muda) e o Input (que lê).
  // `power` é null quando o clique pinta terreno, ou o id de um poder (ex.: 'meteor').
  const tools = { terrain: Terrain.GRASS, power: null, brushSize: CONFIG.brushSize };

  // Objeto que reúne as peças; é o que os poderes recebem e o que fica no console.
  const game = { world, inhabitants, simulation, renderer, tools };
  game.input = new Input(canvas, game);
  const ui = new UI(game);

  simulation.newWorld();

  // Ajusta o tamanho das células sempre que o palco muda de tamanho.
  new ResizeObserver(([entry]) => {
    renderer.fit(entry.contentRect.width, entry.contentRect.height);
  }).observe(stage);

  /* ---- GAME LOOP ----
   * requestAnimationFrame chama `frame` antes de cada quadro da tela.
   * 1) update: a simulação avança quantos ticks o tempo decorrido pedir;
   * 2) render: desenha o estado atual;
   * 3) ui: atualiza textos e números.
   */
  let lastTime = performance.now();
  function frame(now) {
    // Limita o delta: se a aba ficou em segundo plano, não "recupera" minutos de ticks.
    const delta = Math.min(Math.max(now - lastTime, 0), 250);
    lastTime = now;

    simulation.update(delta);
    renderer.render(game.input.hover, tools, now);
    ui.update(now);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Atalho para experimentar pelo console do navegador.
  window.game = Object.assign(game, { CONFIG, Terrain, TERRAINS, POWERS, generateWorld, meteorStrike });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
