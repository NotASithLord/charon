// Deterministic callsigns (user: radio-transcript event log + reticle
// nameplates). Every human aboard gets a rank + name that is a PURE
// function of (run seed, agent id) — no sim RNG stream is consumed, so
// replay hashes and cross-seed divergence are completely untouched.
// Conversions mutate the same agent record, so a combat form keeps the
// callsign of the marine it used to be.

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

// rank pools weighted by repetition — juniors are common, seniors rare
const RANKS = {
  marine: ['Pvt', 'Pvt', 'Pvt', 'PFC', 'PFC', 'LCpl', 'Cpl', 'Sgt'],
  odst: ['LCpl', 'Cpl', 'Cpl', 'Sgt', 'SSgt', 'GySgt'],
  armed: ['MA3', 'MA2', 'MA2', 'MA1', 'PO2', 'PO1'],       // masters-at-arms / petty officers
  crew: ['Crewman', 'Crewman', 'Crewman', 'Tech', 'Tech', 'PO3', 'PO2', 'Chief'],
};

function hash32(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // final avalanche so nearby ids don't pick nearby names
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function callsignFor(seed, id, kind) {
  const h = hash32(`${seed}:${id}`);
  const ranks = RANKS[kind] ?? RANKS.crew;
  const initial = String.fromCharCode(65 + ((h >>> 16) % 26));
  return {
    rank: ranks[(h >>> 8) % ranks.length],
    name: `${initial}. ${SURNAMES[h % SURNAMES.length]}`,
  };
}
