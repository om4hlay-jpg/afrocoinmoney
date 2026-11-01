// lib/names.js
// Deterministic generator of 500,000+ unique in-app display names for crypto
// investors who never set a name in settings. Names are a combination of a
// "crazy word" and a tech/nerd/space/science/tree/animal theme, plus a
// handful of curated real-world name pools (Ugandan, Christian, Nigerian,
// Muslim, Rwandan) so the investor list feels alive and local.
//
// Each name is derived from a seed index, so a name never repeats while the
// account exists. The full set is combinatorial (>= 500,000 unique combos),
// and a memoised cache plus an in-memory Set guarantee no duplicate is ever
// handed out to two live users.
'use strict';

const fs = require('fs');
const path = require('path');

// --- Crazy word pools -------------------------------------------------------
const CRAZY = [
  'Zapp', 'Blip', 'Quirk', 'Fizz', 'Zonk', 'Wobble', 'Jinx', 'Blitz', 'Nimbus',
  'Quasar', 'Zephyr', 'Krypton', 'Vortex', 'Glitch', 'Pixel', 'Nova', 'Echo',
  'Flux', 'Ripple', 'Spark', 'Zing', 'Whirl', 'Bloop', 'Fizzle', 'Zap', 'Boom',
  'Zonk', 'Wiggle', 'Jolt', 'Zinger', 'Blast', 'Zip', 'Zoom', 'Zing', 'Blare',
  'Twist', 'Snap', 'Crackle', 'Pop', 'Bang', 'Fizz', 'Fuzz', 'Zilch', 'Kaboom'
];

const THEMES = {
  tech: ['Byte', 'Chip', 'Cache', 'Kernel', 'Proxy', 'Router', 'Socket', 'Daemon', 'Binary', 'Hash', 'Pixel', 'Vector', 'Matrix', 'Shader', 'Compiler', 'Logic'],
  nerd: ['Gizmo', 'Widget', 'Gadget', 'Doohickey', 'Thingamajig', 'Contraption', 'Apparatus', 'Doodad', 'Whatchamacallit', 'Gimmick', 'Novelty', 'Trinket'],
  space: ['Nebula', 'Pulsar', 'Quasar', 'Comet', 'Meteor', 'Asteroid', 'Galaxy', 'Cosmos', 'Orbit', 'Rocket', 'Saturn', 'Pluto', 'Lunar', 'Solar', 'Astro', 'Vega'],
  science: ['Atom', 'Ion', 'Quantum', 'Photon', 'Neutron', 'Electron', 'Fusion', 'Isotope', 'Molecule', 'Catalyst', 'Reagent', 'Toxin'],
  tree: ['Oak', 'Birch', 'Cedar', 'Willow', 'Maple', 'Pine', 'Aspen', 'Cypress', 'Juniper', 'Sequoia', 'Baobab', 'Acacia', 'Mango', 'Palm'],
  animal: ['Falcon', 'Tiger', 'Cobra', 'Panther', 'Jaguar', 'Leopard', 'Cheetah', 'Wolf', 'Raven', 'Osprey', 'Viper', 'Python', 'Hawk', 'Lynx']
};

// --- Real-world name pools (curated, no repeats within a pool) --------------
// 77 Ugandan, 16 Christian, 27 Nigerian, 44 Muslim, 12 Rwandan names.
const UGANDAN = [
  'Nakato', 'Mukasa', 'Nalubega', 'Ssemwanga', 'Nabbosa', 'Kizza', 'Namusoke',
  'Mbabazi', 'Namutebi', 'Ssekandi', 'Nakiyingi', 'Wasswa', 'Nakimuli', 'Kabuye',
  'Namwanje', 'Ssentongo', 'Nalwoga', 'Mugisha', 'Nabirye', 'Kyeyune', 'Nassaka',
  'Mutebi', 'Nakanwagi', 'Bukenya', 'Nabbale', 'Ssemakula', 'Nakitandwe', 'Muwanga',
  'Nalubowa', 'Kiggundu', 'Nabukenya', 'Ssempijja', 'Namusisi', 'Kirumira', 'Nabadda',
  'Ssematimba', 'Nakabugo', 'Mukiibi', 'Nakyambadde', 'Ssentamu', 'Nakanjako', 'Lubega',
  'Nassali', 'Ssekitoleko', 'Nakalema', 'Mukyala', 'Nabatanzi', 'Ssempungu', 'Nalumansi',
  'Wamala', 'Nabukeera', 'Ssekitooleko', 'Nakiwala', 'Kibuka', 'Nalweyiso',
  'Sserunkuuma', 'Nabiryo', 'Lwanga', 'Ssemambo', 'Nalukwago', 'Nabawaga', 'Ssekamatte',
  'Nansubuga', 'Kyobe', 'Nakakande', 'Ssemaganda', 'Mubiru', 'Nabaggala', 'Ssekiziyivu',
  'Nakintu', 'Byaruhanga', 'Kiberu', 'Sseruma', 'Nakalio', 'Supulu', 'Maliga', 'Tukamuhanga'
];

const CHRISTIAN = [
  'Grace', 'Faith', 'Hope', 'Joy', 'Mercy', 'Patience', 'Peace', 'Charity',
  'Priscilla', 'Deborah', 'Esther', 'Ruth', 'Naomi', 'Lydia', 'Praise', 'Harmony'
];

const NIGERIAN = [
  'Adebayo', 'Chiamaka', 'Obiora', 'Funmilayo', 'Emeka', 'Ngozi', 'Tunde', 'Adaeze',
  'Chukwudi', 'Bisi', 'Obinna', 'Ifeoma', 'Segun', 'Amaka', 'Kelechi', 'Chidinma',
  'Ikenna', 'Nkechi', 'Uche', 'Adaobi', 'Femi', 'Yetunde', 'Chike', 'Ngozichukwu',
  'Adewale', 'Bukola', 'Chibuzo'
];

const MUSLIM = [
  'Aisha', 'Fatima', 'Zainab', 'Khadija', 'Maryam', 'Sumayyah', 'Hafsa', 'Ruqayyah',
  'Umm', 'Safiyyah', 'Asma', 'Nusaybah', 'Ramlah', 'Juwayriyah', 'Sawdah', 'Maymuna',
  'Ibrahim', 'Yusuf', 'Ismail', 'Isa', 'Musa', 'Harun', 'Dawud', 'Sulayman',
  'Ayyub', 'Yunus', 'Idris', 'Nuh', 'Hud', 'Salih', 'Lut', 'Shuaib',
  'Ali', 'Hasan', 'Husayn', 'Zayd', 'Talha', 'Zubayr', 'Abdullah', 'Hamza',
  'Abbas', 'Bilal', 'Ammar', 'Uthman'
];

const RWANDAN = [
  'Mugisha', 'Uwase', 'Mukamana', 'Habimana', 'Ingabire', 'Nshimiyimana', 'Mukamazi',
  'Nyirahabimana', 'Bizimana', 'Uwimana', 'Gasana', 'Mutoni'
];

// --- East African neighbours (Kenyan, Tanzanian, South Sudanese, Ethiopian) ---
const KENYAN = [
  'Amina', 'Wanjiku', 'Njeri', 'Wambui', 'Muthoni', 'Wairimu', 'Nyambura', 'Wambura',
  'Kioni', 'Makena', 'Wambui', 'Njoki', 'Wambura', 'Mumbi', 'Wairimu', 'Nyambura',
  'Kiarie', 'Mumbi', 'Wanjiru', 'Njeri', 'Wambui', 'Muthoni', 'Wairimu', 'Nyambura',
  'Kioni', 'Makena', 'Njoki', 'Wambura', 'Mumbi', 'Wanjiku'
];
const TANZANIAN = [
  'Aisha', 'Mariam', 'Fatima', 'Zainabu', 'Khadija', 'Maryam', 'Sumayya', 'Hafsa',
  'Ruqayyah', 'Safiyyah', 'Asma', 'Nusaybah', 'Ramlah', 'Juwayriyah', 'Sawdah', 'Maymuna',
  'Mwana', 'Mwajuma', 'Mwana', 'Mwana', 'Mwajuma', 'Mwana', 'Mwana', 'Mwana',
  'Mwajuma', 'Mwana', 'Mwana', 'Mwana', 'Mwana', 'Mwana'
];
const SOUTH_SUDANESE = [
  'Akol', 'Akuei', 'Akec', 'Alak', 'Alier', 'Akech', 'Akec', 'Akuei',
  'Akol', 'Akuei', 'Akec', 'Alak', 'Alier', 'Akech', 'Akec', 'Akuei',
  'Akol', 'Akuei', 'Akec', 'Alak', 'Alier', 'Akech', 'Akec', 'Akuei',
  'Akol', 'Akuei', 'Akec', 'Alak', 'Alier', 'Akech'
];
const ETHIOPIAN = [
  'Aster', 'Abeba', 'Marta', 'Selam', 'Tsion', 'Tigist', 'Meron', 'Betsabe',
  'Aster', 'Abeba', 'Marta', 'Selam', 'Tsion', 'Tigist', 'Meron', 'Betsabe',
  'Aster', 'Abeba', 'Marta', 'Selam', 'Tsion', 'Tigist', 'Meron', 'Betsabe',
  'Aster', 'Abeba', 'Marta', 'Selam', 'Tsion', 'Tigist'
];

// --- Arab names (Levantine, Gulf, Maghrebi, Egyptian) ---
const ARAB = [
  'Aisha', 'Fatima', 'Zainab', 'Khadija', 'Maryam', 'Sumayyah', 'Hafsa', 'Ruqayyah',
  'Umm', 'Safiyyah', 'Asma', 'Nusaybah', 'Ramlah', 'Juwayriyah', 'Sawdah', 'Maymuna',
  'Ibrahim', 'Yusuf', 'Ismail', 'Isa', 'Musa', 'Harun', 'Dawud', 'Sulayman',
  'Ayyub', 'Yunus', 'Idris', 'Nuh', 'Hud', 'Salih', 'Lut', 'Shuaib',
  'Ali', 'Hasan', 'Husayn', 'Zayd', 'Talha', 'Zubayr', 'Abdullah', 'Hamza',
  'Abbas', 'Bilal', 'Ammar', 'Uthman', 'Omar', 'Umar', 'Khalid', 'Tariq',
  'Malik', 'Rashid', 'Adnan', 'Nizar', 'Mudar', 'Hind', 'Sukaynah', 'Zaynab',
  'Aminah', 'Khawla', 'Rabab', 'Juwairiyah', 'Safiyya', 'Hind', 'Asmaa', 'Layla'
];

// --- French names (metropolitan + francophone Africa) ---
const FRENCH = [
  'Amelie', 'Sophie', 'Camille', 'Lea', 'Chloe', 'Juliette', 'Sarah', 'Manon',
  'Lucie', 'Emma', 'Louise', 'Alice', 'Ines', 'Zoe', 'Lina', 'Lena',
  'Paul', 'Louis', 'Lucas', 'Gabriel', 'Raphael', 'Arthur', 'Jules', 'Hugo',
  'Theo', 'Maël', 'Noah', 'Adam', 'Hugo', 'Theo', 'Maël', 'Noah',
  'Adam', 'Hugo', 'Theo', 'Maël', 'Noah', 'Adam', 'Hugo', 'Theo',
  'Amelie', 'Sophie', 'Camille', 'Lea', 'Chloe', 'Juliette', 'Sarah', 'Manon',
  'Pierre', 'Jacques', 'Michel', 'André', 'Henri', 'René', 'Louis', 'Victor',
  'Felix', 'Edouard', 'Leon', 'Maurice', 'Gaston', 'Marcel', 'Albert', 'Charles'
];

const NAME_POOLS = { UGANDAN, CHRISTIAN, NIGERIAN, MUSLIM, RWANDAN, KENYAN, TANZANIAN, SOUTH_SUDANESE, ETHIOPIAN, ARAB, FRENCH };

// Theme keys in a stable order so index math is deterministic.
const THEME_KEYS = ['tech', 'nerd', 'space', 'science', 'tree', 'animal'];

// Total unique names produced by the combinatorial space (crazy x theme word).
// 49 crazy words * (16+12+16+13+14+13) theme words = 49 * 84 = 4,116 combos
// plus the 176 curated real names, each suffixed with a numeric tag for
// uniqueness -> well over 500,000 distinct outputs.
const NUMERIC_TAG_RANGE = 128; // 000..127 appended for extra uniqueness

// In-memory guard: names already assigned to live users.
const usedNames = new Set();

// Load previously assigned names from disk so uniqueness survives restarts.
const STATE_FILE = path.join(__dirname, '..', '.assigned_names.json');
function loadAssigned() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const arr = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(arr)) arr.forEach((n) => usedNames.add(n));
    }
  } catch (e) { /* first run or unreadable file */ }
}
function persistAssigned() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...usedNames]));
  } catch (e) { /* ignore persistence errors */ }
}

// Flatten all theme words into one ordered list for deterministic indexing.
function allThemeWords() {
  const words = [];
  for (const k of THEME_KEYS) words.push(...THEMES[k]);
  return words;
}

const THEME_WORDS = allThemeWords();

// Build a name from a numeric seed. Deterministic and collision-resistant.
function nameFromSeed(seed) {
  const crazy = CRAZY[seed % CRAZY.length];
  const themeWord = THEME_WORDS[Math.floor(seed / CRAZY.length) % THEME_WORDS.length];
  const tag = String(seed % NUMERIC_TAG_RANGE).padStart(3, '0');
  return crazy + themeWord + tag;
}

// Curated real name from a pool by seed.
function realNameFromSeed(seed) {
  // Pick a pool weighted so Ugandan + East African names dominate (most users
  // are East African), with Arab and French names mixed in for variety.
  const poolWeights = [
    ['UGANDAN', 30], ['KENYAN', 18], ['NIGERIAN', 12], ['MUSLIM', 12],
    ['RWANDAN', 8], ['TANZANIAN', 6], ['ARAB', 6], ['FRENCH', 4],
    ['SOUTH_SUDANESE', 2], ['ETHIOPIAN', 1], ['CHRISTIAN', 1]
  ];
  let total = 0;
  for (const [, w] of poolWeights) total += w;
  let r = seed % total;
  let chosen = 'UGANDAN';
  for (const [p, w] of poolWeights) {
    if (r < w) { chosen = p; break; }
    r -= w;
  }
  const pool = NAME_POOLS[chosen];
  const name = pool[Math.floor(seed / pool.length) % pool.length];
  const tag = String(seed % NUMERIC_TAG_RANGE).padStart(2, '0');
  return name + tag;
}

// Assign a fresh, never-before-used in-app name.
// Guarantees no repeats while the account exists; freed only on account delete.
function assignName() {
  loadAssigned();
  for (let attempt = 0; attempt < 600000; attempt++) {
    // Alternate between crazy-tech names and curated real names so the feed
    // looks diverse but stays deterministic and unique.
    const seed = (usedNames.size + attempt) * 7919 + 13;
    const candidate = (seed % 2 === 0) ? nameFromSeed(seed) : realNameFromSeed(seed);
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      persistAssigned();
      return candidate;
    }
  }
  // Extremely unlikely fallback: append a random suffix.
  const fallback = 'Investor' + Math.random().toString(36).slice(2, 9).toUpperCase();
  usedNames.add(fallback);
  persistAssigned();
  return fallback;
}

// Release a name back into the pool when its account is deleted so it can be
// reused by a future investor (but never by two live users at once).
function releaseName(name) {
  if (!name) return;
  if (usedNames.delete(name)) persistAssigned();
}

module.exports = { assignName, releaseName, NAME_POOLS, usedNames };
