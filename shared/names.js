// Deterministic callsigns (user: radio-transcript event log + reticle
// nameplates, with ranks PROPORTIONED like a real small-ship complement).
// Names are a PURE function of (run seed, agent id) — no sim RNG stream is
// consumed, so replay hashes and cross-seed divergence are untouched.
// RANKS are assigned structurally by the sim (sim._assignRanks): one CDR on
// the bridge, a couple of junior officers, an enlisted pyramid for the
// ratings, one Sgt leading each marine squad (squad 1 carries the platoon's
// 2ndLt), Cpl-led patrol pairs, a GySgt-led ODST reserve. Conversions
// mutate the same agent record, so a combat form keeps its host's callsign.

const SURNAMES = [
  'Jenkins', 'Vance', 'Okafor', 'Reyes', 'Kowalski', 'Tanaka', 'Brahe',
  'Mendez', 'Holt', 'Adebayo', 'Silva', 'Novak', 'Kessler', 'Duarte',
  'Lindqvist', 'Ochoa', 'Petrov', 'Kimathi', 'Farrell', 'Yoon', 'Castillo',
  'Marek', 'Osei', 'Bishop', 'Devereaux', 'Nakamura', 'Sorensen', 'Ferro',
  'Ambrose', 'Calloway', 'Diaz', 'Eriksen', 'Ganda', 'Haddad', 'Ivanov',
  'Jarrah', 'Kaminski', 'Laghari', 'Moreau', 'Nwosu', 'Oduya', 'Pryce',
  'Quan', 'Rousseau', 'Santiago', 'Thorne', 'Ulrich', 'Vasquez', 'Whitaker',
  'Xiang', 'Yaeger', 'Zubair', 'Ashworth', 'Boateng', 'Crowe', 'Delacroix',
  'Emerson', 'Fontaine', 'Grigoryan', 'Huang', 'Iwu', 'Jansen', 'Katsaros',
  'Lombardi', 'Mbeki', 'Nazari', 'Olsen', 'Paredes', 'Quinlan', 'Rahal',
  'Sandoval', 'Takeda', 'Umarov', 'Villanueva', 'Wren', 'Yamada', 'Zielinski',
  'Abara', 'Beckett', 'Cardoso', 'Dietrich', 'Espinoza', 'Fischer', 'Guerra',
  'Halloran', 'Ito', 'Joshi', 'Kaur', 'Lachance', 'Mattias', 'Ngata',
  'Oyelaran', 'Pavic', 'Rios', 'Sturm', 'Tremblay', 'Ueda',
];

// enlisted pyramids — heavy at the bottom, thin at the top, matching a
// ~200-soul complement (a handful of chiefs, no inflation of seniors)
export const RANK_POOLS = {
  // naval ratings (most of the crew are support and ops): ~60% junior
  // crewmen, a technician layer, thin petty-officer tiers, a bare handful
  // of chiefs across the whole complement
  crew: [
    ...Array(30).fill('Crewman'), ...Array(10).fill('Tech'),
    ...Array(5).fill('PO3'), ...Array(3).fill('PO2'), 'PO1', 'Chief',
  ],
  // masters-at-arms (the armed watch) — mostly juniors, one senior per shift
  armed: ['MA3', 'MA3', 'MA3', 'MA3', 'MA2', 'MA2', 'MA1'],
  // marine riflemen below the leadership billets
  marine: ['Pvt', 'Pvt', 'Pvt', 'PFC', 'PFC', 'LCpl'],
  // ODST troopers below the squad lead
  odst: ['Cpl', 'Cpl', 'Sgt'],
};

function hash32(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function nameFor(seed, id) {
  const h = hash32(`${seed}:${id}`);
  const initial = String.fromCharCode(65 + ((h >>> 16) % 26));
  return `${initial}. ${SURNAMES[h % SURNAMES.length]}`;
}

// deterministic pyramid pick — same (seed, id) always lands on the same rung
export function rankFromPool(seed, id, pool) {
  return pool[hash32(`${seed}:rank:${id}`) % pool.length];
}
